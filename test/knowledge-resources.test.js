'use strict';
// Real service, real filesystem/watcher; small boundary doubles only for close races
// and a deterministic 60s demand-refresh clock. No production HTTP test hooks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const chokidar = require('chokidar');
const { createKnowledgeService } = require('../lib/knowledge');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t, resourceLimits) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-resources-'));
  const root = path.join(base, 'notes');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(root); fs.mkdirSync(dataDir);
  const service = createKnowledgeService({ dataDir, baseDir: base, resolveRoot: p => path.resolve(p), resourceLimits });
  service.writeConfig({ roots: [root] });
  t.after(async () => { await service.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const doc = (rel, title = rel) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${title}\n\nBody must not be cached.`);
    return file;
  };
  return { base, root, service, doc };
}
function titles(roots) {
  const result = {};
  const walk = nodes => { for (const n of nodes) { if (n.type === 'file') result[n.name] = n.title; else walk(n.children); } };
  for (const root of roots) walk(root.children);
  return result;
}
async function waitFor(fn) {
  const end = Date.now() + 5000;
  while (!fn()) { assert.ok(Date.now() < end, 'watcher condition timed out'); await sleep(25); }
}
function observeWatcher(t) {
  const instances = [];
  const add = chokidar.FSWatcher.prototype.add;
  t.mock.method(chokidar.FSWatcher.prototype, 'add', function(...args) {
    if (!instances.includes(this)) {
      this.resourceTestReady = once(this, 'ready');
      instances.push(this);
    }
    return add.apply(this, args);
  });
  return instances;
}
const ignoredBy = w => Array.isArray(w.options.ignored) ? w.options.ignored.find(p => typeof p === 'function') : w.options.ignored;
function fakeWatchers(t, closeImpl = () => Promise.resolve()) {
  const instances = [];
  t.mock.method(chokidar.FSWatcher.prototype, 'add', function(paths) {
    this.paths = paths;
    instances.push(this);
    return this;
  });
  t.mock.method(chokidar.FSWatcher.prototype, 'close', function() { return closeImpl(this); });
  return instances;
}

test('resource defaults exclude worktree-archive but preserve .scratch', async t => {
  const { service, root, doc } = fixture(t);
  doc('worktree-archive/old.md'); doc('.scratch/report.md');
  assert.equal(service.getExcludedSet().has('worktree-archive'), true);
  assert.equal(service.isWatcherIgnored(path.join(root, 'worktree-archive', 'old.md')), true);
  assert.equal(service.isWatcherIgnored(path.join(root, '.scratch', 'report.md')), false);
  assert.deepEqual(Object.keys(titles(await service.discover())), ['report.md']);
});

test('scanTree has bounded asynchronous IO and preserves directory/file ordering and titles', async t => {
  const { service, doc } = fixture(t);
  for (let d = 11; d >= 0; d--) for (let f = 3; f >= 0; f--) doc(`dir-${String(d).padStart(2, '0')}/${f}.md`, `${d}/${f}`);
  let active = 0, peak = 0;
  for (const name of ['readdir', 'stat', 'readFile']) {
    const original = fs.promises[name];
    t.mock.method(fs.promises, name, async (...args) => {
      peak = Math.max(peak, ++active);
      try { await tick(); return await original(...args); } finally { active--; }
    });
  }
  const tree = await service.discover();
  assert.equal(peak, 1, 'recursive directory fanout must not create unbounded IO');
  assert.deepEqual(tree[0].children.map(n => n.name), Array.from({ length: 12 }, (_, d) => `dir-${String(d).padStart(2, '0')}`));
  assert.deepEqual(tree[0].children[0].children.map(n => n.title), ['0/0', '0/1', '0/2', '0/3']);
});

test('title cache evicts deleted files and removed roots; FIFO cap never hides documents', async t => {
  const { service, root, base, doc } = fixture(t, { titleCacheEntries: 2 });
  const a = doc('a.md', 'A'), b = doc('b.md', 'B');
  const reads = new Map();
  const readFile = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', async (file, ...args) => {
    reads.set(file, (reads.get(file) || 0) + 1);
    return readFile.call(fs.promises, file, ...args);
  });
  await service.discover();
  const parked = path.join(base, 'parked.md');
  fs.renameSync(b, parked);
  service.refreshTreeCache(); await service.discover();
  fs.renameSync(parked, b); // exactly the same mtime: must miss the pruned entry
  service.refreshTreeCache(); await service.discover();
  assert.equal(reads.get(b), 2, 'deleted cache entry must be reclaimed');
  service.writeConfig({ roots: [] }); await service.discover();
  service.writeConfig({ roots: [root] }); await service.discover();
  assert.equal(reads.get(a), 2, 'removed root must not retain cached titles');
  doc('c.md', 'C');
  service.refreshTreeCache();
  assert.deepEqual(titles(await service.discover()), { 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' });
  service.refreshTreeCache(); await service.discover();
  assert.equal(reads.get(a), 3, 'oldest title is evicted when the cap is exceeded');
});

test('oversized Markdown/HTML titles are returned intact but never cached', async t => {
  const { service, root, doc } = fixture(t);
  const longTitle = 'T'.repeat(1024);
  doc('long.md', longTitle); doc('short.md', 'short');
  fs.writeFileSync(path.join(root, 'long.html'), `<title>${longTitle}</title><p>body</p>`);
  const reads = new Map();
  const readFile = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', (file, ...args) => {
    reads.set(path.basename(file), (reads.get(path.basename(file)) || 0) + 1);
    return readFile.call(fs.promises, file, ...args);
  });
  const expected = { 'long.md': longTitle, 'long.html': longTitle, 'short.md': 'short' };
  assert.deepEqual(titles(await service.discover()), expected);
  service.refreshTreeCache();
  assert.deepEqual(titles(await service.discover()), expected);
  assert.equal(reads.get('long.md'), 2);
  assert.equal(reads.get('long.html'), 2);
  assert.equal(reads.get('short.md'), 1);
});

test('cached short titles do not retain complete document bodies through V8 sliced strings', () => {
  const { spawnSync } = require('node:child_process');
  const child = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, 'fixtures/title-retention.cjs')], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const sample = child.stdout.split(/\r?\n/).find(line => line.startsWith('{'));
  const metrics = JSON.parse(sample);
  assert.equal(metrics.pass, true);
  assert.ok(metrics.retainedHeapDelta < metrics.budget);
});

test('磁盘根目录允许子路径监听，并归并同盘内已配置子根', async t => {
  const { service, root, doc } = fixture(t);
  const note = doc('root-watch.md');
  const diskRoot = path.parse(root).root;
  const instances = fakeWatchers(t); // 只检查真实准入策略，不实际监听整块磁盘。
  service.writeConfig({ roots: [diskRoot] });
  service.refreshWatcher(); await tick();
  assert.equal(ignoredBy(instances[0])(note, fs.statSync(note)), false, '磁盘根下的文档不能被排除');
  assert.equal(ignoredBy(instances[0])(root, fs.statSync(root)), false, '磁盘根下的目录不能被排除');
  service.writeConfig({ roots: [diskRoot, root] });
  service.refreshWatcher(); await tick();
  assert.deepEqual(instances.at(-1).paths, [path.resolve(diskRoot)], '父根是磁盘根时也应吸收子根');
});

test('real watcher enforces directory budget, skips links, and never polls', async t => {
  const { service, root, doc } = fixture(t, { watcherDirectories: 3, watcherDocuments: 100 });
  // A directory with a document suffix still consumes directory, not file budget.
  for (let i = 0; i < 8; i++) doc(`dir-${i}.md/note.md`);
  const link = path.join(root, 'cycle');
  fs.symlinkSync(root, link, 'junction');
  t.after(() => { if (fs.existsSync(link)) fs.unlinkSync(link); });
  const instances = observeWatcher(t);
  service.refreshWatcher(); await tick();
  assert.equal(instances.length, 1);
  const w = instances[0]; await w.resourceTestReady;
  assert.equal(w.options.followSymlinks, false);
  assert.equal(w.options.usePolling, false);
  assert.equal(w.options.awaitWriteFinish, false);
  const dirs = Object.keys(w.getWatched()).filter(p => p === root || p.startsWith(root + path.sep));
  assert.ok(dirs.length <= 3, `watched directories: ${dirs}`);
  assert.equal(dirs.some(p => p.includes('cycle')), false);
  for (let i = 0; i < 20; i++) assert.equal(ignoredBy(w)(dirs[0], fs.statSync(dirs[0])), false);
  const removed = once(w, 'unlinkDir');
  fs.rmSync(dirs.find(p => p !== root), { recursive: true });
  await removed;
  doc('replacement.md/note.md');
  await waitFor(() => Object.keys(w.getWatched()).some(p => p.startsWith(root + path.sep) && !dirs.includes(p)));
  // Chokidar can retain an empty getWatched() bookkeeping entry for a removed
  // directory; it has no live watcher. Count remaining on-disk directories.
  const after = Object.keys(w.getWatched()).filter(p => (p === root || p.startsWith(root + path.sep)) && fs.existsSync(p));
  assert.ok(after.length <= 3, JSON.stringify(w.getWatched()));
});

test('real watcher document budget is idempotent and unlink returns capacity', async t => {
  const { service, root, doc } = fixture(t, { watcherDirectories: 4, watcherDocuments: 2 });
  for (const n of ['a.md', 'b.md', 'c.md']) doc(n);
  const warnings = [];
  t.mock.method(console, 'warn', m => warnings.push(m));
  const instances = observeWatcher(t);
  service.refreshWatcher(); await tick();
  const w = instances[0]; await w.resourceTestReady;
  const watched = () => (w.getWatched()[root] || []).filter(n => n.endsWith('.md'));
  assert.equal(watched().length, 2);
  const initiallyWatched = watched();
  const admitted = path.join(root, initiallyWatched[0]);
  for (let i = 0; i < 30; i++) assert.equal(ignoredBy(w)(admitted, fs.statSync(admitted)), false);
  const removed = once(w, 'unlink');
  fs.unlinkSync(admitted); await removed;
  doc('new.md');
  // A formerly rejected c.md can claim the freed slot before new.md does.
  await waitFor(() => watched().some(n => !initiallyWatched.includes(n)));
  assert.ok(watched().length <= 2);
  assert.equal(warnings.length, 1, 'rejected paths must not repeatedly warn');
  assert.match(warnings[0], /60s|60秒/);
});

test('only overflow enables 60s demand refresh; idle does not scan and requests single-flight', async t => {
  const { service, root, doc } = fixture(t, { watcherDirectories: 1, watcherDocuments: 1 });
  const a = doc('a.md', 'before'); const b = doc('b.md', 'overflow');
  const instances = fakeWatchers(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let scans = 0;
  const readdir = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', (...args) => { scans++; return readdir.call(fs.promises, ...args); });
  const warnings = [];
  t.mock.method(console, 'warn', m => warnings.push(m));
  service.refreshWatcher(); await tick();
  const ignored = ignoredBy(instances[0]);
  ignored(root, fs.statSync(root)); ignored(a, fs.statSync(a));
  await service.discover();
  now += 61000;
  await service.discover();
  assert.equal(scans, 1, 'normal watcher must not expire the tree by age');
  for (let i = 0; i < 20; i++) ignored(b, fs.statSync(b));
  doc('b.md', 'updated outside budget');
  now -= 61000;
  assert.equal(titles(await service.discover())['b.md'], 'overflow', 'not yet due');
  now += 61000;
  await sleep(50);
  assert.equal(scans, 1, 'no idle scan timer');
  const results = await Promise.all(Array.from({ length: 12 }, () => service.discover()));
  for (const tree of results) assert.equal(titles(tree)['b.md'], 'updated outside budget');
  assert.equal(scans, 2, 'due requests share exactly one rebuild');
  await service.discover(); assert.equal(scans, 2);
  assert.equal(warnings.length, 1);
});

test('overflow demand refresh recycles reservations for files deleted before watcher admission', async t => {
  const { service, root, doc } = fixture(t, { watcherDirectories: 3, watcherDocuments: 1 });
  const instances = fakeWatchers(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  service.refreshWatcher(); await tick();
  const phantom = doc('gone.md');
  const first = ignoredBy(instances[0]);
  assert.equal(first(phantom, fs.statSync(phantom)), false);
  fs.unlinkSync(phantom); // deleted before an actual watcher exists: no unlink event
  const live = doc('live.md');
  assert.equal(first(live, fs.statSync(live)), true);
  await service.discover();
  now += 61000;
  await service.discover(); await tick();
  assert.equal(instances.length, 2, 'degraded demand refresh must reconcile reservations');
  assert.equal(ignoredBy(instances[1])(live, fs.statSync(live)), false);
});

test('unreadable documents do not reserve budget before chokidar rejects their permissions', async t => {
  const { service, doc } = fixture(t, { watcherDirectories: 3, watcherDocuments: 1 });
  const instances = fakeWatchers(t);
  service.refreshWatcher(); await tick();
  const unreadable = doc('unreadable.md'), readable = doc('readable.md');
  const stat = Object.create(fs.statSync(unreadable));
  stat.mode &= ~0o400; // mirror chokidar _hasReadPermissions without platform-specific chmod
  const ignored = ignoredBy(instances[0]);
  assert.equal(ignored(unreadable, stat), true);
  assert.equal(ignored(readable, fs.statSync(readable)), false);
});

test('presence probe crossing a completed rebuild reuses the new snapshot without another scan', async t => {
  const { service, root, doc } = fixture(t);
  doc('a.md', 'before');
  let scans = 0;
  const readdir = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', (...args) => { scans++; return readdir.call(fs.promises, ...args); });
  await service.discover();
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const stat = fs.promises.stat;
  let gated = false;
  t.mock.method(fs.promises, 'stat', async (p, ...args) => {
    if (p === root && !gated) { gated = true; entered.resolve(); await release.promise; }
    return stat.call(fs.promises, p, ...args);
  });
  const delayed = service.discover(); await entered.promise;
  doc('a.md', 'after'); service.refreshTreeCache();
  assert.equal(titles(await service.discover())['a.md'], 'after');
  release.resolve();
  assert.equal(titles(await delayed)['a.md'], 'after');
  assert.equal(scans, 2, 'initial + explicit rebuild only; delayed probe must not start a third scan');
});

test('refresh coalesces latest config, awaits old close, and close forbids resurrection', async t => {
  const closing = deferred(), closingSecond = deferred();
  t.after(() => { closing.resolve(); closingSecond.resolve(); });
  const { service, root } = fixture(t);
  let closeCalls = 0;
  const instances = fakeWatchers(t, () => { closeCalls++; return closeCalls === 1 ? closing.promise : closingSecond.promise; });
  service.refreshWatcher(); await tick();
  service.refreshWatcher(); await tick();
  for (let i = 0; i < 40; i++) {
    service.writeConfig({ roots: [path.join(root, String(i))] });
    assert.equal(service.refreshWatcher(), undefined, 'legacy synchronous return');
  }
  assert.equal(instances.length, 1, 'must await the old watcher');
  closing.resolve(); await tick();
  assert.equal(instances.length, 2, 'latest config must coalesce, not queue 40 watchers');
  assert.deepEqual(instances[1].paths, [path.join(root, '39')]);
  assert.equal(closeCalls, 1);
  service.refreshWatcher(); await tick();
  let finished = false;
  const shutdown = service.close().then(() => { finished = true; });
  await tick(); assert.equal(finished, false, 'close must join the in-flight watcher close');
  closingSecond.resolve(); await shutdown;
  service.refreshWatcher(); await tick();
  assert.equal(instances.length, 2, 'closed service must never create a watcher');
});

test('close cancels debounce and a rejected watcher close is handled for sync callers', async t => {
  const { service, doc } = fixture(t);
  const instances = fakeWatchers(t, () => Promise.reject(new Error('close failure')));
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  let scans = 0;
  const readdir = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', (...args) => { scans++; return readdir.call(fs.promises, ...args); });
  service.refreshWatcher(); await tick();
  instances[0].emit('all', 'change', doc('a.md'));
  service.refreshWatcher(); await tick();
  await service.close();
  await sleep(600);
  assert.equal(scans, 0, 'pending debounce must be cancelled');
  assert.equal(instances.length, 1, 'failed close must not overlap a new watcher');
  assert.ok(errors.length >= 1);
});

test('in-flight scan configuration drift retries latest roots; close stops further IO', async t => {
  const { service, root, base, doc } = fixture(t);
  doc('a.md');
  const other = path.join(base, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'b.md'), '# B');
  const entered = deferred(), release = deferred(), enteredAgain = deferred(), releaseAgain = deferred();
  let rootReads = 0;
  const readdir = fs.promises.readdir;
  t.mock.method(fs.promises, 'readdir', async (dir, ...args) => {
    if (dir === root) {
      if (++rootReads === 1) { entered.resolve(); await release.promise; }
      else { enteredAgain.resolve(); await releaseAgain.promise; }
    }
    return readdir.call(fs.promises, dir, ...args);
  });
  const flight = service.discover(); await entered.promise;
  service.writeConfig({ roots: [other] }); release.resolve();
  assert.deepEqual(titles(await flight), { 'b.md': 'B' });
  service.writeConfig({ roots: [root] });
  let documentReads = 0;
  const readFile = fs.promises.readFile;
  t.mock.method(fs.promises, 'readFile', (...args) => { documentReads++; return readFile.call(fs.promises, ...args); });
  const pending = service.discover(); await enteredAgain.promise;
  const shutdown = service.close(); releaseAgain.resolve();
  await shutdown; await pending;
  assert.equal(documentReads, 0, 'in-flight directory IO must not start file reads after close');
  assert.deepEqual(await service.discover(), []);
});
