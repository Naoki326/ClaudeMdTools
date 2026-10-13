'use strict';
// 监听目录级剪枝 + 嵌套根目录归并 + excludeDirs 双路一致（工单 #7）的 API 级行为测试。
// 只断言外部行为：WebSocket 广播（knowledge-change）、/api/knowledge 树内容。
// 缺席断言（「变动不得产生广播」）先等一个宽松的无声窗口再断言，随后在同一连接上
// 用一次文档变动验证监听管道本身是活的——缺席断言不得因监听器整体失效而假绿。
// 时序断言一律宽松上限（awaitWriteFinish 300ms + 失效去抖 500ms + 重建 + 富余）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, sleep } = require('./helpers');

// —— 断言辅助 ——

// 树中 file 节点展开为 Map<fileName, title>（仅用于文件名互不重名的夹具）
function fileTitles(roots) {
  const out = new Map();
  const stack = [...(roots || []).flatMap(r => r.children || [])];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'file') out.set(n.name, n.title);
    else if (n.children) stack.push(...n.children);
  }
  return out;
}

// 树中 file 节点总数（嵌套根归并后每份文档应只计一次）
function countFiles(roots) {
  let n = 0;
  const stack = [...(roots || []).flatMap(r => r.children || [])];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'file') n++;
    else if (node.children) stack.push(...node.children);
  }
  return n;
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

// 连接服务的 WebSocket，收集全部消息；knowledgeChanges() 返回 knowledge-change 消息
function connectWs(srv) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
    const messages = [];
    ws.on('message', raw => { try { messages.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      messages,
      knowledgeChanges: () => messages.filter(m => m.type === 'knowledge-change'),
      close: () => { try { ws.close(); } catch {} },
    }));
  });
}

function writeDoc(dir, name, title) {
  fs.writeFileSync(path.join(dir, name), `# ${title}\n\n正文。\n`, 'utf-8');
}

async function setup(t, { name, config }) {
  const base = mkTempDir(`kb-prune-${name}-`);
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir(`kb-prune-data-${name}-`);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify(config), 'utf-8');
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  return { base, srv, getTree: () => srv.fetch('/api/knowledge').then(r => r.json()) };
}

