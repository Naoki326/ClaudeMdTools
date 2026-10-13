'use strict';
// 规模防御告警（工单 #8）的 API 级行为测试：
// 1) /api/knowledge/preview 响应携带文档密度信息与低占比告警字段（增量，
//    既有字段 root / exists / docCount / projects 不变）；
// 2) 首扫对文档占比极低的根目录打一条告警日志（同一根本进程只告警一次）。
// 只断言外部行为（响应 JSON、stdout 扫描计数、stderr 告警日志，先例
// knowledge-tree-cache.test.js / guardian.test.js）；时序断言一律宽松上限。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, sleep } = require('./helpers');

// stdout 中「树扫描完成」行数 = 进程启动以来发生过的全量扫描次数
function scanCount(srv) {
  return (srv.stdout().match(/树扫描完成/g) || []).length;
}

function lowDensityWarnings(srv) {
  return srv.stderr().match(/文档占比极低/g) || [];
}

// 轮询直到谓词成立（宽松上限；超时抛错）
async function waitFor(fn, timeoutMs, { step = 200, label = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch {}
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`waitFor 超时 (${timeoutMs}ms): ${label}`);
    await sleep(step);
  }
}

// 低文档占比夹具：1 篇文档 + 3 目录 × 400 个非文档文件（.txt，共 1200 个）。
// 复刻母 spec 反例的形状（7.8 万文件只为了 18 个文档）缩放到 CI 可承受规模：
// 文档占比 1/1201 ≈ 0.08%，远低于告警阈值。
function makeLowDensityRoot(base) {
  const root = path.join(base, 'code-tree');
  const docDir = path.join(root, 'dir-00');
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, 'real-doc.md'), '# 唯一的文档\n', 'utf-8');
  for (let d = 0; d < 3; d++) {
    const sub = path.join(root, `dir-${String(d).padStart(2, '0')}`, 'src');
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < 400; i++) {
      fs.writeFileSync(path.join(sub, `file-${String(i).padStart(4, '0')}.txt`), 'x\n', 'utf-8');
    }
  }
  return root;
}

function writeConfig(dataDir, roots) {
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots }), 'utf-8');
}

async function setup(t, { name, roots }) {
  const base = mkTempDir(`kb-density-${name}-`);
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir(`kb-density-data-${name}-`);
  fs.mkdirSync(dataDir, { recursive: true });
  writeConfig(dataDir, roots);
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  return { base, dataDir, srv };
}

const postPreview = (srv, roots) => srv.fetch('/api/knowledge/preview', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ roots }),
}).then(r => r.json());

test('低文档占比根：预览响应携带密度信息与告警字段，既有字段不变', async t => {
  const base = mkTempDir('kb-density-fixture-');
  const lowRoot = makeLowDensityRoot(base);
  // 正常根：3 篇文档、无非文档文件（密度 100%）
  const normalRoot = path.join(base, 'notes');
  fs.mkdirSync(normalRoot, { recursive: true });
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(normalRoot, `note-${i}.md`), `# 笔记${i}\n`, 'utf-8');
  }
  const missingRoot = path.join(base, 'no-such-dir');

  const { srv } = await setup(t, { name: 'preview', roots: [] });
  const { preview } = await postPreview(srv, [lowRoot, normalRoot, missingRoot]);
  assert.equal(preview.length, 3, '每个 root 一条预览');

  const [low, normal, missing] = preview;

  // 既有契约字段不变（root / exists / docCount / projects）
  assert.equal(low.exists, true, '低占比根 exists 字段不变');
  assert.equal(low.docCount, 1, '低占比根 docCount 字段不变');
  assert.deepEqual(low.projects, ['dir-00'], '低占比根 projects 字段不变（只统计文档）');

  // 密度信息 + 告警字段（新增）
  assert.equal(low.totalFiles, 1201, 'totalFiles 应统计全部非排除文件（1200 非文档 + 1 文档）');
  assert.ok(low.density > 0 && low.density < 0.01, `density 应为 1/1201 ≈ 0.0008，实际 ${low.density}`);
  assert.equal(low.lowDocDensity, true, '低文档占比根应携带告警字段');

  assert.equal(normal.totalFiles, 3, '正常根 totalFiles 应只含 3 篇文档');
  assert.equal(normal.density, 1, '全文档根密度为 1');
  assert.equal(normal.lowDocDensity, false, '正常根不得告警');

  // 不存在的根：字段形状一致，中性值（契约形状统一，前端无需判分支）
  assert.deepEqual(missing, {
    root: missingRoot, exists: false, docCount: 0, projects: [],
    totalFiles: 0, density: null, lowDocDensity: false,
  });

  await srv.stop();
});

test('首扫对文档占比极低的根目录产生告警日志（同一根只告警一次）', async t => {
  const base = mkTempDir('kb-density-warnroot-');
  const lowRoot = makeLowDensityRoot(base);
  const { srv } = await setup(t, { name: 'warn', roots: [lowRoot] });
  const getTree = () => srv.fetch('/api/knowledge').then(r => r.json());

  // 首扫：产生一条告警日志
  await getTree();
  await waitFor(() => lowDensityWarnings(srv).length >= 1, 8000, { label: '首扫未产生低文档占比告警' });
  assert.equal(lowDensityWarnings(srv).length, 1, '首扫应恰好产生一条告警');
  assert.match(srv.stderr(), /code-tree/, '告警应含根目录路径，可定位到具体根');

  // 后续重建（文档改写 → 失效管道 → 第二次扫描）：同一根不重复告警
  await sleep(60); // 保证 mtime 变化
  fs.writeFileSync(path.join(lowRoot, 'dir-00', 'real-doc.md'), '# 唯一的文档（改）\n', 'utf-8');
  await waitFor(() => scanCount(srv) >= 2, 10000,
    { label: '第二次扫描未发生（告警不重复的前提是有过第二次扫描）' });
  assert.equal(lowDensityWarnings(srv).length, 1, `重建后告警不得重复，实际 ${lowDensityWarnings(srv).length} 条`);

  await srv.stop();
});
