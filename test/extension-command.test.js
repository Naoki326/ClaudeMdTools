'use strict';
// 扩展「加根目录」路径的进程边界测试。
//
// 覆盖两件事：
//   1. 拒绝确认 → 配置零写入（原实现是静默改写配置再回滚，中途失败会留下脏 roots）
//   2. 接受确认 → 经服务端 /api/knowledge/config 持久加入（服务端顺带刷新 watcher）
//
// 用真实的 lanbook 服务进程 + 独立 LANBOOK_HOME，绝不触碰 ~/.lanbook/。
// 扩展用 pi 自带的 jiti 加载（.ts 无法被 node 直接 import）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, REPO_ROOT } = require('./helpers');
const { spawnSync } = require('node:child_process');

// 定位 pi 自带的 jiti（扩展是 TypeScript，需转译后加载）
function loadJiti() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', 'jiti', 'lib', 'jiti.cjs'),
  ];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@earendil-works',
      'pi-coding-agent', 'node_modules', 'jiti', 'lib', 'jiti.cjs'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c).createJiti;
  }
  return null;
}

// 加载扩展并取出 /lanbook 的 handler；jiti 不可用时返回 null（调用方 skip）
async function loadLanbookHandler(extensionPath) {
  const createJiti = loadJiti();
  if (!createJiti) return null;
  const jiti = createJiti(__filename, { interopDefault: true });
  const mod = await jiti.import(extensionPath);
  const factory = (mod && mod.default) || mod;
  let handler = null;
  factory({
    registerCommand: (name, opts) => { if (name === 'lanbook') handler = opts.handler; },
    sendMessage: async () => {},
  });
  return handler;
}

// 造一个假 ctx.ui，记录 notify / 确认次数，并按 answer 回答确认
function fakeCtx(answer) {
  const notices = [];
  const confirms = [];
  return {
    notices,
    confirms,
    ctx: {
      cwd: process.cwd(),
      ui: {
        notify: (m, t) => notices.push({ m, t }),
        confirm: async (title, message) => { confirms.push({ title, message }); return answer; },
        select: async () => undefined,
      },
    },
  };
}

test('扩展加载可用（jiti 缺失时跳过其余用例）', async t => {
  const ext = path.join(__dirname, '..', 'extensions', 'lanbook-open.ts');
  assert.ok(fs.existsSync(ext), '扩展文件应存在于 extensions/lanbook-open.ts');
  if (!(await loadLanbookHandler(ext))) {
    t.skip('未找到 pi 自带的 jiti，无法加载 TypeScript 扩展');
  }
});

test('拒绝确认 → 不写 knowledge.config.json，并给出 CLI 提示', async t => {
  const ext = path.join(__dirname, '..', 'extensions', 'lanbook-open.ts');
  const handler = await loadLanbookHandler(ext);
  if (!handler) return t.skip('未找到 jiti');

  const base = mkTempDir('lanbook-ext-decline-');
  const installDir = makeInstallDir(base);
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => {
    removeInstallDir(installDir);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });

  // 必须有真实服务在跑：否则 handler 会先走 ensureLanbook → 拉起一个后台服务（测试副作用）
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  fs.writeFileSync(path.join(dataDir, 'settings.json'),
    JSON.stringify({ port: srv.port, host: '127.0.0.1' }), 'utf-8');

  // 先经 API 把已知根目录写进配置（此时磁盘文件由服务端生成）
  const knownRoot = path.join(base, 'known');
  fs.mkdirSync(knownRoot, { recursive: true });
  fs.writeFileSync(path.join(knownRoot, 'inside.md'), '# 已收录\n', 'utf-8');
  const setRes = await srv.fetch('/api/knowledge/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: [knownRoot] }),
  });
  assert.ok(setRes.ok, `初始化 roots 失败: ${setRes.status}`);

  const cfgPath = path.join(dataDir, 'knowledge.config.json');
  const before = fs.readFileSync(cfgPath, 'utf-8');

  const outside = path.join(base, 'outside-doc.md');
  fs.writeFileSync(outside, '# 外部文档\n', 'utf-8');

  const { ctx, notices, confirms } = fakeCtx(false);
  const savedHome = process.env.LANBOOK_HOME;
  process.env.LANBOOK_HOME = dataDir;
  try {
    await handler(outside, ctx);
  } finally {
    if (savedHome === undefined) delete process.env.LANBOOK_HOME; else process.env.LANBOOK_HOME = savedHome;
  }

  assert.equal(confirms.length, 1, '根目录外文件应先征求确认');
  assert.match(confirms[0].message, /不在任何知识库根目录下/);
  assert.equal(fs.readFileSync(cfgPath, 'utf-8'), before,
    '拒绝后配置必须逐字节不变（不得静默改写再回滚）');
  assert.ok(notices.some(n => n.t === 'warning' && /lanbook add/.test(n.m)),
    '应提示可手动执行 lanbook add');
});

