'use strict';
// 树级缓存 + 异步扫描 + single-flight + 失效去抖（工单 #6）的 API 级行为测试。
// 只断言外部行为：/api/knowledge 响应、服务可响应性、扫描次数（stdout 日志，
// 先例 test/guardian.test.js 观察日志）；时序断言一律宽松上限。
// 树新鲜度语义（本票引入）：文档变更经监听器失效管道生效（awaitWriteFinish
// 300ms + 「失效/重建/广播」整体去抖 500ms），到达的请求命中快照或按需触发
// single-flight 异步重建——去抖窗口内的请求回变更前快照，静置后可见。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, sleep } = require('./helpers');

// —— 断言辅助 ——

// 展开树中所有 file 节点：Map<fileName, title>（仅用于文件名互不重名的夹具）
function fileTitles(roots) {
  const out = new Map();
  const stack = [...(roots || []).flatMap(r => r.children || [])];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'file') out.set(n.name, n.title);
    else if (n.children) stack.push(...n.children);
  }
  return out;
}

// 树中 file 节点总数（跨目录重名也如实计数）
function countFiles(roots) {
  let n = 0;
  const stack = [...(roots || []).flatMap(r => r.children || [])];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'file') n++;
    else if (node.children) stack.push(...node.children);
  }
  return n;
}

// stdout 中「树扫描完成」行数 = 进程启动以来发生过的全量扫描次数
function scanCount(srv) {
  return (srv.stdout().match(/树扫描完成/g) || []).length;
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

// —— 夹具辅助 ——

function writeDoc(dir, name, title) {
  fs.writeFileSync(path.join(dir, name), `# ${title}\n\n正文。\n`, 'utf-8');
}

// 铺 dirs × perDir 篇文档的嵌套夹具树
function makeTree(base, { dirs = 3, perDir = 4 } = {}) {
  const root = path.join(base, 'kb');
  for (let d = 0; d < dirs; d++) {
    const sub = path.join(root, `dir-${String(d).padStart(2, '0')}`);
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < perDir; i++) writeDoc(sub, `doc-${String(i).padStart(3, '0')}.md`, `D${d} 文档${i}`);
  }
  return root;
}

async function setup(t, { name, tree } = {}) {
  const base = mkTempDir(`kb-tree-cache-${name}-`);
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir(`kb-tree-cache-data-${name}-`);
  fs.mkdirSync(dataDir, { recursive: true });
  let kbRoot = null;
  if (tree) {
    kbRoot = makeTree(base, tree);
    fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [kbRoot] }), 'utf-8');
  }
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  return { base, dataDir, kbRoot, srv, getTree: () => srv.fetch('/api/knowledge').then(r => r.json()) };
}

test('树级缓存正确性：文档增/删/改反映到下一次 /api/knowledge', async t => {
  const { kbRoot, srv, getTree } = await setup(t, { name: 'correct', tree: { dirs: 1, perDir: 2 } });
  const aMd = path.join(kbRoot, 'dir-00', 'doc-000.md');
  const sub = path.join(kbRoot, 'dir-00');

  // 冷启动首次扫描：两篇文档在树中
  let titles = fileTitles((await getTree()).roots);
  assert.equal(titles.get('doc-000.md'), 'D0 文档0', '首次扫描应含 doc-000');
  assert.equal(titles.get('doc-001.md'), 'D0 文档1', '首次扫描应含 doc-001');

  // 改：标题更新进入下一次请求（变更经监听器失效管道，宽松上限内生效）
  await sleep(60); // 保证 mtime 变化
  writeDoc(sub, 'doc-000.md', 'D0 文档0-改');
  await waitFor(async () => fileTitles((await getTree()).roots).get('doc-000.md') === 'D0 文档0-改',
    6000, { label: '改后标题未刷新' });

  // 增：新建文档出现
  writeDoc(sub, 'doc-new.md', '新增文档');
  await waitFor(async () => fileTitles((await getTree()).roots).has('doc-new.md'),
    6000, { label: '新增文档未出现' });

  // 删：被删文档消失
  fs.rmSync(path.join(sub, 'doc-001.md'));
  await waitFor(async () => !fileTitles((await getTree()).roots).has('doc-001.md'),
    6000, { label: '被删文档未消失' });

  titles = fileTitles((await getTree()).roots);
  assert.deepEqual([...titles.keys()].sort(), ['doc-000.md', 'doc-new.md'], '最终树应与磁盘一致');
  assert.equal(titles.get('doc-new.md'), '新增文档');

  await srv.stop();
});

