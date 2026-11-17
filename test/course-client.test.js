'use strict';
// 与 reading-pane-focus.test.js 一样，在 VM 中执行 index.html 的真实前端代码。
// 不启动服务、不写临时文件；fetch / DOM / WebSocket 仅作为浏览器边界替身。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const between = (start, end) => {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `页面代码边界存在：${start}`);
  return html.slice(a, b);
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const data = (title = '课程 <一>') => ({ workspaces: [{
  id: "ws'一", title: '工作区 <一>', name: 'workspace',
  lessons: [{ file: "module/01 'intro'.html", title }],
  reference: [{ file: 'ref.html', title: '速查 & 卡' }],
}] });

function browser() {
  const requests = [], posts = [], sockets = [], timers = [], toasts = [], pushes = [];
  const stored = new Map(), elements = new Map();
  let focused = 0, removed = 0, frameReloads = 0;
  const frame = {
    contentDocument: { readyState: 'complete', URL: 'http://localhost/teach/course' },
    focus() { focused++; },
    get src() { return '/teach/current'; },
    set src(value) { frameReloads++; },
  };
  function element(id) {
    if (id === 'course-frame') return element('content').innerHTML.includes('<iframe') ? frame : null;
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', style: {},
      classList: { toggle() {}, contains() { return false; } },
      querySelector: sel => sel === '#course-frame' ? frame : null,
    });
    return elements.get(id);
  }
  const sandbox = {
    currentFile: null, isEditing: false, ws: null,
    location: { protocol: 'http:', host: 'localhost' },
    document: {
      body: {}, documentElement: {}, activeElement: null,
      getElementById: element,
      querySelector: sel => sel === '.sidebar' ? element('sidebar') :
        sel === '.dialog-overlay' ? { remove() { removed++; } } : null,
    },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    history: { pushState: (...args) => pushes.push(args) },
    showToast: msg => toasts.push(msg),
    loadFileList: async () => {},
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
    WebSocket: class { constructor() { sockets.push(this); } },
    configResponse: () => Promise.resolve({ ok: true }),
    fetch(url, options) {
      if (url === '/api/courses/config') {
        posts.push(options);
        return sandbox.configResponse();
      }
      assert.equal(url, '/api/courses');
      return new Promise((resolve, reject) => requests.push({ resolve, reject }));
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    between('let currentView =', '// ⚙ 设置入口'),
    between('function escapeHtml(', '// 剥离 YAML frontmatter'),
    between('function focusReadingPane(', '\n// 编辑模式\n'),
    between('// WebSocket 连接', 'connectWS();'),
  ].join('\n'), sandbox, { filename: 'index.html course client' });
  const run = src => vm.runInContext(src, sandbox);
  return {
    run, requests, posts, sockets, timers, toasts, pushes, stored, element,
    configResponse(fn) { sandbox.configResponse = fn; },
    get focused() { return focused; }, get removed() { return removed; },
    get frameReloads() { return frameReloads; },
    reply(index, payload = data(), status = 200) {
      requests[index].resolve({ ok: status < 400, status, json: async () => payload });
    },
    notify() { sockets.at(-1).onmessage({ data: JSON.stringify({ type: 'course-change' }) }); },
    connect() { run('connectWS()'); sockets.at(-1).onopen(); },
  };
}

async function prime(app, payload = data()) {
  const p = app.run('loadCourseList()');
  app.reply(0, payload);
  await p;
}

const open = "openCourse(\"ws'一\", 'lessons', \"module/01 'intro'.html\")";

test('首次进入加载；随后切换课程视图复用缓存，包括空列表', async () => {
  for (const payload of [data(), { workspaces: [] }]) {
    const app = browser();
    assert.equal(app.requests.length, 0);
    app.run("switchView('courses')");
    assert.equal(app.requests.length, 1);
    app.reply(0, payload);
    await tick();
    const rendered = app.element('course-list').innerHTML;
    assert.ok(rendered);
    app.run("switchView('docs'); switchView('courses')");
    await tick();
    assert.equal(app.requests.length, 1);
    assert.equal(app.element('course-list').innerHTML, rendered);
  }
});

