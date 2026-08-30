'use strict';
// 课程（teach）递归多层扫描回归：
// 1) workspace 发现不能只扫 root 的第一层 —— 任意深度下含 lessons/ 的文件夹都要识别；
// 2) lessons/、reference/ 下的课程 HTML 不能只扫一层 —— 子目录里的课程也要列出，
//    且 file 字段为含子目录的相对路径，/teach 静态路由能按多层路径返回文件；
// 3) node_modules 等无关目录不参与发现（复用知识库排除集合）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer } = require('./helpers');

function writeCourse(root, rel, body) {
  const fp = path.join(root, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, body, 'utf-8');
}

test('课程递归扫描：多层 workspace 发现 + lessons 子目录课程 + 静态子路径可访问', async t => {
  const base = mkTempDir('teach-recursive-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('teach-recursive-data-');
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  const root = path.join(base, 'courses-root');
  // 第一层 workspace（既有行为不回归）
  writeCourse(root, 'ws-top/lessons/0001-a.html', '<html><head><title>顶层课</title></head><body></body></html>');
  // 第二层 workspace
  writeCourse(root, 'group/ws-mid/lessons/intro.html', '<html><head><title>中层课</title></head><body></body></html>');
  // 第三层 workspace
  writeCourse(root, 'group/sub/ws-deep/lessons/deep.html', '<html><head><title>深层课</title></head><body></body></html>');
  // lessons 内子目录里的课程（getWorkspaceContent 递归）
  writeCourse(root, 'ws-top/lessons/module-1/0002-sub.html', '<html><head><title>子目录课</title></head><body></body></html>');
  // reference 子目录里的速查卡
  writeCourse(root, 'group/ws-mid/reference/cards/quick.html', '<html><head><title>速查</title></head><body></body></html>');
  // 排除目录：node_modules 下即使有 lessons/ 也不应被识别为 workspace
  writeCourse(root, 'node_modules/fake/lessons/x.html', '<html><body>x</body></html>');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'teach.config.json'),
    JSON.stringify({ roots: [root] }),
    'utf-8'
  );

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });

  // /api/courses：多层 workspace 全部发现，node_modules 下不发现
  const courses = await (await srv.fetch('/api/courses')).json();
  const ids = courses.workspaces.map(w => w.id).sort();
  assert.deepEqual(ids, ['ws-deep', 'ws-mid', 'ws-top'], `应发现三个 workspace，实际 ${ids}`);

  const top = courses.workspaces.find(w => w.id === 'ws-top');
  const topFiles = top.lessons.map(f => f.file).sort();
  assert.deepEqual(
    topFiles,
    ['0001-a.html', 'module-1/0002-sub.html'],
    `lessons 应含子目录课程且 file 为相对路径，实际 ${JSON.stringify(topFiles)}`
  );
  const sub = top.lessons.find(f => f.file === 'module-1/0002-sub.html');
  assert.equal(sub.title, '子目录课', '子目录课程的标题应从 <title> 提取');

  const mid = courses.workspaces.find(w => w.id === 'ws-mid');
  assert.deepEqual(
    mid.reference.map(f => f.file),
    ['cards/quick.html'],
    'reference 子目录速查卡应被发现'
  );

  // /teach 静态路由：多层相对路径能返回文件
  const staticRes = await srv.fetch('/teach/ws-top/lessons/module-1/0002-sub.html');
  assert.equal(staticRes.status, 200, '静态路由应能按多层路径返回课程文件');
  assert.match(await staticRes.text(), /子目录课/);

  // /api/courses/preview：返回相对根目录的路径（含中间层），node_modules 不计入
  const preview = await (await srv.fetch('/api/courses/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roots: [root] }),
  })).json();
  const pwss = preview.preview[0].workspaces.sort();
  assert.deepEqual(
    pwss,
    ['group/sub/ws-deep', 'group/ws-mid', 'ws-top'],
    `preview 应返回多层相对路径，实际 ${JSON.stringify(pwss)}`
  );

  await srv.stop();
});
