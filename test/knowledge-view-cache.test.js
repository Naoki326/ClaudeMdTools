'use strict';
// /view 复用树缓存（工单 #8）的 API 级行为测试：
// 1) 查看文档正常返回，前端链接回退数据（KB_FILES）与相对链接渲染不回归；
// 2) 重复查看文档期间无全量遍历（重扫只由缓存失效触发）；
// 3) 大夹具下冷启动 /view（首扫在飞）时服务保持可响应；
// 4) /api/knowledge 响应契约（roots → children 树、字段名）保持不变。
// 只断言外部行为（响应内容、stdout 扫描计数，先例 knowledge-tree-cache.test.js）；
// 时序断言一律宽松上限。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, sleep } = require('./helpers');

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

function writeDoc(dir, name, body) {
  fs.writeFileSync(path.join(dir, name), body, 'utf-8');
}

// 建服务 + 单根知识库夹具：build(root) 负责铺文档
async function setup(t, { name, build }) {
  const base = mkTempDir(`kb-view-${name}-`);
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir(`kb-view-data-${name}-`);
  fs.mkdirSync(dataDir, { recursive: true });
  const kbRoot = path.join(base, 'kb');
  fs.mkdirSync(kbRoot, { recursive: true });
  build(kbRoot);
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [kbRoot] }), 'utf-8');
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  const view = relPath => srv.fetch(`/api/knowledge/view?root=${encodeURIComponent(kbRoot)}&path=${encodeURIComponent(relPath)}`);
  return { kbRoot, srv, view };
}

test('/view 正确性：正文渲染 + 相对链接回退数据（KB_FILES）不回归', async t => {
  const { kbRoot, srv, view } = await setup(t, {
    name: 'links',
    build(root) {
      fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
      writeDoc(root, 'doc-a.md', '# A 文档\n\n跳转到 [B](sub/doc-b.md) 和 [C](doc-c)。\n');
      writeDoc(path.join(root, 'sub'), 'doc-b.md', '# B 文档\n');
      writeDoc(root, 'doc-c.md', '# C 文档\n');
    },
  });

  // 预热树缓存（/view 的 KB_FILES 自此由树快照提供），顺带做契约最终确认：
  // roots → children 树，root 节点与 file 节点的字段名与母 spec 兼容条款一致
  const tree = await srv.fetch('/api/knowledge').then(r => r.json());
  assert.ok(Array.isArray(tree.roots) && tree.roots.length === 1, '树应只含一个根');
  const r0 = tree.roots[0];
  for (const k of ['name', 'path', 'index', 'children']) assert.ok(k in r0, `root 节点应含字段 ${k}`);
  const fileNodes = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.type === 'file') fileNodes.push(n);
      else if (n.children) walk(n.children);
    }
  })(r0.children);
  assert.equal(fileNodes.length, 3, '树应含全部 3 篇文档');
  for (const n of fileNodes) {
    for (const k of ['type', 'name', 'title', 'kind', 'mtime']) assert.ok(k in n, `file 节点应含字段 ${k}`);
  }

  // 查看文档：200、正文渲染、KB_FILES 含同根全部文档（含子目录、含无扩展名链接目标）
  const res = await view('doc-a.md');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1[^>]*>A 文档<\/h1>/, '正文应渲染出一级标题');
  assert.match(html, /"sub\/doc-b\.md"/, 'KB_FILES 应含子目录文档（链接回退查找依赖）');
  assert.match(html, /"doc-c\.md"/, 'KB_FILES 应含同根全部文档');
  assert.match(html, /href="sub\/doc-b\.md"/, '相对链接的 href 渲染不回归');

  await srv.stop();
});

test('重复查看文档期间无全量遍历（重扫只由缓存失效触发）', async t => {
  const { srv, view } = await setup(t, {
    name: 'noscan',
    build(root) {
      for (let i = 0; i < 5; i++) writeDoc(root, `doc-${i}.md`, `# 文档${i}\n`);
    },
  });

  // 预热：冷启动 /view 建立快照（1 次扫描）
  assert.equal((await view('doc-0.md')).status, 200);
  await waitFor(() => scanCount(srv) >= 1, 5000, { label: '首次扫描未发生' });
  const baseline = scanCount(srv);

  // 重复查看：不得引发任何新扫描（旧实现：每次查看全根同步重扫）
  for (let i = 0; i < 4; i++) {
    const res = await view('doc-0.md');
    assert.equal(res.status, 200);
    await sleep(150);
  }
  await sleep(1000); // 给「万一发生了后台重扫」留时间
  assert.equal(scanCount(srv), baseline, `重复查看不得触发全量重扫，实际多扫了 ${scanCount(srv) - baseline} 次`);

  await srv.stop();
});

test('大夹具下 /view：首扫在飞时服务保持可响应，查看正常返回', async t => {
  // 30 × 100 = 3000 篇：扫描有明确时长。冷启动 /view 引发的首扫在飞时，廉价
  // 端点须在宽松上限内应答——旧实现 /view 同步全根重扫会阻塞事件循环，全部
  // 请求排队（先例：knowledge-tree-cache 事件循环活性测试的宽松上限 1500ms）
  const { srv, view } = await setup(t, {
    name: 'big',
    build(root) {
      for (let d = 0; d < 30; d++) {
        const sub = path.join(root, `dir-${String(d).padStart(2, '0')}`);
        fs.mkdirSync(sub, { recursive: true });
        for (let i = 0; i < 100; i++) writeDoc(sub, `doc-${String(i).padStart(3, '0')}.md`, `# D${d} 文档${i}\n`);
      }
    },
  });

  // 不等待：冷启动 /view（首扫在飞）时，立刻探测廉价端点
  const viewPromise = view('dir-00/doc-000.md');
  const t0 = Date.now();
  const cfg = await srv.fetch('/api/knowledge/config');
  const latency = Date.now() - t0;
  assert.equal(cfg.status, 200);
  assert.ok(latency < 1500, `/view 首扫在飞时廉价端点应答 ${latency}ms，超出宽松上限 1500ms（事件循环被同步遍历阻塞）`);

  // /view 最终正常返回，正文渲染正确
  const res = await viewPromise;
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1[^>]*>D0 文档0<\/h1>/, '大夹具下查看文档应正常渲染');

  await waitFor(() => scanCount(srv) >= 1, 8000, { label: '首次扫描未发生' });

  // 热缓存后再次查看：正常返回
  assert.equal((await view('dir-17/doc-042.md')).status, 200, '热缓存后查看应正常返回');

  await srv.stop();
});