test('toggle / open 只重绘，保留展开持久化、选中、history、路径编码和阅读焦点', async () => {
  const app = browser();
  await prime(app);
  app.run("toggleCourseWs(\"ws'一\"); toggleCourseGroup(\"ws'一|lessons\")");
  app.run(open);
  assert.equal(app.requests.length, 1, '展开、分组和选中不得发起网络请求');
  const list = app.element('course-list').innerHTML;
  assert.match(list, /file-item active/);
  assert.ok(list.includes('课程 &lt;一&gt;'));
  assert.ok(list.includes('工作区 &lt;一&gt;'));
  assert.ok(list.includes("ws\\'一"), '保留 onclick 属性转义');
  assert.ok(app.element('content').innerHTML.includes("module/01%20\\'intro\\'.html"));
  assert.equal(app.element('file-title').textContent, '课程 <一>');
  assert.equal(app.pushes.length, 1);
  assert.equal(app.focused, 1);
  assert.ok(JSON.parse(app.stored.get('course-expanded-ws')).includes("ws'一"));
  app.run(open.replace(/\)$/, ', true)'));
  assert.equal(app.pushes.length, 1, '历史恢复不重复 pushState');
  assert.equal(app.requests.length, 1);
  // 即使数据已过期，用户的展开/选中操作也不应触发加载。
  app.connect();
  app.notify();
  assert.equal(app.frameReloads, 1, '通知保留当前课程 iframe 刷新行为');
  app.run("toggleCourseWs(\"ws'一\"); toggleCourseGroup(\"ws'一|lessons\")");
  app.run(open);
  assert.equal(app.requests.length, 1);
});

test('并发加载合并为一个请求，完成后复用同一缓存', async () => {
  const app = browser();
  const pending = [app.run('loadCourseList()'), app.run('loadCourseList()'), app.run('loadCourseList()')];
  assert.equal(app.requests.length, 1);
  app.reply(0);
  await Promise.all(pending);
  await app.run('loadCourseList()');
  assert.equal(app.requests.length, 1);
});

test('非课程视图的通知令缓存过期，下次进入只加载一次', async () => {
  const app = browser();
  await prime(app);
  app.connect();
  app.notify();
  app.notify();
  assert.equal(app.requests.length, 1, '隐藏视图不立即扫描');
  app.run("switchView('courses')");
  assert.equal(app.requests.length, 2);
  app.reply(1, data('新课程'));
  await tick();
  app.run(open);
  assert.equal(app.element('file-title').textContent, '新课程');
});

test('课程视图通知强制刷新；刷新中的多次失效合并补拉，不吞变更', async () => {
  const app = browser();
  app.connect();
  await prime(app);
  app.run("switchView('courses')");
  app.notify();
  assert.equal(app.requests.length, 2);
  const pending = app.run('loadCourseList()');
  app.notify();
  app.notify();
  assert.equal(app.requests.length, 2, '仍只有一个在途请求');
  app.reply(1, data('过期结果'));
  await tick();
  assert.equal(app.requests.length, 3, '请求开始后的失效必须补拉');
  app.reply(2, data('最终结果'));
  await pending;
  app.run(open);
  assert.equal(app.element('file-title').textContent, '最终结果');
  assert.equal(app.requests.length, 3);
});

test('请求刚完成时的微任务失效也不能被在途状态吞掉', async () => {
  const app = browser();
  app.connect();
  await prime(app);
  app.run("switchView('courses')");
  const list = app.element('course-list');
  let rendered = list.innerHTML, queued = false;
  Object.defineProperty(list, 'innerHTML', {
    get: () => rendered,
    set(value) {
      rendered = value;
      if (!queued) {
        queued = true;
        // 类似 DOM MutationObserver：在异步加载返回与 Promise 清理间失效。
        queueMicrotask(() => app.notify());
      }
    },
  });
  app.notify();
  app.reply(1, data('刚完成'));
  await tick();
  assert.equal(app.requests.length, 3, '完成边界的通知仍须启动刷新');
  app.reply(2, data('边界后'));
  await tick();
  app.run(open);
  assert.equal(app.element('file-title').textContent, '边界后');
});