test('接受确认 → 经服务端 API 把目录加入 roots（服务端进程真实生效）', async t => {
  const ext = path.join(__dirname, '..', 'extensions', 'lanbook-open.ts');
  const handler = await loadLanbookHandler(ext);
  if (!handler) return t.skip('未找到 jiti');

  const base = mkTempDir('lanbook-ext-accept-');
  const installDir = makeInstallDir(base);
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => {
    removeInstallDir(installDir);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });

  // 真实服务进程：LANBOOK_HOME 指向独立数据目录，绝不触碰 ~/.lanbook/
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });

  // 扩展要能发现这个端口：写 settings.json（与 startServer 注入的 PORT 一致）
  fs.writeFileSync(path.join(dataDir, 'settings.json'),
    JSON.stringify({ port: srv.port, host: '127.0.0.1' }), 'utf-8');

  const outsideDir = path.join(base, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outside = path.join(outsideDir, 'note.md');
  fs.writeFileSync(outside, '# 外部笔记\n', 'utf-8');

  const { ctx, notices, confirms } = fakeCtx(true);
  const savedHome = process.env.LANBOOK_HOME;
  process.env.LANBOOK_HOME = dataDir;
  try {
    await handler(outside, ctx);
  } finally {
    if (savedHome === undefined) delete process.env.LANBOOK_HOME; else process.env.LANBOOK_HOME = savedHome;
  }

  assert.equal(confirms.length, 1, '应先征求确认');
  assert.ok(notices.some(n => n.t === 'info' && /已生成链接/.test(n.m)),
    `接受后应生成链接，实际通知: ${JSON.stringify(notices)}`);

  // 服务端（内存 + 磁盘）都应有新根目录
  const viaApi = await srv.fetch('/api/knowledge/config').then(r => r.json());
  assert.ok((viaApi.roots || []).some(r => path.resolve(String(r)) === path.resolve(outsideDir)),
    `服务端 roots 应含新目录，实际: ${JSON.stringify(viaApi.roots)}`);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge.config.json'), 'utf-8'));
  assert.ok((onDisk.roots || []).some(r => path.resolve(String(r)) === path.resolve(outsideDir)),
    `配置应持久化新目录，实际: ${JSON.stringify(onDisk.roots)}`);
});

test('接受确认时重复调用不产生重复 root（幂等）', async t => {
  const ext = path.join(__dirname, '..', 'extensions', 'lanbook-open.ts');
  const handler = await loadLanbookHandler(ext);
  if (!handler) return t.skip('未找到 jiti');

  const base = mkTempDir('lanbook-ext-idem-');
  const installDir = makeInstallDir(base);
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => {
    removeInstallDir(installDir);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  });

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  fs.writeFileSync(path.join(dataDir, 'settings.json'),
    JSON.stringify({ port: srv.port, host: '127.0.0.1' }), 'utf-8');

  const outsideDir = path.join(base, 'outside');
  fs.mkdirSync(outsideDir, { recursive: true });
  const outside = path.join(outsideDir, 'note.md');
  fs.writeFileSync(outside, '# 笔记\n', 'utf-8');

  const savedHome = process.env.LANBOOK_HOME;
  process.env.LANBOOK_HOME = dataDir;
  try {
    for (let i = 0; i < 3; i++) {
      const { ctx } = fakeCtx(true);
      await handler(outside, ctx);
    }
  } finally {
    if (savedHome === undefined) delete process.env.LANBOOK_HOME; else process.env.LANBOOK_HOME = savedHome;
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'knowledge.config.json'), 'utf-8'));
  const hits = (cfg.roots || []).filter(r => path.resolve(String(r)) === path.resolve(outsideDir));
  assert.equal(hits.length, 1, `同一目录重复添加应只留一条，实际: ${JSON.stringify(cfg.roots)}`);
});

// —— /lanbook autostart 与 /lanbook status（让 pi 装完包即可一键注册自启）——
// 设计要点：扩展不自己拼 server.js 路径，而是调包内 CLI（bin/lanbook.js），
// 由 CLI 按 __dirname 推导出包内 server.js —— 这样「pi 装的这份包」就自足了。

// 取 /lanbook 的 handler（含子命令路由）
async function loadHandler() {
  const ext = path.join(__dirname, '..', 'extensions', 'lanbook-open.ts');
  return loadLanbookHandler(ext);
}

