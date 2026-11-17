'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const chokidar = require('chokidar');
const { createCourseService } = require('../lib/courses');
const { createKnowledgeService } = require('../lib/knowledge');
const { sleep } = require('./helpers');

function write(root, rel, text = '<title>Lesson</title>') {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
async function waitFor(fn, label, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!await fn()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(30);
  }
}
function setup(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'course-service-'));
  const root = path.join(base, 'courses');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(root); fs.mkdirSync(dataDir);
  const messages = [];
  const logs = [];
  const resolveRoot = p => path.resolve(p);
  const knowledge = createKnowledgeService({ dataDir, baseDir: base, resolveRoot });
  const service = createCourseService({ dataDir, resolveRoot, knowledge,
    logger: { log: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) },
    onChange: event => messages.push(event), debounceMs: 40, ...options,
  });
  service.writeConfig({ roots: [root] });
  t.after(async () => { await service.close(); knowledge.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, root, dataDir, service, messages, logs };
}

test('热列表/资源定位共用索引：并发冷请求只扫描一次，热路径零重扫', async t => {
  const { root, service } = setup(t);
  write(root, 'a/lessons/one.html');
  write(root, 'a/assets/course.css', 'body{}');
  const [first, ...others] = await Promise.all(Array.from({ length: 12 }, () => service.list()));
  for (const rows of others) assert.deepEqual(rows, first);
  assert.equal(first.length, 1);
  for (let n = 0; n < 20; n++) {
    assert.deepEqual(await service.list(), first);
    assert.equal((await service.workspace('a')).path, path.join(root, 'a'));
  }
  assert.equal(service.diagnostics().discoveries, 1);
  assert.equal(service.diagnostics().rebuilds, 1);
  assert.equal(service.diagnostics().maxActiveScans, 1);
  assert.equal(service.diagnostics().cachedTitles, 1);
});

test('真实 watcher：HTML/MISSION/CSS 编辑合并刷新；不重扫课程根目录', async t => {
  let ready;
  const readyPromise = new Promise(r => { ready = r; });
  const { root, service, messages } = setup(t, {
    watch(paths, options) { const w = chokidar.watch(paths, options); w.once('ready', ready); return w; },
  });
  const lesson = write(root, 'a/lessons/one.html');
  const css = write(root, 'a/assets/course.css', 'body{}');
  const mission = write(root, 'a/MISSION.md', '# Mission: Original');
  await service.start(); await readyPromise;
  const before = service.diagnostics();
  fs.writeFileSync(lesson, '<title>Edited lesson</title>');
  fs.writeFileSync(mission, '# Mission: Edited mission');
  await waitFor(async () => (await service.list())[0]?.title === 'Edited mission', 'MISSION refresh');
  assert.equal((await service.list())[0].lessons[0].title, 'Edited lesson');
  assert.equal(service.diagnostics().discoveries, before.discoveries);
  assert.equal(messages.at(-1).type, 'course-change');
  const notifications = messages.length;
  fs.writeFileSync(css, 'body{color:red}');
  await waitFor(() => messages.length > notifications, 'CSS notification');
  assert.equal(service.diagnostics().discoveries, before.discoveries);
  assert.equal(service.diagnostics().watchers, 1);
});

test('定期异步发现新增/删除课程与缺失根恢复；空闲不广播，不累积日志/标题', async t => {
  const { root, service, messages, logs } = setup(t, { discoveryIntervalMs: 80 });
  await service.start();
  write(root, 'a/lessons/one.html');
  await waitFor(async () => (await service.list()).length === 1, 'new workspace');
  const changes = messages.length;
  const logCount = logs.length;
  const scans = service.diagnostics().discoveries;
  await waitFor(() => service.diagnostics().discoveries >= scans + 2, 'idle discoveries', 10000);
  assert.equal(messages.length, changes, '空闲发现不能反复刷新 iframe');
  assert.equal(logs.length, logCount, '空闲周期不逐次写日志');
  fs.rmSync(root, { recursive: true });
  await waitFor(async () => (await service.list()).length === 0, 'removed root');
  assert.equal(service.diagnostics().cachedTitles, 0);
  write(root, 'restored/lessons/one.html');
  await waitFor(async () => (await service.list())[0]?.id === 'restored', 'restored root');
});

test('重复/重叠根不重复收录；根自带 lessons 不吞掉子项目课程；排除策略一致', async t => {
  const { root, service } = setup(t);
  write(root, 'a/.scratch/teach/lessons/one.html');
  write(root, 'a/.scratch/worktree-archive/day/copy/teach/lessons/one.html');
  write(root, 'lessons/root-lesson.html');
  service.writeConfig({ roots: [root, path.join(root, 'a'), root] });
  assert.equal((await service.list()).length, 1);
  assert.deepEqual((await service.preview([root]))[0].workspaces, ['a/.scratch/teach']);
});

