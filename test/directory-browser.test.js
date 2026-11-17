'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, startServer, snapshotDir } = require('./helpers');

// Lazy require lets the real HTTP wiring test also go red before implementation.
const browser = options => require('../lib/directory-browser').createDirectoryBrowser(options);
const portable = p => process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
const canonical = p => portable(fs.realpathSync(p));
const query = (p, offset) => ({ path: p, ...(offset === undefined ? {} : { offset: String(offset) }) });
function temp(t) {
  const dir = mkTempDir('lanbook-directory-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const entry = (name, directory = true, link = false) => ({
  name, isDirectory: () => directory, isSymbolicLink: () => link,
});
function fakeIO(entries = [], overrides = {}) {
  const calls = { opens: [], reads: 0, closes: 0, realpaths: [] };
  return {
    calls,
    io: {
      async realpath(p) { calls.realpaths.push(p); return p; },
      async opendir(p, options) {
        calls.opens.push({ path: p, options });
        let index = 0;
        return {
          async read() { calls.reads++; return entries[index++] || null; },
          async close() { calls.closes++; },
        };
      },
      ...overrides,
    },
  };
}
const posixOptions = extra => ({ platform: 'linux', home: '/home/test', ...extra });
const status = code => err => err.status === code && typeof err.message === 'string' && err.message.length < 100;

test('real directories: sorted pages of 200; files and nested descendants never leak; no writes', async t => {
  const root = temp(t);
  const names = Array.from({ length: 405 }, (_, i) => `目录-${String(i).padStart(3, '0')}`);
  for (const name of [...names].reverse()) fs.mkdirSync(path.join(root, name));
  fs.mkdirSync(path.join(root, names[0], 'not-a-current-child'));
  fs.writeFileSync(path.join(root, 'SECRET.txt'), 'not returned');
  const before = snapshotDir(root);
  const service = browser({ home: root });
  const first = await service.list(query(root));
  assert.deepEqual(Object.keys(first).sort(), ['path', 'parent', 'home', 'locations', 'directories', 'offset', 'limit', 'hasMore', 'truncated'].sort());
  assert.equal(first.path, canonical(root));
  assert.equal(first.parent, portable(path.dirname(fs.realpathSync(root))));
  assert.equal(first.home, portable(path.resolve(root)));
  assert.equal(first.limit, 200);
  assert.equal(first.offset, 0);
  assert.equal(first.hasMore, true);
  assert.equal(first.truncated, false);
  const second = await service.list(query(root, 200));
  const last = await service.list(query(root, 400));
  assert.equal(second.directories.length, 200);
  assert.equal(second.hasMore, true);
  assert.equal(last.directories.length, 5);
  assert.equal(last.hasMore, false);
  const all = [...first.directories, ...second.directories, ...last.directories];
  assert.deepEqual(all.map(x => x.name), names.sort());
  assert.deepEqual(all.map(x => x.path), names.map(n => portable(path.join(fs.realpathSync(root), n))));
  assert.deepEqual((await service.list(query(root, 9999))).directories, []);
  assert.deepEqual(snapshotDir(root), before);
});

test('home default/empty, Chinese and apostrophes, deep and root paths', async t => {
  const root = temp(t);
  const deep = path.join(root, "中文'目录", ...Array.from({ length: 12 }, (_, i) => `深层${i}`));
  fs.mkdirSync(deep, { recursive: true });
  const service = browser({ home: root });
  assert.equal((await service.list()).path, canonical(root));
  assert.equal((await service.list({ path: '' })).path, canonical(root));
  assert.equal((await service.list(query(deep + path.sep + '.'))).path, canonical(deep));
  const diskRoot = path.parse(root).root;
  const result = await service.list(query(diskRoot));
  assert.equal(result.path, canonical(diskRoot));
  assert.equal(result.parent, null);
});