test('缓存命中：无变更时重复请求返回一致负载，且期间服务保持可响应', async t => {
  const { srv, getTree } = await setup(t, { name: 'hit', tree: { dirs: 2, perDir: 3 } });

  const first = await getTree();
  assert.ok(first.roots.length > 0);
  await waitFor(() => scanCount(srv) >= 1, 5000, { label: '首次扫描未发生' });

  // 无变更：重复请求负载逐字节一致，且不引发新扫描
  for (let i = 0; i < 3; i++) {
    const again = await getTree();
    assert.deepEqual(again, first, `第 ${i + 2} 次请求应命中缓存返回一致负载`);
  }
  await sleep(1000); // 给「万一发生了后台重扫」留时间
  assert.equal(scanCount(srv), 1, '无变更时不得重扫');

  // 重复请求期间廉价端点保持可响应（宽松上限 1.5s）
  const t0 = Date.now();
  const cfg = await srv.fetch('/api/knowledge/config');
  assert.equal(cfg.status, 200);
  assert.ok(Date.now() - t0 < 1500, `廉价端点应答耗时 ${Date.now() - t0}ms，超出宽松上限 1500ms`);

  await srv.stop();
});

test('single-flight：并发请求合并为同一次扫描（N 次并发 ≠ N 次全量遍历）', async t => {
  // 300 篇文档让扫描有明显时长，确保并发请求落在同一次扫描窗口内
  const { srv, getTree } = await setup(t, { name: 'flight', tree: { dirs: 30, perDir: 10 } });

  const results = await Promise.all(Array.from({ length: 6 }, () => getTree()));
  for (const r of results) assert.deepEqual(r, results[0], '并发请求应返回一致负载');
  assert.ok(results[0].roots.length > 0, '树应非空');

  await waitFor(() => scanCount(srv) >= 1, 8000, { label: '扫描未完成' });
  await sleep(1000); // 给「迟到的额外扫描」留时间
  assert.equal(scanCount(srv), 1, `并发请求应共享同一次扫描，实际发生了 ${scanCount(srv)} 次`);

  await srv.stop();
});

test('失效去抖：连续快速编辑文档不触发重扫风暴', async t => {
  // 单目录 8 篇：fileTitles 按文件名索引，避免跨目录重名干扰标题断言
  const { kbRoot, srv, getTree } = await setup(t, { name: 'debounce', tree: { dirs: 1, perDir: 8 } });
  const sub = path.join(kbRoot, 'dir-00');

  // 预热：建立基线快照（1 次扫描）
  await getTree();
  await waitFor(() => scanCount(srv) >= 1, 5000, { label: '预热扫描未发生' });
  const baseline = scanCount(srv);

  // 风暴：6 篇文档在 ~250ms 内连续改写（各自经 awaitWriteFinish 变成事件流）
  const edited = [];
  for (let i = 0; i < 6; i++) {
    const name = `doc-${String(i).padStart(3, '0')}.md`;
    writeDoc(sub, name, `风暴改写${i}`);
    edited.push(name);
    await sleep(40);
  }

  // 静置等待（宽松上限覆盖：awaitWriteFinish 300ms + 去抖 500ms + 重建耗时）
  // 关键：期间不发任何树请求——观察的是去抖后台重建，而非请求驱动重建
  await sleep(3000);

  const scans = scanCount(srv) - baseline;
  assert.ok(scans >= 1, '去抖窗口结束后应发生一次合并重建');
  assert.ok(scans <= 3, `连续 6 次快速编辑应合并为至多 1-2 次扫描，实际 ${scans} 次（风暴未去抖）`);

  // 风暴过后树应反映改写内容
  const titles = fileTitles((await getTree()).roots);
  assert.equal(titles.get('doc-000.md'), '风暴改写0', '风暴后树应反映改写');
  assert.equal(titles.get('doc-005.md'), '风暴改写5', '风暴后树应反映改写');

  await srv.stop();
});

