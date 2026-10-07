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
const { mkTempDir, makeInstallDir, removeInstallDir, startServer } = require('./helpers');

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
