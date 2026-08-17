'use strict';
// Ticket #5（lanbook T4 · CLI 入口）进程边界测试
// 覆盖验收标准：无参数启动 stdout 与服务端一致、add 写入两类 roots、add 报错、
// config 打印三个配置路径、open 未运行时后台启动（断言端口可访问）。
// 全部 spawn bin/lanbook.js 真实进程（AC：子命令测试走进程边界）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, sleep, freePort } = require('./helpers');

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf-8'));

// 按端口找到监听进程并终止（清理 open 拉起的后台服务）。
// 遵循全局规则：终止前验明身份（映像名必须是 node），不凭猜测杀。
async function killNodeServerByPort(port) {
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout || '';
    const pids = new Set();
    for (const line of out.split('\n')) {
      if (/\sLISTENING\s/.test(line) && new RegExp(`[:.]${port}\\s`).test(line)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) pids.add(Number(pid));
      }
    }
    for (const pid of pids) {
      const task = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '';
      if (task.toLowerCase().includes('node.exe')) {
        try { process.kill(pid); } catch {}
      } else {
        throw new Error(`端口 ${port} 的监听进程 ${pid} 不是 node（${task.trim()}），拒绝终止`);
      }
    }
  } else {
    const out = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).stdout || '';
    for (const pid of out.split('\n').map(s => s.trim()).filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch {}
    }
  }
  // 等端口释放，避免影响后续测试
  for (let i = 0; i < 30; i++) {
    const probe = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
    const still = process.platform === 'win32'
      ? (probe.stdout || '').split('\n').some(l => /\sLISTENING\s/.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
      : false;
    if (!still) break;
    await sleep(200);
  }
}

// 轮询等待条件成立（open 的 dummy 浏览器进程是 detached 的，CLI 退出后写日志有延迟）
async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await sleep(intervalMs);
  }
}

// 写一个 dummy 浏览器脚本：把收到的 argv 追加到 $DUMMY_BROWSER_LOG，
// 用于新 BROWSER 环境变量可替换地验证 open 拉起浏览器时传的 URL
function writeDummyBrowser(base) {
  const script = path.join(base, 'dummy-browser.js');
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    'fs.appendFileSync(process.env.DUMMY_BROWSER_LOG, JSON.stringify(process.argv.slice(2)) + \'\\n\', \'utf-8\');',
  ].join('\n'));
  return script;
}

