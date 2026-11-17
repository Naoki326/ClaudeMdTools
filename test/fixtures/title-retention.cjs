'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createKnowledgeService } = require('../../lib/knowledge');
(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lanbook-title-retention-'));
  const root = path.join(base, 'notes'), dataDir = path.join(base, 'data');
  fs.mkdirSync(root); fs.mkdirSync(dataDir);
  const service = createKnowledgeService({ dataDir, baseDir: base, resolveRoot: p => path.resolve(p) });
  service.writeConfig({ roots: [root] });
  try {
    for (let n = 0; n < 12; n++) fs.writeFileSync(path.join(root, `${n}.md`), '# A title long enough to use a V8 sliced string ' + n + '\n' + 'B'.repeat(2 * 1024 * 1024));
    await new Promise(r => setImmediate(r)); global.gc();
    const before = process.memoryUsage();
    await service.discover();
    await new Promise(r => setImmediate(r)); global.gc(); global.gc();
    const after = process.memoryUsage();
    const delta = after.heapUsed - before.heapUsed;
    console.log(JSON.stringify({ beforeHeap: before.heapUsed, afterHeap: after.heapUsed, retainedHeapDelta: delta, budget: 8 * 1024 * 1024, pass: delta < 8 * 1024 * 1024 }));
    if (delta >= 8 * 1024 * 1024) process.exitCode = 1;
  } finally { await service.close(); fs.rmSync(base, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
