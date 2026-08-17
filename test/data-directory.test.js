'use strict';
// Ticket #2（lanbook T1 · 数据目录地基与自动迁移）进程边界测试
// 覆盖验收标准：LANBOOK_HOME 覆盖、默认 ~/.lanbook、三文件迁移留底、幂等跳过、
// 配置 API 持久化、/kb /api/* /teach/* 契约回归。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, snapshotDir, startServer, sleep } = require('./helpers');

// 在安装目录预置旧位置三文件（1.1 版布局：仓库根的两个配置 + docs/.metadata.json）
function presetLegacyFiles(installDir, { knowledge, teach, metadata }) {
  if (knowledge !== undefined) {
    fs.writeFileSync(path.join(installDir, 'knowledge.config.json'), JSON.stringify(knowledge, null, 2), 'utf-8');
  }
  if (teach !== undefined) {
    fs.writeFileSync(path.join(installDir, 'teach.config.json'), JSON.stringify(teach, null, 2), 'utf-8');
  }
  if (metadata !== undefined) {
    fs.mkdirSync(path.join(installDir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(installDir, 'docs', '.metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
  }
}

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf-8'));

test('LANBOOK_HOME 指向临时目录：三文件新读写落在数据目录，安装目录零写入', async t => {
  const base = mkTempDir('lanbook-ac1-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-ac1-data-');
  t.after(() => { removeInstallDir(installDir); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

  const before = snapshotDir(installDir);
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });

  // 三个文件的写入全走配置 / 元数据 API
  await srv.fetch('/api/knowledge/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: ['C:/nowhere-kb'] }),
  }).then(r => assert.equal(r.status, 200));
  await srv.fetch('/api/courses/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: ['C:/nowhere-teach'] }),
  }).then(r => assert.equal(r.status, 200));
  await srv.fetch('/api/metadata', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: 'note.md', sessionId: 's1', sourcePath: '../p/note.md' }),
  }).then(r => assert.equal(r.status, 200));
  // 对话文件（docs 目录写入）也应落在数据目录
  await srv.fetch('/api/files', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'note.md', content: '# Hi' }),
  }).then(r => assert.equal(r.status, 201));
  await srv.stop();

  // 数据目录就位
  assert.deepEqual(readJson(path.join(dataDir, 'knowledge.config.json')), { roots: ['C:/nowhere-kb'] });
  assert.deepEqual(readJson(path.join(dataDir, 'teach.config.json')), { roots: ['C:/nowhere-teach'] });
  const meta = readJson(path.join(dataDir, 'docs', '.metadata.json'));
  assert.equal(meta['note.md'].sessionId, 's1');
  assert.equal(fs.readFileSync(path.join(dataDir, 'docs', 'note.md'), 'utf-8'), '# Hi');

  // 安装目录零写入（无新文件、无改名、无内容变化）
  assert.deepEqual(snapshotDir(installDir), before);
});

test('未设置 LANBOOK_HOME：读写 ~/.lanbook/，目录与默认配置自动创建', async t => {
  const base = mkTempDir('lanbook-ac2-');
  const installDir = makeInstallDir(base);
  const fakeHome = mkTempDir('lanbook-ac2-home-');
  t.after(() => { removeInstallDir(installDir); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {} });

  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, HOMEDRIVE: fakeHome.slice(0, 2), HOMEPATH: fakeHome.slice(2) };
  delete env.LANBOOK_HOME;
  const srv = await startServer({ t, installDir, env });
  await srv.stop();

  const dataDir = path.join(fakeHome, '.lanbook');
  assert.ok(fs.existsSync(dataDir), '数据目录 ~/.lanbook 自动创建');
  assert.ok(fs.statSync(path.join(dataDir, 'docs')).isDirectory(), 'docs 子目录自动创建');
  assert.deepEqual(readJson(path.join(dataDir, 'knowledge.config.json')), { roots: [] }, '默认知识库配置自动创建');
  assert.deepEqual(readJson(path.join(dataDir, 'teach.config.json')), { roots: [] }, '默认课程配置自动创建');
});

