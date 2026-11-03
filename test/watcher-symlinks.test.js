'use strict';
// Exercise all three production watchers, not a separately configured chokidar.
// The preload only bounds traversal and reports the public getWatched() result.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, sleep } = require('./helpers');

async function waitFor(fn, label) {
  const deadline = Date.now() + 8000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(50);
  }
}

function observations(srv) {
  return srv.stdout().split(/\r?\n/)
    .filter(line => line.startsWith('[watcher-test] '))
    .map(line => JSON.parse(line.slice('[watcher-test] '.length)));
}

test('watchers: junction cycles stay bounded and ordinary files still notify clients', { timeout: 30000 }, async t => {
  const base = mkTempDir('lanbook-watchers-');
  const installDir = makeInstallDir(base);
  const dataDir = path.join(base, 'data');
  const roots = {
    docs: path.join(dataDir, 'docs'),
    teach: path.join(base, 'courses', 'workspace'),
    knowledge: path.join(base, 'notes'),
  };
  const links = [];
  let srv;
  let ws;
  t.after(async () => {
    if (ws) ws.terminate();
    if (srv) await srv.stop();
    // Detach every junction before recursively removing the isolated fixture.
    for (const link of links) fs.unlinkSync(link);
    removeInstallDir(installDir);
    fs.rmSync(base, { recursive: true, force: true });
    assert.equal(fs.existsSync(base), false, 'fixture must be removed');
  });

  for (const root of Object.values(roots)) {
    fs.mkdirSync(path.join(root, 'nested'), { recursive: true });
    const link = path.join(root, 'nested', 'back');
    fs.symlinkSync(root, link, 'junction');
    links.push(link);
  }
  fs.mkdirSync(path.join(roots.teach, 'lessons'));
  fs.writeFileSync(path.join(roots.teach, 'lessons', 'intro.html'), '<h1>Intro</h1>');
  fs.writeFileSync(path.join(dataDir, 'teach.config.json'), JSON.stringify({ roots: [path.dirname(roots.teach)] }));
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [roots.knowledge] }));

  const probe = path.join(__dirname, 'fixtures', 'watcher-probe.cjs');
  srv = await startServer({ t, installDir, env: {
    LANBOOK_HOME: dataDir,
    NODE_OPTIONS: `--require ${JSON.stringify(probe)}`,
  } });
  await waitFor(() => observations(srv).length === 3, 'all production watchers ready');

  for (const [kind, root] of Object.entries(roots)) {
    await t.test(`${kind}: no repeated paths through a directory junction cycle`, () => {
      const summary = observations(srv).find(o => o.roots.includes(root));
      assert.ok(summary, `${kind} watcher must exist`);
      assert.ok(summary.directories.includes(path.join(root, 'nested')), 'ordinary nested directory must be watched');
      const repeated = summary.directories.filter(p => p.split(/[\\/]/).filter(s => s === 'back').length > 1);
      assert.deepEqual(repeated, [], `${kind}: same physical tree must not generate repeated watcher paths`);
    });
  }

  await t.test('add/change/unlink still reach WebSocket clients for all three watchers', async () => {
    const messages = [];
    ws = new WebSocket(srv.baseUrl.replace('http:', 'ws:'));
    ws.on('message', raw => messages.push(JSON.parse(String(raw))));
    await once(ws, 'open');
    const files = [
      { type: 'file-change', file: path.join(roots.docs, 'nested', 'normal.md'), initial: '# Initial' },
      { type: 'course-change', file: path.join(roots.teach, 'lessons', 'normal.html'), initial: '<h1>Initial</h1>' },
      { type: 'knowledge-change', file: path.join(roots.knowledge, 'nested', 'normal.md'), initial: '# Initial' },
    ];
    for (const event of ['add', 'change', 'unlink']) {
      messages.length = 0;
      for (const { file, initial } of files) {
        if (event === 'unlink') fs.unlinkSync(file);
        else fs.writeFileSync(file, event === 'add' ? initial : initial.replaceAll('Initial', 'Updated content'));
      }
      await waitFor(() => files.every(({ type }) => messages.some(m => m.type === type && m.event === event)),
        `${event} notifications: ${files.map(f => f.type).join(', ')}`);
    }
    assert.equal((await srv.fetch('/api/knowledge/config')).status, 200, 'service stays responsive');
    assert.equal(srv.stderr(), '', 'watching cyclic fixtures must not produce errors');
  });
});