test('配置容器先于父根时不吞掉其作为子工作区的课程', async t => {
  const { root, service } = setup(t);
  write(root, 'teach/lessons/one.html');
  const direct = path.join(root, 'teach');
  for (const roots of [[direct, root], [root, direct]]) {
    service.writeConfig({ roots });
    await service.refresh();
    assert.equal((await service.list()).length, 1);
    const preview = await service.preview(roots);
    assert.deepEqual(preview.find(p => p.root === root).workspaces, ['teach']);
  }
});

test('发现扫描在飞时的 CSS 通知跨失效/重试保留，不被相同列表签名吞掉', async t => {
  let emitter;
  const { root, service, messages } = setup(t, {
    watch() { emitter = new EventEmitter(); emitter.close = async () => {}; return emitter; },
  });
  write(root, 'a/lessons/one.html');
  const css = write(root, 'a/assets/course.css', 'body{}');
  await service.start();
  const opendir = fs.promises.opendir;
  let release;
  let entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  let paused = false;
  fs.promises.opendir = async function(dir, ...args) {
    if (dir === root && !paused) { paused = true; entered(); await gate; }
    return opendir.call(this, dir, ...args);
  };
  try {
    const rebuilding = service.refresh();
    await started;
    fs.writeFileSync(css, 'body{color:red}');
    emitter.emit('all', 'change', css);
    await sleep(100); // 越过生产去抖窗口，使事件与在飞发现合流。
    release();
    await rebuilding;
    assert.equal(messages.length, 1, '资源编辑必须广播，即便重试仍是发现且列表签名未变');
    assert.equal(messages[0].event, 'change');
  } finally { release(); fs.promises.opendir = opendir; }
});

test('同名课程删除/新增后，存活课程 ID 不变，根移除释放缓存', async t => {
  const { root, service } = setup(t);
  write(root, 'a/teach/lessons/one.html', '<title>A</title>');
  write(root, 'b/teach/lessons/one.html', '<title>B</title>');
  const before = await service.list();
  const survivor = before.find(w => w.lessons[0].title === 'B');
  fs.rmSync(path.join(root, 'a'), { recursive: true });
  write(root, 'c/teach/lessons/one.html', '<title>C</title>');
  await service.refresh();
  const after = await service.list();
  assert.equal(after.find(w => w.lessons[0].title === 'B').id, survivor.id);
  assert.equal(new Set(after.map(w => w.id)).size, 2);
  service.writeConfig({ roots: [] });
  await service.refresh();
  assert.deepEqual(await service.list(), []);
  assert.equal(service.diagnostics().cachedTitles, 0);
  assert.equal(service.diagnostics().watchers, 0);
});

test('配置在扫描中变更不会被旧结果覆盖；重复配置刷新最多一个 watcher', async t => {
  let live = 0;
  let peak = 0;
  let closes = 0;
  const { root, base, service } = setup(t, {
    watch() {
      const w = new EventEmitter();
      live++; peak = Math.max(peak, live);
      w.close = async () => { await sleep(5); live--; closes++; };
      return w;
    },
  });
  write(root, 'old/lessons/one.html');
  const other = path.join(base, 'other');
  write(other, 'new/lessons/one.html');
  const first = service.start();
  service.writeConfig({ roots: [other] });
  await Promise.all([first, service.refresh()]);
  assert.equal((await service.list())[0].name, 'new');
  for (let i = 0; i < 4; i++) {
    service.writeConfig({ roots: [i % 2 ? root : other] });
    await service.refresh();
  }
  assert.equal(peak, 1);
  assert.ok(closes >= 2);
  await service.close();
  assert.equal(live, 0);
  assert.equal(service.diagnostics().timers, 0);
  assert.equal(service.diagnostics().cachedTitles, 0);
});

test('遍历/缓存预算超限明确报错并保留上次快照；失败后能够恢复', async t => {
  const { root, service, logs } = setup(t, { limits: { files: 3 } });
  write(root, 'a/lessons/one.html');
  const original = await service.list();
  write(root, 'a/lessons/two.html');
  write(root, 'a/lessons/three.html');
  await assert.rejects(service.refresh(), /文件预算/);
  assert.deepEqual(await service.list(), original);
  assert.ok(service.diagnostics().cachedTitles <= 3);
  const errorCount = logs.filter(a => String(a[0]).includes('失败')).length;
  await assert.rejects(service.refresh(), /文件预算/);
  assert.equal(logs.filter(a => String(a[0]).includes('失败')).length, errorCount, '相同错误不刷屏');
  fs.unlinkSync(path.join(root, 'a/lessons/three.html'));
  await service.refresh();
  assert.equal((await service.list())[0].lessons.length, 2);
});