test('预置旧位置三文件：首启迁入数据目录并留底，二次启动不重复迁移', async t => {
  const base = mkTempDir('lanbook-ac3-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-ac3-data-');
  t.after(() => { removeInstallDir(installDir); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

  const knowledge = { roots: ['C:/legacy/kb-root'] };
  const teach = { roots: ['C:/legacy/teach-root'] };
  const metadata = { 'old.md': { sessionId: 's-old', timestamp: 123456, sourcePath: '../legacy/old.md' } };
  presetLegacyFiles(installDir, { knowledge, teach, metadata });

  // 首启
  let srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  // roots 一条不丢：配置 API 从数据目录读到旧值
  assert.deepEqual(await srv.fetch('/api/knowledge/config').then(r => r.json()), knowledge);
  assert.deepEqual(await srv.fetch('/api/courses/config').then(r => r.json()), teach);
  await srv.stop();

  // 数据目录三文件就位，内容与旧文件一致
  assert.deepEqual(readJson(path.join(dataDir, 'knowledge.config.json')), knowledge);
  assert.deepEqual(readJson(path.join(dataDir, 'teach.config.json')), teach);
  assert.deepEqual(readJson(path.join(dataDir, 'docs', '.metadata.json')), metadata);
  // 旧文件原地改名 .migrated.bak 留底，原名消失
  assert.deepEqual(readJson(path.join(installDir, 'knowledge.config.json.migrated.bak')), knowledge);
  assert.deepEqual(readJson(path.join(installDir, 'teach.config.json.migrated.bak')), teach);
  assert.deepEqual(readJson(path.join(installDir, 'docs', '.metadata.json.migrated.bak')), metadata);
  assert.ok(!fs.existsSync(path.join(installDir, 'knowledge.config.json')));
  assert.ok(!fs.existsSync(path.join(installDir, 'teach.config.json')));
  assert.ok(!fs.existsSync(path.join(installDir, 'docs', '.metadata.json')));

  // 二次启动：不重复迁移（数据文件不被覆盖改写、不再产生新留底）
  const kbBefore = fs.readFileSync(path.join(dataDir, 'knowledge.config.json'), 'utf-8');
  srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  await srv.stop();
  assert.equal(fs.readFileSync(path.join(dataDir, 'knowledge.config.json'), 'utf-8'), kbBefore, '二次启动不改写数据目录配置');
  assert.ok(!fs.existsSync(path.join(installDir, 'knowledge.config.json.migrated.bak.migrated.bak')), '不产生二次留底');
  assert.deepEqual(readJson(path.join(dataDir, 'knowledge.config.json')), knowledge, 'roots 仍在');
});

test('数据目录已有同名文件：跳过该项迁移（幂等，不覆盖、不动旧文件）', async t => {
  const base = mkTempDir('lanbook-ac4-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-ac4-data-');
  t.after(() => { removeInstallDir(installDir); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

  // 知识库配置：新旧冲突（应跳过）；课程配置：无冲突（应正常迁移）——逐项独立判定
  presetLegacyFiles(installDir, {
    knowledge: { roots: ['C:/legacy/old'] },
    teach: { roots: ['C:/legacy/teach'] },
  });
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: ['C:/fresh/new'] }, null, 2), 'utf-8');

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  assert.deepEqual(await srv.fetch('/api/knowledge/config').then(r => r.json()), { roots: ['C:/fresh/new'] }, '数据目录已有配置原样生效');
  await srv.stop();

  // 冲突项：数据文件未被覆盖，旧文件原地不动（不拷贝也不改名）
  assert.deepEqual(readJson(path.join(dataDir, 'knowledge.config.json')), { roots: ['C:/fresh/new'] });
  assert.deepEqual(readJson(path.join(installDir, 'knowledge.config.json')), { roots: ['C:/legacy/old'] }, '旧文件保留原名，未被改名');
  // 无冲突项照常迁移
  assert.deepEqual(readJson(path.join(dataDir, 'teach.config.json')), { roots: ['C:/legacy/teach'] });
  assert.ok(fs.existsSync(path.join(installDir, 'teach.config.json.migrated.bak')));
});

test('配置 API 读写数据目录新位置，写回后重启仍在', async t => {
  const base = mkTempDir('lanbook-ac5-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-ac5-data-');
  t.after(() => { removeInstallDir(installDir); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

  let srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  await srv.fetch('/api/knowledge/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: ['C:/persist/kb'], excludeDirs: ['drafts'] }),
  }).then(r => assert.equal(r.status, 200));
  await srv.fetch('/api/courses/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: ['C:/persist/teach'] }),
  }).then(r => assert.equal(r.status, 200));
  await srv.stop();

  // 落盘位置在数据目录，安装目录无配置文件
  assert.deepEqual(readJson(path.join(dataDir, 'knowledge.config.json')), { roots: ['C:/persist/kb'], excludeDirs: ['drafts'] });
  assert.ok(!fs.existsSync(path.join(installDir, 'knowledge.config.json')));

  // 重启后仍读得到
  srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  assert.deepEqual(await srv.fetch('/api/knowledge/config').then(r => r.json()), { roots: ['C:/persist/kb'], excludeDirs: ['drafts'] });
  assert.deepEqual(await srv.fetch('/api/courses/config').then(r => r.json()), { roots: ['C:/persist/teach'] });
  await srv.stop();
});

test('/kb、/api/*、/teach/* 行为回归不变（读写全部走数据目录）', async t => {
  const base = mkTempDir('lanbook-ac6-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-ac6-data-');

  // 知识库 fixture：根目录下 proj/hello.md + proj/sub/deep.md
  const kbRoot = path.join(base, 'kbroot');
  fs.mkdirSync(path.join(kbRoot, 'proj', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(kbRoot, 'proj', 'hello.md'), '# Hello\n\n世界', 'utf-8');
  fs.writeFileSync(path.join(kbRoot, 'proj', 'sub', 'deep.md'), '# Deep', 'utf-8');
  // 课程 fixture：workspace 含 lessons / reference / assets
  const teachRoot = path.join(base, 'teachroot');
  fs.mkdirSync(path.join(teachRoot, 'ws-demo', 'lessons'), { recursive: true });
  fs.mkdirSync(path.join(teachRoot, 'ws-demo', 'reference'), { recursive: true });
  fs.mkdirSync(path.join(teachRoot, 'ws-demo', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(teachRoot, 'ws-demo', 'lessons', '0001.html'), '<html><head><title>L1</title><link rel="stylesheet" href="../assets/style.css"></head><body>Lesson 1</body></html>', 'utf-8');
  fs.writeFileSync(path.join(teachRoot, 'ws-demo', 'reference', 'cheat.html'), '<html><body>Cheat</body></html>', 'utf-8');
  fs.writeFileSync(path.join(teachRoot, 'ws-demo', 'assets', 'style.css'), 'body{color:red}', 'utf-8');
  t.after(() => { removeInstallDir(installDir); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  // 通过配置 API 挂载两个根目录（写入数据目录）
  await srv.fetch('/api/knowledge/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: [kbRoot.replace(/\\/g, '/')] }),
  }).then(r => assert.equal(r.status, 200));
  await srv.fetch('/api/courses/config', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: [teachRoot.replace(/\\/g, '/')] }),
  }).then(r => assert.equal(r.status, 200));

  // /kb 系列（路径首段为 root 目录名，与 1.1 契约一致）
  const kbList = await srv.fetch('/kb').then(r => { assert.equal(r.status, 200); return r.text(); });
  assert.ok(kbList.includes('/kb/kbroot/proj/hello.md'), '/kb 列表包含文档路径');
  assert.ok(kbList.includes('/kb/kbroot/proj/sub/deep.md'));
  const projList = await srv.fetch('/kb/kbroot').then(r => r.text());
  assert.ok(projList.includes('/kb/kbroot/proj/hello.md'));
  const raw = await srv.fetch('/kb/kbroot/proj/hello.md').then(r => { assert.equal(r.status, 200); return r.text(); });
  assert.equal(raw, '# Hello\n\n世界');
  assert.equal(await srv.fetch('/kb/nope').then(r => r.status), 404);

  // /api/knowledge 系列
  const tree = await srv.fetch('/api/knowledge').then(r => r.json());
  assert.equal(tree.roots[0].name, 'kbroot');
  const proj = tree.roots[0].children.find(c => c.name === 'proj');
  assert.ok(proj, '树里含 proj 目录');
  assert.ok(proj.children.some(f => f.type === 'file' && f.name === 'hello.md'));
  const doc = await srv.fetch(`/api/knowledge/file?root=${encodeURIComponent(kbRoot.replace(/\\/g, '/'))}&path=proj/hello.md`).then(r => r.json());
  assert.equal(doc.content, '# Hello\n\n世界');
  const view = await srv.fetch(`/api/knowledge/view?root=${encodeURIComponent(kbRoot.replace(/\\/g, '/'))}&path=proj/hello.md`).then(r => r.text());
  assert.ok(view.includes('Hello') && view.includes('<h1>'), '渲染页输出 HTML');
  const kbfile = await srv.fetch('/kbfile/0/proj/hello.md').then(r => { assert.equal(r.status, 200); return r.text(); });
  assert.equal(kbfile, '# Hello\n\n世界');

  // /api/courses + /teach 静态托管（目录树整体托管，相对引用可用）
  const courses = await srv.fetch('/api/courses').then(r => r.json());
  const ws = courses.workspaces.find(w => w.id === 'ws-demo');
  assert.ok(ws, '课程列表含 ws-demo');
  assert.equal(ws.lessons[0].file, '0001.html');
  assert.equal(ws.lessons[0].title, 'L1');
  assert.equal(ws.reference[0].file, 'cheat.html');
  const lesson = await srv.fetch('/teach/ws-demo/lessons/0001.html').then(r => { assert.equal(r.status, 200); return r.text(); });
  assert.ok(lesson.includes('Lesson 1'));
  const css = await srv.fetch('/teach/ws-demo/assets/style.css').then(r => { assert.equal(r.status, 200); return r.text(); });
  assert.equal(css, 'body{color:red}');
  assert.equal(await srv.fetch('/teach/ws-demo/lessons/none.html').then(r => r.status), 404);

  // /api/files 对话文件 CRUD（落在数据目录的 docs/）
  assert.deepEqual(await srv.fetch('/api/files').then(r => r.json()), { groups: [], folderGroups: [], files: [] }, '初始为空');
  await srv.fetch('/api/files', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'n1.md', content: '# First' }),
  }).then(r => assert.equal(r.status, 201));
  const filesList = await srv.fetch('/api/files').then(r => r.json());
  assert.equal(filesList.files[0].name, 'n1.md');
  assert.equal(filesList.files[0].title, 'First');
  await srv.fetch('/api/files/n1.md', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: '# Second' }),
  }).then(r => assert.equal(r.status, 200));
  assert.equal(await srv.fetch('/api/files/n1.md').then(r => r.json()).then(j => j.content), '# Second');
  await srv.fetch('/api/files/n1.md', { method: 'DELETE' }).then(r => assert.equal(r.status, 200));
  assert.deepEqual(await srv.fetch('/api/files').then(r => r.json()), { groups: [], folderGroups: [], files: [] });
  await srv.stop();
});
