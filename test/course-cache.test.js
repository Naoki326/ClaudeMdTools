'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer } = require('./helpers');

function write(root, rel, body = '<title>Course</title>') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

test('课程扫描/预览排除 worktree-archive，但保留 .scratch 正本与正常同名课程', async t => {
  const base = mkTempDir('course-archive-');
  const installDir = makeInstallDir(base);
  const dataDir = path.join(base, 'data');
  const root = path.join(base, 'root');
  write(root, 'project/.scratch/teach/lessons/one.html');
  write(root, 'project/.scratch/worktree-archive/date/copy/teach/lessons/one.html');
  write(root, 'other/teach/lessons/one.html');
  write(dataDir, 'teach.config.json', JSON.stringify({ roots: [root] }));
  let srv;
  t.after(async () => {
    if (srv) await srv.stop();
    removeInstallDir(installDir);
    fs.rmSync(base, { recursive: true, force: true });
  });
  srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  const data = await srv.fetch('/api/courses').then(r => r.json());
  assert.equal(data.workspaces.length, 2, '只排除归档，不按同名/同内容误删正常课程');
  const result = await srv.fetch('/api/courses/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roots: [root] }),
  }).then(r => r.json());
  assert.deepEqual(result.preview[0].workspaces.sort(), ['other/teach', 'project/.scratch/teach']);
  await srv.stop();
});