test('监听剪枝：根目录下非文档/瞬态文件变动无广播，文档变动有广播', async t => {
  const cfg = { roots: [] };
  const base = mkTempDir('kb-prune-docfix-');
  const kb = path.join(base, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  writeDoc(kb, 'a.md', '已有文档');
  cfg.roots.push(kb);
  const { srv, getTree } = await setup(t, { name: 'watch', config: cfg });

  const client = await connectWs(srv);
  t.after(() => client.close());
  // 等连接握手 + chokidar ready（ignoreInitial 之下初始扫描本就不发事件）
  await waitFor(() => client.messages.some(m => m.type === 'connected'), 3000, { label: 'WebSocket 未连接' });
  await sleep(1000);

  // 非文档（.log/.txt）与瞬态文件（.lock、Office 占用锁 ~$xxx.md——后者按扩展名
  // 看是「文档」，全靠瞬态模式剪掉）：宽松无声窗口内不得产生 knowledge-change
  fs.writeFileSync(path.join(kb, 'trace.log'), 'x', 'utf-8');
  fs.writeFileSync(path.join(kb, 'notes.txt'), 'x', 'utf-8');
  fs.writeFileSync(path.join(kb, 'data.lock'), 'x', 'utf-8');
  fs.writeFileSync(path.join(kb, '~$a.md'), 'x', 'utf-8');
  await sleep(2500); // 宽松上限：awaitWriteFinish 300ms + 去抖 500ms + 重建 + 富余
  assert.equal(client.knowledgeChanges().length, 0, '非文档/瞬态文件变动不得产生 knowledge-change 广播');

  // 同一连接上的文档变动必须有广播——证明监听管道本身是活的（缺席断言不假绿）
  writeDoc(kb, 'b.md', '新文档');
  await waitFor(() => client.knowledgeChanges().length >= 1, 8000, { label: '文档变动未产生广播' });
  assert.ok(client.knowledgeChanges()[0].event, '广播应携带事件名字段');

  // 广播之后树应反映新文档
  await waitFor(async () => fileTitles((await getTree()).roots).has('b.md'), 8000, { label: '新文档未出现在树中' });

  await srv.stop();
});

test('嵌套根目录归并：父子根（含重复根）→ 每份文档恰好出现一次，子根变更仍生效', async t => {
  const base = mkTempDir('kb-prune-nested-');
  const parent = path.join(base, 'kb');
  const child = path.join(parent, 'child');
  fs.mkdirSync(child, { recursive: true });
  writeDoc(parent, 'a.md', '父根文档');
  writeDoc(child, 'b.md', '子根文档');
  // 配置三个根：父根、父内的子根、与父根相同的重复根——归并后只覆盖一次
  const { srv, getTree } = await setup(t, {
    name: 'nested',
    config: { roots: [parent, child, parent] },
  });

  // 归并：子根被父根吸收、重复根去重 → 顶层只剩父根，两份文档各出现一次
  const tree = await getTree();
  assert.equal(tree.roots.length, 1, `嵌套/重复根应归并，实际顶层根 ${tree.roots.length} 个`);
  assert.ok(tree.roots[0].path.replace(/\\/g, '/').endsWith('/kb'), '顶层根应为父根');
  assert.equal(countFiles(tree.roots), 2, `每份文档应恰好出现一次，实际 ${countFiles(tree.roots)} 份`);
  const titles = fileTitles(tree.roots);
  assert.equal(titles.get('a.md'), '父根文档');
  assert.equal(titles.get('b.md'), '子根文档');

  // 子根目录里的文档变更仍然生效（归并后由父根的监听覆盖，不因吸收而失聪）
  await sleep(60); // 保证 mtime 变化
  writeDoc(child, 'b.md', '子根文档-改');
  await waitFor(async () => fileTitles((await getTree()).roots).get('b.md') === '子根文档-改',
    8000, { label: '子根内文档变更未反映到树（归并后监听失聪）' });

  await srv.stop();
});

test('excludeDirs 双路一致：被排除目录（含内置黑名单目录）变动无广播、文档不入树', async t => {
  const base = mkTempDir('kb-prune-excl-');
  const kb = path.join(base, 'kb');
  fs.mkdirSync(path.join(kb, 'keep'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'skip'), { recursive: true });
  fs.mkdirSync(path.join(kb, 'node_modules'), { recursive: true });
  writeDoc(path.join(kb, 'keep'), 'a.md', '保留文档');
  writeDoc(path.join(kb, 'skip'), 'hidden.md', '排除文档');
  writeDoc(path.join(kb, 'node_modules'), 'junk.md', '默认排除文档');
  const { srv, getTree } = await setup(t, {
    name: 'excl',
    config: { roots: [kb], excludeDirs: ['skip'] },
  });

  // 扫描侧：被排除目录（配置 excludeDirs + 内置默认）的文档不入树
  const titles = fileTitles((await getTree()).roots);
  assert.deepEqual([...titles.keys()].sort(), ['a.md'], '被排除目录的文档不得出现在树中');

  // 监听侧：同一份配置——被排除目录内新建文档（含内置黑名单目录）不产生广播
  const client = await connectWs(srv);
  t.after(() => client.close());
  await waitFor(() => client.messages.some(m => m.type === 'connected'), 3000, { label: 'WebSocket 未连接' });
  await sleep(1000);
  writeDoc(path.join(kb, 'skip'), 'new-hidden.md', '排除新增');
  writeDoc(path.join(kb, 'node_modules'), 'new-junk.md', '默认排除新增');
  await sleep(2500); // 宽松无声窗口
  assert.equal(client.knowledgeChanges().length, 0, '被排除目录内变动不得产生广播');

  // 同一连接上未排除目录的文档变动仍有广播（缺席断言不假绿）
  writeDoc(path.join(kb, 'keep'), 'b.md', '保留新增');
  await waitFor(() => client.knowledgeChanges().length >= 1, 8000, { label: '未排除目录的文档变动未产生广播' });
  await waitFor(async () => fileTitles((await getTree()).roots).has('b.md'), 8000, { label: '未排除目录的新文档未入树' });

  await srv.stop();
});
