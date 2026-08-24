'use strict';
// /api/knowledge 树扫描的标题缓存（scanTree titleCache）回归：
// 1) 首次扫描提取标题；2) mtime 未变 → 复用缓存（标题稳定）；
// 3) 文件更新（mtime 变）→ 缓存失效，重读全文刷新标题。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, sleep } = require('./helpers');

// 在返回的树中按文件名查找 title（roots → 递归 children）
function findTitle(roots, fileName) {
  const stack = [...roots.flatMap(r => r.children || [])];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'file' && n.name === fileName) return n.title;
    if (n.children) stack.push(...n.children);
  }
  return null;
}

test('/api/knowledge 标题缓存：mtime 未变复用，文件更新后刷新', async t => {
  const base = mkTempDir('kb-title-cache-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('kb-title-cache-data-');
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  const kbDir = path.join(base, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  const note = path.join(kbDir, 'note.md');
  fs.writeFileSync(note, '# 旧标题\n', 'utf-8');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [kbDir] }), 'utf-8');

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  const getTree = () => srv.fetch('/api/knowledge').then(r => r.json());

  // 首次扫描：提取 markdown 一级标题
  assert.equal(findTitle((await getTree()).roots, 'note.md'), '旧标题', '首次扫描应提取标题');

  // 未改动：缓存命中，标题稳定
  assert.equal(findTitle((await getTree()).roots, 'note.md'), '旧标题', 'mtime 未变应复用缓存');

  // 文件更新（mtime 变）→ 缓存失效，重读刷新
  await sleep(50); // 保证与上次 stat 的 mtime 不同
  fs.writeFileSync(note, '# 新标题\n', 'utf-8');
  assert.equal(findTitle((await getTree()).roots, 'note.md'), '新标题', 'mtime 变化后应重读文件刷新标题');

  await srv.stop();
});