test('skip symlink/junction children and loops, but explicitly selected link resolves to target', async t => {
  const root = temp(t);
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.mkdirSync(path.join(target, 'child'));
  const link = path.join(root, 'linked');
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  fs.symlinkSync(root, path.join(root, 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
  const service = browser();
  assert.deepEqual((await service.list(query(root))).directories.map(x => x.name), ['target']);
  const selected = await service.list(query(link));
  assert.equal(selected.path, canonical(target));
  assert.deepEqual(selected.directories.map(x => x.name), ['child']);
});

test('invalid types, NUL, overlong, relative/drive-relative/UNC/device paths and offsets => 400 without IO', async () => {
  const { io, calls } = fakeIO();
  const service = browser(posixOptions({ io }));
  for (const p of [null, 1, [], {}, true, 'a', '.', '~/a', 'D:', 'D:foo', 'D:/foo', '/a\0b', '/' + 'a'.repeat(8192), '//server/share', '\\\\server\\share', '\\\\?\\C:\\', '\\\\.\\C:']) {
    await assert.rejects(service.list({ path: p }), status(400), String(p));
  }
  for (const offset of ['-1', '1.2', '1e2', 'NaN', '', ' 1', '9007199254740992', 0, null, [], {}]) {
    await assert.rejects(service.list({ path: '/tmp', offset }), status(400));
  }
  for (const q of [new URLSearchParams('path=/tmp&path=/tmp'), new URLSearchParams('offset=0&offset=1'), new URLSearchParams('x=1&x=2'), { path: ['/tmp', '/tmp'] }]) {
    await assert.rejects(service.list(q), status(400));
  }
  assert.equal(calls.realpaths.length, 0);
  assert.equal(calls.opens.length, 0);
});

test('Windows accepts only local absolute drive paths, including manual D:/; rejects resolved UNC before opendir', async () => {
  const { io, calls } = fakeIO();
  const service = browser({
    platform: 'win32', home: 'C:\\Users\\测试', io,
    getLocations: () => ['c:/users/测试', 'd:/', 'D:/', 'E:/配置', '//host/share'],
  });
  for (const p of ['D:/', 'd:\\中文\\..\\folder', 'C:/a/../']) {
    const result = await service.list(query(p));
    assert.equal(result.path, path.win32.normalize(p).replace(/\\/g, '/'));
    assert.ok(result.locations.some(x => x.path.toLowerCase() === path.win32.parse(p).root.replace(/\\/g, '/').toLowerCase()));
  }
  const drive = await service.list(query('D:/'));
  assert.equal(drive.parent, null);
  assert.deepEqual(drive.locations.map(x => x.path), ['C:/Users/测试', 'D:/', 'E:/配置']);
  for (const p of ['/tmp', '\\folder', 'C:foo', 'C:', '//host/share', '\\\\host\\share', '\\\\?\\C:\\foo', '\\\\.\\C:']) {
    await assert.rejects(service.list(query(p)), status(400));
  }
  const before = calls.opens.length;
  io.realpath = async () => '\\\\host\\share\\remote';
  await assert.rejects(service.list(query('C:/linked')), status(400));
  assert.equal(calls.opens.length, before);
  io.realpath = async p => p;
  const networkHome = browser({ platform: 'win32', home: '\\\\host\\home', io });
  await assert.rejects(networkHome.list(), status(400));
  assert.equal((await networkHome.list(query('D:/'))).path, 'D:/');
});

test('locations: home/current root/configured roots only, deduplicated, capped at 64, no location IO', async () => {
  const { io, calls } = fakeIO();
  let configured = ['/kb', '/kb', '/course', 'relative', '//host/share', null];
  const service = browser(posixOptions({ io, getLocations: () => configured }));
  let result = await service.list(query('/current'));
  assert.deepEqual(result.locations.map(x => x.path), ['/home/test', '/', '/kb', '/course']);
  assert.ok(result.locations.every(x => typeof x.name === 'string' && x.name));
  configured = Array.from({ length: 100 }, (_, i) => `/configured-${i}`);
  result = await service.list(query('/current'));
  assert.equal(result.locations.length, 64);
  assert.deepEqual(calls.realpaths, ['/current', '/current']);
  assert.deepEqual(calls.opens.map(x => x.path), ['/current', '/current']);
});

test('budgets: all entries count toward 20000, retain at most 5000 names, cooperative 3s deadline; always close', async () => {
  for (const [entries, expectedReads, expectedNames, now] of [
    [Array.from({ length: 20010 }, (_, i) => entry(`file${i}`, false)), 20000, 0],
    [Array.from({ length: 5010 }, (_, i) => entry(`d${String(i).padStart(5, '0')}`)), 5000, 200],
    [[entry('one'), entry('two')], 1, 1, (() => { let tick = -1500; return () => (tick += 1500); })()],
  ]) {
    const { io, calls } = fakeIO(entries);
    const service = browser(posixOptions({ io, ...(now ? { now } : {}) }));
    const result = await service.list(query('/large'));
    assert.equal(calls.reads, expectedReads);
    assert.equal(calls.closes, 1);
    assert.equal(result.directories.length, expectedNames);
    assert.equal(result.truncated, true);
    assert.equal(result.hasMore, expectedReads === 5000);
    if (expectedReads === 5000) {
      const last = await service.list(query('/large', 4800));
      assert.equal(last.directories.length, 200);
      assert.equal(last.hasMore, false);
      assert.equal(last.truncated, true);
      assert.deepEqual((await service.list(query('/large', 5000))).directories, []);
    }
  }
});

test('single-flight path/offset, two independent scans max, no queue/cache; success and failure free slots/handles', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { io, calls } = fakeIO([entry('child')]);
  const realOpen = io.opendir;
  io.opendir = async (...args) => { await gate; return realOpen(...args); };
  const service = browser(posixOptions({ io }));
  const a = service.list(query('/a'));
  const same = service.list(query('/a/./'));
  const second = service.list(query('/a', 200));
  await assert.rejects(service.list(query('/b')), status(429));
  release();
  const [first, merged] = await Promise.all([a, same, second]);
  assert.strictEqual(first, merged);
  assert.equal(calls.opens.length, 2);
  assert.equal(calls.closes, 2);
  await service.list(query('/a'));
  assert.equal(calls.opens.length, 3, 'no persistent listing cache');

  let closed = 0;
  io.opendir = async () => ({ async read() { throw Object.assign(new Error('secret details'), { code: 'EIO' }); }, async close() { closed++; } });
  await assert.rejects(service.list(query('/bad')), status(500));
  assert.equal(closed, 1);
  io.opendir = realOpen;
  await service.list(query('/recovered'));
  io.opendir = async () => ({ async read() { return null; }, async close() { throw new Error('close failed'); } });
  await assert.rejects(service.list(query('/close-failure')), status(500));
  io.opendir = realOpen;
  await service.list(query('/again'));
});

test('filesystem errors map to concise 403/404/400/500 and release admission slots', async () => {
  const { io } = fakeIO();
  const service = browser(posixOptions({ io }));
  const realpath = io.realpath;
  for (const stage of ['realpath', 'opendir']) {
    const original = io[stage];
    for (const [code, expected] of [['EACCES', 403], ['EPERM', 403], ['ENOENT', 404], ['ENOTDIR', 400], ['EIO', 500]]) {
      io[stage] = async () => { throw Object.assign(new Error('sensitive path or stack'), { code }); };
      await assert.rejects(service.list(query('/errors')), err => status(expected)(err) && !err.message.includes('sensitive'));
    }
    io[stage] = original;
  }
  io.realpath = realpath;
  await service.list(query('/working'));
});

test('real HTTP: server wiring, default home, paging, config locations, bad queries/errors, read-only', async t => {
  const base = mkTempDir('lanbook-directory-http-');
  let stopServer = async () => {};
  // Capture the helper's hook even when startup fails. Stop once, before cleanup;
  // do not depend on after-hook ordering or call stop twice after a signal exit.
  t.after(async () => {
    await stopServer();
    // fs.rm does not traverse the node_modules junction.
    fs.rmSync(base, { recursive: true, force: true });
  });
  const installDir = makeInstallDir(base);
  const dataDir = path.join(base, 'data');
  const home = path.join(base, 'home');
  const root = path.join(base, "浏览'根");
  const kb = path.join(base, 'configured-kb');
  const course = path.join(base, 'configured-course');
  for (const dir of [dataDir, home, root, kb, course]) fs.mkdirSync(dir);
  for (let i = 0; i < 203; i++) fs.mkdirSync(path.join(root, `目录${String(i).padStart(3, '0')}`));
  fs.writeFileSync(path.join(root, 'secret.txt'), 'private');
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ host: '127.0.0.1' }));
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [kb, kb] }));
  fs.writeFileSync(path.join(dataDir, 'teach.config.json'), JSON.stringify({ roots: [course] }));
  const srv = await startServer({
    t: { after: stop => { stopServer = stop; } },
    installDir, env: { LANBOOK_HOME: dataDir, HOME: home, USERPROFILE: home },
  });
  const before = snapshotDir(dataDir);
  const request = async suffix => {
    const r = await srv.fetch('/api/directories' + suffix);
    return { status: r.status, body: await r.json() };
  };
  let r = await request('');
  assert.equal(r.status, 200);
  assert.equal(r.body.path, canonical(home));
  assert.equal((await request('?path=')).body.path, canonical(home));
  r = await request('?path=' + encodeURIComponent(root));
  assert.equal(r.status, 200);
  assert.equal(r.body.directories.length, 200);
  assert.equal(r.body.hasMore, true);
  assert.equal(r.body.truncated, false);
  assert.deepEqual(new Set(r.body.locations.map(x => x.path)), new Set([portable(home), portable(path.parse(root).root), portable(kb), portable(course)]));
  const page = await request('?path=' + encodeURIComponent(root) + '&offset=200');
  assert.equal(page.body.directories.length, 3);
  assert.equal(page.body.offset, 200);
  assert.equal(page.body.hasMore, false);
  for (const suffix of ['?path=relative', '?path=D:foo', '?path=%00', '?path=%2F%2Fhost%2Fshare', '?path=x&path=y', '?offset=0&offset=1', '?x=1&x=2', '?offset=-1', '?offset=1.5', '?path%5Bfoo%5D=x']) {
    assert.equal((await request(suffix)).status, 400, suffix);
  }
  assert.equal((await request('?path=' + encodeURIComponent(path.join(root, 'missing')))).status, 404);
  assert.equal((await request('?path=' + encodeURIComponent(path.join(root, 'secret.txt')))).status, 400);
  assert.deepEqual(snapshotDir(dataDir), before, 'GET browsing changes no configuration or files');
});