test('刷新中转到知识库后收到通知也不吞失效', async () => {
  const app = browser();
  app.connect();
  await prime(app);
  app.run("switchView('courses')");
  app.notify();
  app.run("switchView('docs')");
  app.notify();
  app.reply(1, data('旧结果'));
  await tick();
  app.run("switchView('courses')");
  assert.equal(app.requests.length, 3, '补拉可以立即发生或延迟到再次进入');
  app.reply(2, data('新结果'));
  await tick();
  app.run(open);
  assert.equal(app.element('file-title').textContent, '新结果');
});

test('WebSocket 重连使隐藏缓存过期、可见视图刷新，保持原重连计时器', async () => {
  const app = browser();
  app.connect();
  await prime(app);
  app.sockets[0].onclose();
  assert.equal(app.timers.length, 1);
  assert.equal(app.timers[0].delay, 2000);
  app.timers[0].fn();
  app.sockets[1].onopen();
  assert.equal(app.requests.length, 1);
  app.run("switchView('courses')");
  assert.equal(app.requests.length, 2);
  app.reply(1);
  await tick();
  app.sockets[1].onclose();
  app.timers[1].fn();
  app.sockets[2].onopen();
  assert.equal(app.requests.length, 3);
  app.reply(2);
  await tick();
});

test('网络/HTTP/JSON 失败保留旧缓存、可重试；通知入口不会产生 unhandled rejection', async () => {
  const app = browser();
  app.connect();
  await prime(app);
  app.run("switchView('courses')");
  for (const failure of ['network', 'http', 'json']) {
    app.notify();
    const index = app.requests.length - 1;
    const pending = app.run('loadCourseList()');
    if (failure === 'network') app.requests[index].reject(new Error('offline'));
    if (failure === 'http') app.reply(index, { workspaces: [] }, 503);
    if (failure === 'json') app.requests[index].resolve({ ok: true, json: async () => { throw new Error('bad json'); } });
    await assert.doesNotReject(async () => { await pending; });
    await tick();
    app.run(open);
    assert.equal(app.element('file-title').textContent, '课程 <一>', '失败不覆盖已有数据');
    assert.equal(app.requests.length, index + 1, '失败和纯重绘不自动重试');
    const retry = app.run('loadCourseList()');
    assert.equal(app.requests.length, index + 2);
    app.reply(index + 1);
    await retry;
  }
  assert.ok(app.toasts.length >= 3, '失败应有可见提示');
});

test('首次加载失败后重新进入可重试', async () => {
  const app = browser();
  app.run("switchView('courses')");
  app.requests[0].reject(new Error('offline'));
  await tick();
  app.run("switchView('docs'); switchView('courses')");
  assert.equal(app.requests.length, 2);
  app.reply(1);
  await tick();
});

test('保存配置失败不会未处理拒绝或额外刷新，仍可再次保存', async () => {
  const app = browser();
  await prime(app);
  app.configResponse(() => Promise.reject(new Error('offline')));
  await assert.doesNotReject(async () => { await app.run('saveRoots()'); });
  assert.equal(app.requests.length, 1);
  assert.equal(app.removed, 0, '网络失败保留对话框以便重试');
  app.configResponse(() => Promise.resolve({ ok: false, json: async () => ({ error: '无效根目录' }) }));
  await app.run('saveRoots()');
  assert.equal(app.requests.length, 1);
  assert.equal(app.toasts.at(-1), '无效根目录');
  app.configResponse(() => Promise.resolve({ ok: true }));
  const saved = app.run('saveRoots()');
  await tick();
  assert.equal(app.requests.length, 2, '有效缓存也须在保存成功后刷新');
  app.reply(1);
  await saved;
});

test('保存课程配置强制刷新；若已有请求则合并并补拉最新配置', async () => {
  const app = browser();
  await prime(app);
  const pending = app.run('loadCourseList(true)');
  const saved = app.run("window._pendingRoots = ['C:/课程']; saveRoots()");
  await tick();
  assert.equal(app.posts.length, 1);
  assert.equal(app.posts[0].method, 'POST');
  assert.deepEqual(JSON.parse(app.posts[0].body), { roots: ['C:/课程'] });
  assert.equal(app.removed, 1);
  assert.equal(app.requests.length, 2);
  app.reply(1, data('配置前'));
  await tick();
  assert.equal(app.requests.length, 3);
  app.reply(2, data('配置后'));
  await Promise.all([pending, saved]);
  app.run(open);
  assert.equal(app.element('file-title').textContent, '配置后');
});