test('/lanbook help 列出子命令（含 autostart / status）', async t => {
  const handler = await loadHandler();
  if (!handler) return t.skip('未找到 jiti');

  const base = mkTempDir('lanbook-help-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const messages = [];
  const ext = path.join(__dirname, '..', 'extensions', 'lanbook-open.ts');
  const createJiti = loadJiti();
  const jiti = createJiti(__filename, { interopDefault: true });
  const mod = await jiti.import(ext);
  let h = null;
  (mod.default || mod)({ registerCommand: (n, o) => { h = o.handler; }, sendMessage: async (m) => { messages.push(m.content); } });

  const savedHome = process.env.LANBOOK_HOME;
  process.env.LANBOOK_HOME = base;
  try {
    await h('help', { cwd: process.cwd(), ui: { notify: () => {}, confirm: async () => false, select: async () => undefined } });
  } finally {
    if (savedHome === undefined) delete process.env.LANBOOK_HOME; else process.env.LANBOOK_HOME = savedHome;
  }

  const text = messages.join('\n');
  assert.match(text, /\/lanbook autostart/, 'help 应含 autostart 子命令');
  assert.match(text, /\/lanbook status/, 'help 应含 status 子命令');
  assert.match(text, /开机自启/, 'help 应说明 autostart 的作用');
});

test('扩展通过包内 CLI 注册自启，脚本指向包内 server.js（不需要 npm i -g）', async t => {
  const handler = await loadHandler();
  if (!handler) return t.skip('未找到 jiti');
  if (process.platform !== 'win32') return t.skip('autostart 仅 Windows');

  const base = mkTempDir('lanbook-autostart-');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  // 隔离：独立数据目录 + 独立任务名，绝不触碰用户真实的 lanbook-autostart 任务
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const taskName = `lanbook-test-${process.pid}-${Date.now()}`;
  const savedHome = process.env.LANBOOK_HOME;
  const savedTask = process.env.LANBOOK_AUTOSTART_TASK;
  process.env.LANBOOK_HOME = dataDir;
  process.env.LANBOOK_AUTOSTART_TASK = taskName;

  const notices = [];
  const ctx = { cwd: process.cwd(), ui: { notify: (m, tp) => notices.push({ m, tp }), confirm: async () => false, select: async () => undefined } };

  // 直接删计划任务，不经 CLI 的 --remove：
  // CLI 本身坏了时用 CLI 清理会一起失败，留下垃圾任务（本测试早先真踩过这坑）
  const deleteTask = () => {
    try {
      spawnSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf-8', timeout: 60000, windowsHide: true });
    } catch {}
  };
  t.after(() => {
    deleteTask();
    if (savedHome === undefined) delete process.env.LANBOOK_HOME; else process.env.LANBOOK_HOME = savedHome;
    if (savedTask === undefined) delete process.env.LANBOOK_AUTOSTART_TASK; else process.env.LANBOOK_AUTOSTART_TASK = savedTask;
  });

  try {
    await handler('autostart', ctx);

    assert.ok(notices.some(n => n.tp === 'info' && /已注册自启/.test(n.m)),
      `autostart 应成功，实际通知: ${JSON.stringify(notices)}`);

    // 自启脚本必须指向真实存在的 server.js，且就在本仓库内（包内路径）
    const cmdPath = path.join(dataDir, 'autostart-task.cmd');
    assert.ok(fs.existsSync(cmdPath), 'autostart 应生成 autostart-task.cmd');
    const m = fs.readFileSync(cmdPath, 'utf-8').match(/"([^"]*server\.js)"/);
    assert.ok(m, 'autostart-task.cmd 应含 server.js 路径');
    assert.ok(fs.existsSync(m[1]), `脚本指向的 server.js 必须存在: ${m[1]}`);
    assert.ok(path.resolve(m[1]).startsWith(path.resolve(REPO_ROOT)),
      `脚本应指向包内 server.js（而非其它安装位置），实际: ${m[1]}`);
  } finally {
    deleteTask();
  }
});

test('/lanbook status 报告自启脚本指向不存在的 server.js（卸载/换装后的典型故障）', async t => {
  const handler = await loadHandler();
  if (!handler) return t.skip('未找到 jiti');

  const base = mkTempDir('lanbook-status-');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  // 手工造一个「指向死路径」的自启脚本——这正是 npm uninstall -g 之后的真实状态
  const dead = path.join(base, 'gone', 'server.js');
  fs.writeFileSync(path.join(dataDir, 'autostart-task.cmd'),
    `@echo off\r\n:loop\r\n"${process.execPath}" "${dead}" >> log 2>&1\r\n`, 'utf-8');

  const savedHome = process.env.LANBOOK_HOME;
  process.env.LANBOOK_HOME = dataDir;
  const messages = [];
  const ext = path.join(__dirname, '..', 'extensions', 'lanbook-open.ts');
  const createJiti = loadJiti();
  const jiti = createJiti(__filename, { interopDefault: true });
  const mod = await jiti.import(ext);
  let h = null;
  (mod.default || mod)({ registerCommand: (n, o) => { h = o.handler; }, sendMessage: async (m) => { messages.push(m.content); } });
  try {
    await h('status', { cwd: process.cwd(), ui: { notify: () => {}, confirm: async () => false, select: async () => undefined } });
  } finally {
    if (savedHome === undefined) delete process.env.LANBOOK_HOME; else process.env.LANBOOK_HOME = savedHome;
  }

  const text = messages.join('\n');
  assert.match(text, /不存在/, `status 应指出自启脚本指向的 server.js 不存在，实际:\n${text}`);
  assert.match(text, /\/lanbook autostart/, 'status 应给出修复方式');
});
