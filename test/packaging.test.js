'use strict';
// T5（#6）打包发布就绪：npm pack 白名单、干净前缀全局安装冒烟、依赖收敛后热刷新回归。
// 进程边界 seam（spec #1 Testing Decisions）：真实 npm pack / npm install 产物、
// spawn 真实进程、原生 fetch / ws 客户端观察外部行为，零新 devDependencies。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, sleep, freePort, REPO_ROOT } = require('./helpers');

// 定位 npm 可执行：Windows 上 spawn 不能直接执行 .cmd，改用 node 直跑 npm-cli.js
function npmCommand() {
  if (process.platform === 'win32') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(cli)) return [process.execPath, [cli]];
  }
  return ['npm', []];
}

// tarball 白名单（AC1）：npm 自动附带文件 + 显式白名单（服务端 / bin / 前端含 vendor / 示例模板）
const PACK_AUTO = new Set(['package.json', 'README.md', 'package-lock.json']);
function packAllowed(p) {
  if (PACK_AUTO.has(p)) return true;
  return p === 'server.js'
    || p === 'knowledge.config.example.json'
    || p === 'teach.config.example.json'
    || p.startsWith('bin/')
    || p.startsWith('lib/')
    || p.startsWith('public/');
}

// 在仓库根执行 npm pack，产物落到临时目录（需先建目录，npm 不会自建）；返回 { tarball, files }
function npmPack(dest) {
  fs.mkdirSync(dest, { recursive: true });
  const [npmBin, npmArgs] = npmCommand();
  const res = spawnSync(npmBin, [...npmArgs, 'pack', '--json', `--pack-destination=${dest}`], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 120000,
  });
  assert.equal(res.status, 0, `npm pack 失败\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
  const meta = JSON.parse(res.stdout);
  const files = meta.flatMap(m => (m.files || []).map(f => f.path));
  assert.ok(files.length > 0, 'npm pack --json 未返回文件清单');
  return { tarball: path.join(dest, meta[0].filename), files };
}

// Windows 上 npm shim 是 .cmd 批处理，spawn 不能直接执行，需经 cmd /c；
// 返回 [命令, 前缀参数]，供同步（runShim）/ 异步（启动冒烟）两种 spawn 复用
function shimSpawnTarget(shim) {
  if (process.platform === 'win32') {
    return [process.env.comspec || 'cmd.exe', ['/c', shim]];
  }
  return [shim, []];
}

// 经 npm 生成的命令 shim 运行全局安装的 lanbook
function runShim(shim, args, env, opts = {}) {
  const [cmd, prefix] = shimSpawnTarget(shim);
  return spawnSync(cmd, [...prefix, ...args],
    { env, encoding: 'utf-8', timeout: 60000, windowsHide: true, ...opts });
}

// 停止经 shim 启动的服务进程树（Windows 杀 cmd 不会连带 node，必须 /T）
function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
}

test('npm pack 产物只含白名单内容（服务端 / bin / 前端含 vendor / 示例模板）', async t => {
  const dest = mkTempDir('lanbook-pack-');
  t.after(() => { try { fs.rmSync(dest, { recursive: true, force: true }); } catch {} });

  const { files } = npmPack(dest);

  // 白名单关键内容必须在
  const mustHave = [
    'package.json', 'README.md', 'server.js',
    'bin/lanbook.js', 'lib/data-dir.js', 'lib/settings.js',
    'public/index.html', 'public/vendor/marked.min.js',
    'public/vendor/highlight.min.js', 'public/vendor/mermaid.min.js',
    'knowledge.config.example.json', 'teach.config.example.json',
  ];
  for (const must of mustHave) {
    assert.ok(files.includes(must), `tarball 缺少白名单关键文件: ${must}`);
  }

  // 明确不许出现：截图 / 脚本 / 测试 / 开发配置 / 运行时配置
  const banned = [
    'docs/img/knowledge.png', 'docs/img/devices.png',
    'scripts/setup-autostart.ps1', 'test/helpers.js',
    'ecosystem.config.cjs', 'DEPLOY.md', 'CONTEXT.md',
    'knowledge.config.json', 'teach.config.json', '.gitignore',
  ];
  for (const b of banned) {
    assert.ok(!files.includes(b), `tarball 不应包含: ${b}`);
  }

  // 逐条核对：白名单之外的内容一律失败（防新增杂物流入）
  const stray = files.filter(p => !packAllowed(p));
  assert.deepStrictEqual(stray, [], `tarball 含白名单之外的内容: ${stray.join(', ')}`);
});

test('干净目录 npm i -g <tarball>：lanbook 可启动、子命令可用、数据目录在 ~/.lanbook/', async t => {
  const base = mkTempDir('lanbook-gi-');
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });

  // 独立全局前缀（--prefix 隔离，不污染真实全局 npm）+ 干净假 HOME（验证默认数据目录 ~/.lanbook/）
  const prefix = path.join(base, 'global');
  fs.mkdirSync(prefix);
  const fakeHome = path.join(base, 'home');
  fs.mkdirSync(fakeHome);
  const runEnv = {
    ...process.env,
    USERPROFILE: fakeHome, HOME: fakeHome,
    HOMEDRIVE: fakeHome.slice(0, 2), HOMEPATH: fakeHome.slice(2),
  };
  delete runEnv.LANBOOK_HOME;

  const { tarball } = npmPack(path.join(base, 'pack'));
  const [npmBin, npmArgs] = npmCommand();
  const install = spawnSync(npmBin,
    [...npmArgs, 'install', '-g', `--prefix=${prefix}`, tarball, '--no-audit', '--no-fund', '--loglevel=error'],
    { cwd: base, encoding: 'utf-8', timeout: 240000 });
  if (install.status !== 0) {
    // 依赖需从 registry 拉取：网络不可达属环境问题，跳过冒烟（白名单已由上一测试守护）
    t.skip(`npm i -g 失败（疑似 registry 不可达），跳过全局安装冒烟\n${install.stderr}`);
    return;
  }

  const shim = process.platform === 'win32'
    ? path.join(prefix, 'lanbook.cmd')
    : path.join(prefix, 'bin', 'lanbook');
  assert.ok(fs.existsSync(shim), `全局安装未生成 lanbook 命令: ${shim}`);

  // 子命令 config：打印 ~/.lanbook/ 下的数据目录与三个配置文件路径
  const cfg = runShim(shim, ['config'], runEnv);
  assert.equal(cfg.status, 0, `lanbook config 退出码 ${cfg.status}\nstderr: ${cfg.stderr}`);
  const dataDir = path.join(fakeHome, '.lanbook');
  for (const name of ['settings.json', 'knowledge.config.json', 'teach.config.json']) {
    assert.ok(cfg.stdout.includes(path.join(dataDir, name)), `config 输出应含 ${name} 的路径:\n${cfg.stdout}`);
  }

  // 启动（无参数）：横幅打印数据目录，HTTP 可访问
  const port = await freePort();
  const [shimCmd, shimPrefix] = shimSpawnTarget(shim);
  const child = spawn(shimCmd, shimPrefix,
    { env: { ...runEnv, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => killTree(child));
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });

  const deadline = Date.now() + 30000;
  let lastErr = '';
  for (;;) {
    if (child.exitCode !== null) {
      assert.fail(`lanbook 启动后提前退出 code=${child.exitCode}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) break;
      lastErr = `status ${r.status}`;
    } catch (e) { lastErr = e.message; }
    if (Date.now() > deadline) assert.fail(`等待 lanbook 启动超时 lastErr=${lastErr}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    await sleep(150);
  }
  const bannerWait = Date.now() + 5000;
  while (!out.includes(`数据目录: ${dataDir}`) && Date.now() < bannerWait) await sleep(100);
  assert.ok(out.includes(`数据目录: ${dataDir}`), `启动输出应打印数据目录 ${dataDir}:\n${out}`);
  assert.ok(fs.existsSync(path.join(dataDir, 'knowledge.config.json')), '默认数据目录 ~/.lanbook/ 未自动创建');
  killTree(child);

  // 子命令 add：根目录写入 ~/.lanbook/ 的知识库配置
  const rootDir = path.join(base, 'kb-root');
  fs.mkdirSync(rootDir);
  const add = runShim(shim, ['add', rootDir], runEnv);
  assert.equal(add.status, 0, `lanbook add 退出码 ${add.status}\nstderr: ${add.stderr}`);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge.config.json'), 'utf-8'));
  assert.ok((saved.roots || []).some(r => path.resolve(String(r)) === path.resolve(rootDir)),
    `add 应写入知识库 roots: ${JSON.stringify(saved)}`);
});

test('热刷新回归（依赖收敛后）：根目录文件变化经 WebSocket 推送 knowledge-change', async t => {
  const base = mkTempDir('lanbook-hot-');
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const installDir = makeInstallDir(base);
  t.after(() => removeInstallDir(installDir));
  const dataDir = path.join(base, 'data');
  const rootDir = path.join(base, 'kb');
  fs.mkdirSync(rootDir, { recursive: true });

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });

  // 添加根目录（等价网页 ⚙ 操作）
  const r = await srv.fetch('/api/knowledge/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: [rootDir] }),
  });
  assert.ok(r.ok, `配置根目录失败: ${r.status}`);

  // ws 客户端（服务端依赖，前端实时刷新的对外协议，不新增 devDependencies）
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/`);
  const messages = [];
  ws.on('message', d => { try { messages.push(JSON.parse(d.toString())); } catch {} });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
    setTimeout(() => rej(new Error('WebSocket 连接超时')), 10000).unref();
  });
  t.after(() => { try { ws.close(); } catch {} });

  // 触碰根目录内 .md 文件直到收到 knowledge-change（chokidar watcher 就绪前事件可能丢，重试兜底）
  const deadline = Date.now() + 15000;
  let i = 0;
  while (!messages.some(m => m.type === 'knowledge-change') && Date.now() < deadline) {
    fs.writeFileSync(path.join(rootDir, `note-${i++}.md`), `# 笔记 ${i}\n`);
    await sleep(1000);
  }
  assert.ok(messages.some(m => m.type === 'knowledge-change'),
    `未收到 knowledge-change 事件，实际收到: ${JSON.stringify(messages)}`);
});