test('watcher 目录/文件准入有硬上限；关闭撤销定时器和待执行重建', async t => {
  let options;
  let emitter;
  const { root, service } = setup(t, {
    limits: { watchDirectories: 2, watchFiles: 2 },
    watch(paths, opts) { options = opts; emitter = new EventEmitter(); emitter.close = async () => {}; return emitter; },
  });
  write(root, 'a/lessons/one.html');
  await service.start();
  const dirStat = { isDirectory: () => true, isSymbolicLink: () => false };
  const fileStat = { isDirectory: () => false, isSymbolicLink: () => false };
  for (let n = 0; n < 20; n++) {
    options.ignored(path.join(root, 'a', `dir-${n}`), dirStat);
    options.ignored(path.join(root, 'a', `file-${n}.html`), fileStat);
  }
  assert.equal(service.diagnostics().watchDirectories, 2);
  assert.equal(service.diagnostics().watchFiles, 2);
  assert.equal(options.followSymlinks, false);
  assert.equal(options.usePolling, false);
  emitter.emit('all', 'change', path.join(root, 'a/lessons/one.html'));
  const scans = service.diagnostics().rebuilds;
  await service.close();
  await sleep(100);
  assert.equal(service.diagnostics().rebuilds, scans);
  assert.equal(service.diagnostics().watchers, 0);
  assert.equal(service.diagnostics().timers, 0);
  assert.equal(service.diagnostics().watchDirectories, 0);
  assert.equal(service.diagnostics().activeScans, 0);
});

test('真实 watcher 在大量子目录上仍受预算约束，标题缓存不保留超长正文', async t => {
  let actual;
  let ready;
  const readyPromise = new Promise(r => { ready = r; });
  const { root, service, logs } = setup(t, {
    limits: { watchDirectories: 4, watchFiles: 4 },
    watch(paths, opts) { actual = chokidar.watch(paths, opts); actual.once('ready', ready); return actual; },
  });
  write(root, 'a/lessons/one.html', `<title>${'T'.repeat(4000)}</title>${'B'.repeat(1000000)}`);
  for (let n = 0; n < 30; n++) write(root, `a/nested-${n}/some.html`);
  await service.start(); await readyPromise;
  assert.ok(service.diagnostics().watchDirectories <= 4);
  assert.ok(service.diagnostics().watchFiles <= 4);
  assert.ok(Object.keys(actual.getWatched()).length <= 5, 'chokidar 实际监听目录也须有界（含一个父目录）');
  assert.equal((await service.list())[0].lessons[0].title.length, 512);
  assert.equal(service.diagnostics().cachedTitles, 1);
  assert.equal(logs.filter(a => String(a[0]).includes('监听预算')).length, 1);
});

test('周期发现回收从未实际监听成功、也没有 unlink 事件的预算预留', async t => {
  const instances = [];
  const { root, service } = setup(t, {
    limits: { watchFiles: 1 },
    watch(paths, options) { const w = new EventEmitter(); w.close = async () => {}; instances.push({ w, options }); return w; },
  });
  write(root, 'a/lessons/one.html');
  await service.start();
  const phantom = write(root, 'a/assets/gone.css');
  assert.equal(instances[0].options.ignored(phantom, fs.statSync(phantom)), false);
  fs.unlinkSync(phantom);
  const live = write(root, 'a/assets/live.css');
  assert.equal(instances[0].options.ignored(live, fs.statSync(live)), true);
  await service.refresh(); // 与定期发现同入口
  assert.equal(instances.length, 2);
  assert.equal(instances[1].options.ignored(live, fs.statSync(live)), false);
});

test('旧 watcher 关闭失败后不新建重叠 watcher，索引仍可更新', async t => {
  let creations = 0;
  let closeCalls = 0;
  const { root, base, service } = setup(t, {
    watch() {
      creations++;
      const w = new EventEmitter();
      w.close = async () => { if (++closeCalls === 1) throw new Error('close failed'); };
      return w;
    },
  });
  write(root, 'a/lessons/one.html');
  await service.start();
  const next = path.join(base, 'next');
  write(next, 'b/lessons/one.html');
  service.writeConfig({ roots: [next] });
  await service.refresh();
  assert.equal((await service.list())[0].id, 'b');
  await service.refresh();
  assert.equal(creations, 1, '无法确认关闭成功时不得重建监听');
});

test('在飞扫描关闭后不会创建 watcher 或后台定时器', async t => {
  let creations = 0;
  const { root, service } = setup(t, { watch() { creations++; return new EventEmitter(); } });
  write(root, 'a/lessons/one.html');
  const start = service.start();
  await service.close();
  await Promise.allSettled([start]);
  assert.equal(creations, 0);
  assert.equal(service.diagnostics().timers, 0);
  assert.equal(service.diagnostics().activeScans, 0);
});