test('事件循环活性：数千文件扫描进行中，廉价端点在宽松上限内应答', async t => {
  const { kbRoot, srv, getTree } = await setup(t, { name: 'liveness', tree: { dirs: 30, perDir: 100 } }); // 3000 篇

  // 不等待：树请求（首次全量扫描）在飞时，立刻探测廉价端点
  const treePromise = getTree();
  const t0 = Date.now();
  const cfg = await srv.fetch('/api/knowledge/config');
  const latency = Date.now() - t0;
  assert.equal(cfg.status, 200);
  assert.ok(latency < 1500, `扫描进行中廉价端点应答 ${latency}ms，超出宽松上限 1500ms（事件循环被同步 IO 阻塞）`);

  // 扫描进行中发生的变更不得被在飞扫描「吃掉」：R1 冷扫描（3000 篇，秒级）
  // 期间写入新文档，其失效事件落在扫描窗口内——R1 的结果必须作废，
  // 下一次请求反映变更（失效代次语义）
  await sleep(300); // 仍在首次扫描窗口内（冷扫描 ≥1s）
  writeDoc(path.join(kbRoot, 'dir-00'), 'late.md', '迟到文档');

  // 首次扫描最终完成且完整：原始 3000 篇全部在树中。late.md 是否已进入本次
  // 扫描取决于 dir-00 遍历与写入的相对时序（30 个目录经 Promise.all 并发，
  // 套件负载下不可预设 dir-00 先被遍历）——不作精确断言，失效语义由下方
  // 「后续请求必含 late.md」验证（曾因断言恰为 3000 在全量套件负载下实得
  // 3001 而 flake）
  const first = await treePromise;
  assert.ok(countFiles(first.roots) >= 3000, `首次扫描应含全部 3000 篇原始文档，实际 ${countFiles(first.roots)}`);

  // 失效管道落地后，下一次请求必须包含扫描期间写入的文档
  await waitFor(async () => countFiles((await getTree()).roots) === 3001,
    8000, { label: '扫描期间写入的文档未出现在后续请求中' });

  await srv.stop();
});

test('修改根目录 / 排除配置后树与缓存跟随，无需重启即生效', async t => {
  const base = mkTempDir('kb-tree-cache-cfg-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('kb-tree-cache-data-cfg-');
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const dirA = path.join(base, 'proj-a');
  const dirB = path.join(base, 'proj-b');
  fs.mkdirSync(path.join(dirA, 'skip'), { recursive: true });
  fs.mkdirSync(path.join(dirB, 'skip'), { recursive: true });
  writeDoc(dirA, 'a.md', 'A 文档');
  writeDoc(path.join(dirA, 'skip'), 'hidden-a.md', 'A 隐藏文档');
  writeDoc(dirB, 'b.md', 'B 文档');
  writeDoc(path.join(dirB, 'skip'), 'hidden-b.md', 'B 隐藏文档');
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [dirA] }), 'utf-8');

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  const getTree = () => srv.fetch('/api/knowledge').then(r => r.json());
  const postConfig = body => srv.fetch('/api/knowledge/config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  // 初始：只有 proj-a（skip/ 尚未配置排除，hidden-a.md 在树中）
  let names = [...fileTitles((await getTree()).roots).keys()].sort();
  assert.deepEqual(names, ['a.md', 'hidden-a.md'], '初始应只含 proj-a 的文档');

  // 加根 + 排除：proj-b 进入，skip/ 被排除——下一次请求即跟随
  assert.equal((await postConfig({ roots: [dirA, dirB], excludeDirs: ['skip'] })).status, 200);
  await waitFor(async () => {
    const titles = fileTitles((await getTree()).roots);
    return titles.has('b.md') && !titles.has('hidden-b.md') && !titles.has('hidden-a.md');
  }, 6000, { label: '配置修改后树未跟随' });
  names = [...fileTitles((await getTree()).roots).keys()].sort();
  assert.deepEqual(names, ['a.md', 'b.md'], 'excludeDirs 应同时从树中摘除 skip/ 文档');

  // 移除 proj-a：树随之收缩
  assert.equal((await postConfig({ roots: [dirB] })).status, 200);
  await waitFor(async () => {
    const titles = fileTitles((await getTree()).roots);
    return titles.has('b.md') && !titles.has('a.md');
  }, 6000, { label: '移除根后树未收缩' });

  await srv.stop();
});