function readBrowserCalls(browserLog) {
  return fs.existsSync(browserLog)
    ? fs.readFileSync(browserLog, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
}

// 每个测试通用的临时环境：安装目录 + 数据目录
function setup(t, prefix) {
  const base = mkTempDir(prefix);
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir(prefix + '-data-');
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  return { base, installDir, dataDir };
}

// spawn bin 入口子命令，收集 stdout / stderr / exit code
function runCli({ installDir, args, env = {}, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/lanbook.js', ...args], {
      cwd: installDir,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI 超时（>${timeoutMs}ms）: lanbook ${args.join(' ')}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`));
    }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

test('lanbook 无参数：启动服务，stdout 与直接运行 server.js 一致', async t => {
  const { installDir, dataDir } = setup(t, 'lanbook-cli-default-');

  // CLI 入口启动（动态 PORT 注入）
  const viaCli = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir }, entry: 'bin/lanbook.js' });
  assert.equal(await viaCli.fetch('/').then(r => r.status), 200, 'CLI 启动的服务应能应答 HTTP');
  await viaCli.stop();
  await sleep(300); // 等端口完全释放 + stdout 尾部数据 flush

  // 同一数据目录再以服务端入口启动（横幅内容确定性：网卡枚举一致，仅端口可能不同）
  const viaServer = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  assert.equal(await viaServer.fetch('/').then(r => r.status), 200);
  await viaServer.stop();
  await sleep(300);

  // 端口归一化后逐字节一致（端口由两次动态分配，内容含启动横幅 + 数据目录）
  const norm = (s, port) => s.split(String(port)).join('<PORT>');
  const outCli = norm(viaCli.stdout(), viaCli.port);
  const outServer = norm(viaServer.stdout(), viaServer.port);
  assert.ok(outCli.includes('数据目录'), '输出应含启动横幅（数据目录行）');
  assert.ok(outCli.includes('访问地址'), '输出应含访问地址');
  assert.equal(outCli, outServer, 'CLI 入口与直接运行服务端的 stdout 应一致');
});

test('lanbook 未知命令：打印用法到 stderr 并以非零码退出', async t => {
  const { installDir, dataDir } = setup(t, 'lanbook-cli-unknown-');
  const r = await runCli({ installDir, args: ['frobnicate'], env: { LANBOOK_HOME: dataDir } });
  assert.notEqual(r.code, 0, '未知命令应非零退出');
  assert.ok(r.stderr.includes('用法') || r.stderr.includes('lanbook'), 'stderr 应含用法提示');
  assert.ok(!r.stderr.includes('Cannot find module'), '不应因模块缺失崩溃');
});

test('lanbook add：默认写入知识库 roots，--teach 写入课程 roots', async t => {
  const { base, installDir, dataDir } = setup(t, 'lanbook-cli-add-');
  const kbDir = fs.mkdtempSync(path.join(base, 'kb-'));
  const teachDir = fs.mkdtempSync(path.join(base, 'teach-'));
  const env = { LANBOOK_HOME: dataDir };

  const r1 = await runCli({ installDir, args: ['add', kbDir], env });
  assert.equal(r1.code, 0, `add 应成功退出\n--- stdout ---\n${r1.stdout}\n--- stderr ---\n${r1.stderr}`);
  const knowledge = readJson(path.join(dataDir, 'knowledge.config.json'));
  assert.ok(knowledge.roots.includes(path.resolve(kbDir)), '知识库 roots 应含该目录');
  assert.deepEqual(readJson(path.join(dataDir, 'teach.config.json')).roots, [], '课程 roots 不应被默认 add 触动');

  const r2 = await runCli({ installDir, args: ['add', '--teach', teachDir], env });
  assert.equal(r2.code, 0, `add --teach 应成功退出\n--- stdout ---\n${r2.stdout}\n--- stderr ---\n${r2.stderr}`);
  const teach = readJson(path.join(dataDir, 'teach.config.json'));
  assert.ok(teach.roots.includes(path.resolve(teachDir)), '课程 roots 应含该目录');
  const knowledgeAfter = readJson(path.join(dataDir, 'knowledge.config.json'));
  assert.deepEqual(knowledgeAfter.roots, [path.resolve(kbDir)], '--teach 不应改动知识库 roots');
});

test('lanbook add：目录不存在时明确报错、零副作用', async t => {
  const { base, installDir, dataDir } = setup(t, 'lanbook-cli-add-miss-');
  const missing = path.join(base, 'definitely-not-exist');

  const r = await runCli({ installDir, args: ['add', missing], env: { LANBOOK_HOME: dataDir } });
  assert.notEqual(r.code, 0, '不存在的目录应非零退出');
  assert.ok(r.stderr.includes('不存在'), 'stderr 应含「不存在」明确报错');
  assert.ok(r.stderr.includes(missing), '报错应指出具体路径');
  assert.equal(fs.existsSync(path.join(dataDir, 'knowledge.config.json')), false, '报错时不应初始化 / 写入任何配置');
});

test('lanbook config：打印三个配置文件路径；设 $EDITOR 时打开它们', async t => {
  const { base, installDir, dataDir } = setup(t, 'lanbook-cli-config-');
  const settings = path.join(dataDir, 'settings.json');
  const knowledge = path.join(dataDir, 'knowledge.config.json');
  const teach = path.join(dataDir, 'teach.config.json');

  // 未设 EDITOR：只打印路径
  const r1 = await runCli({ installDir, args: ['config'], env: { LANBOOK_HOME: dataDir, EDITOR: '' } });
  assert.equal(r1.code, 0, `config 应成功退出\n--- stdout ---\n${r1.stdout}\n--- stderr ---\n${r1.stderr}`);
  for (const p of [settings, knowledge, teach]) {
    assert.ok(r1.stdout.includes(p), `stdout 应含配置路径 ${p}`);
  }

  // 设 EDITOR：用 dummy 编辑器记录收到的 argv，验证三个路径被传给编辑器
  const editorLog = path.join(base, 'editor-calls.log');
  const editorScript = path.join(base, 'dummy-editor.js');
  fs.writeFileSync(editorScript, `
    require('fs').appendFileSync(process.env.DUMMY_EDITOR_LOG, JSON.stringify(process.argv.slice(2)) + '\\n', 'utf-8');
  `);
  const r2 = await runCli({
    installDir,
    args: ['config'],
    env: { LANBOOK_HOME: dataDir, EDITOR: `${process.execPath} ${editorScript}`, DUMMY_EDITOR_LOG: editorLog },
  });
  assert.equal(r2.code, 0, `config + EDITOR 应成功退出\n--- stdout ---\n${r2.stdout}\n--- stderr ---\n${r2.stderr}`);
  const calls = fs.readFileSync(editorLog, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(calls.length, 1, 'EDITOR 应被调用一次');
  assert.deepEqual(calls[0], [settings, knowledge, teach], '三个配置路径应作为参数传给 EDITOR');
});

test('lanbook open：服务未运行时后台启动，端口可访问并拉起浏览器', async t => {
  const { base, installDir, dataDir } = setup(t, 'lanbook-cli-open-');
  const port = await freePort();
  const browserLog = path.join(base, 'browser-calls.log');
  const browserScript = writeDummyBrowser(base);

  const r = await runCli({
    installDir,
    args: ['open'],
    env: {
      LANBOOK_HOME: dataDir,
      PORT: String(port),
      BROWSER: `${process.execPath} ${browserScript}`,
      DUMMY_BROWSER_LOG: browserLog,
    },
    timeoutMs: 40000,
  });
  t.after(() => killNodeServerByPort(port));

  assert.equal(r.code, 0, `open 应成功退出\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);

  // 服务被 open 后台拉起：断言端口可访问（AC 原文）
  const resp = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(resp.status, 200, '端口应可访问且首页应答 200');

  // 浏览器拉起：URL 传给了浏览器命令（手动验证之外的自动化部分）；
  // dummy 浏览器是 detached 进程，CLI 退出后可能尚未写完日志，轮询等待
  const calls = await waitFor(() => readBrowserCalls(browserLog).length > 0).then(() => readBrowserCalls(browserLog));
  assert.ok(calls.some(c => c.includes(`http://127.0.0.1:${port}/`)), `浏览器应收到服务 URL，实际: ${JSON.stringify(calls)}`);
});

test('lanbook open：服务已运行时不重复启动，直接打开浏览器', async t => {
  const { base, installDir, dataDir } = setup(t, 'lanbook-cli-open-up-');
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  const browserLog = path.join(base, 'browser-calls.log');
  const browserScript = writeDummyBrowser(base);

  const r = await runCli({
    installDir,
    args: ['open'],
    env: {
      LANBOOK_HOME: dataDir,
      PORT: String(srv.port),
      BROWSER: `${process.execPath} ${browserScript}`,
      DUMMY_BROWSER_LOG: browserLog,
    },
  });

  assert.equal(r.code, 0, `open 应成功退出\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  assert.ok(r.stdout.includes('已在运行'), 'stdout 应说明服务已在运行（未重复启动）');
  assert.equal(await srv.fetch('/').then(x => x.status), 200, '原有服务应保持健康');
  const calls2 = await waitFor(() => readBrowserCalls(browserLog).length > 0).then(() => readBrowserCalls(browserLog));
  assert.ok(calls2.some(c => c.includes(`http://127.0.0.1:${srv.port}/`)), '浏览器应收到服务 URL');
  await srv.stop();
});