test('根目录缺失/恢复：缺失期间缓存收敛不重扫，恢复后一趟重建带回该根', async t => {
  // 回归：任一配置根磁盘缺失期间，旧的「有根缺失即失效」让每次请求都全量
  // 重建（缓存永不收敛）；根恢复后 chokidar 不监视缺失路径、无事件，旧逻辑
  // 无失效路径，一直回缺根的陈旧快照。现在快照记录各根存在性：状态一致直接
  // 命中，翻转（出现/消失）才重建。
  const base = mkTempDir('kb-tree-cache-root-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('kb-tree-cache-data-root-');
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const dirA = path.join(base, 'proj-a');
  const dirB = path.join(base, 'proj-b'); // 启动时不存在：模拟磁盘缺失（如未挂载）
  fs.mkdirSync(dirA, { recursive: true });
  writeDoc(dirA, 'a.md', 'A 文档');
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'),
    JSON.stringify({ roots: [dirA, dirB] }), 'utf-8');

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  const getTree = () => srv.fetch('/api/knowledge').then(r => r.json());

  // 冷启动：缺失根被跳过，快照只含 proj-a
  const firstTree = await getTree();
  assert.equal(firstTree.roots.length, 1, '缺失根应被跳过');
  assert.equal(firstTree.roots[0].name, 'proj-a');
  await waitFor(() => scanCount(srv) >= 1, 5000, { label: '首次扫描未发生' });

  // 缺失期间：重复请求直接命中快照——零新增扫描（缓存收敛，不再逐请求重建）
  const baseline = scanCount(srv);
  for (let i = 0; i < 3; i++) {
    const again = await getTree();
    assert.equal(again.roots.length, 1, `缺失期间第 ${i + 1} 次请求仍应只含 proj-a`);
    await sleep(150);
  }
  await sleep(1000); // 给「万一发生了后台重扫」留时间
  assert.equal(scanCount(srv), baseline, `缺失期间重复请求不得引发重扫，实际多扫了 ${scanCount(srv) - baseline} 次`);

  // 根恢复：目录带文档出现（缺失期间 chokidar 未监听它，恢复无事件可言）——
  // 存在性状态翻转必须触发一趟重建，把 proj-b 带回树中
  fs.mkdirSync(dirB, { recursive: true });
  writeDoc(dirB, 'b.md', 'B 文档');
  await waitFor(async () => (await getTree()).roots.length === 2,
    8000, { label: '根恢复后树未带回缺失根（恢复无失效路径）' });
  const recovered = fileTitles((await getTree()).roots);
  assert.deepEqual([...recovered.keys()].sort(), ['a.md', 'b.md'], '恢复后树应同时含两根的文档');

  await srv.stop();
});

test('失效去抖覆盖真实客户端路径：风暴期间逐事件重拉不引发逐事件重扫', async t => {
  // 回归：旧逻辑逐事件立即失效 + 立即广播，前端收到 knowledge-change 即
  // loadFileList() 重拉 /api/knowledge（public/index.html，无客户端去抖）——
  // 逐事件失效把在飞扫描作废、重拉又起新扫，真实客户端路径仍是重扫风暴。
  // 现在「失效 + 重建 + 广播」整体去抖：风暴期间请求命中旧快照，静置后一次
  // 重建 + 一次广播。
  const { kbRoot, srv, getTree } = await setup(t, { name: 'debounce-client', tree: { dirs: 1, perDir: 8 } });
  const sub = path.join(kbRoot, 'dir-00');

  // 预热：建立基线快照
  await getTree();
  await waitFor(() => scanCount(srv) >= 1, 5000, { label: '预热扫描未发生' });
  const baseline = scanCount(srv);

  // 风暴 + 逐事件重拉：每写一篇立即拉一次树（模拟前端收到广播即 loadFileList
  // 的真实路径，无客户端去抖）
  for (let i = 0; i < 6; i++) {
    writeDoc(sub, `doc-${String(i).padStart(3, '0')}.md`, `风暴改写${i}`);
    await getTree();
    await sleep(40);
  }

  // 静置：等去抖合并重建发生，再给「迟到的额外扫描」留时间（宽松上限覆盖
  // awaitWriteFinish 300ms + 去抖 500ms + 重建耗时）
  await waitFor(() => scanCount(srv) > baseline, 8000, { label: '去抖合并重建未发生' });
  await sleep(1000);
  const scans = scanCount(srv) - baseline;
  assert.ok(scans <= 3, `风暴 + 逐事件重拉应合并为至多 1-2 次扫描，实际 ${scans} 次（客户端路径未去抖）`);

  // 风暴过后树应反映改写内容
  const titles = fileTitles((await getTree()).roots);
  assert.equal(titles.get('doc-000.md'), '风暴改写0', '风暴后树应反映改写');
  assert.equal(titles.get('doc-005.md'), '风暴改写5', '风暴后树应反映改写');

  await srv.stop();
});
