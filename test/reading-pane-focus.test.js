'use strict';
// 阅读区焦点测试（修复「Vimium C 的 j/k 滚不动正文，必须先鼠标点一下」）
//
// 问题背景：正文滚动发生在内层容器里（body overflow:hidden；md 是 .markdown-view，
// HTML 是 iframe 内部文档），而侧边栏 #file-list 本身也是 overflow:auto 的滚动容器。
// Vimium C 执行 j/k 时，会从「最近一次真实点击的元素」出发向上找第一个可滚动祖先——
// 用户点侧边栏打开文档后，第一步就命中 #file-list，于是 j/k 滚侧边栏、正文不动。
//
// 修复一（92ef463）：打开文档（loadFile / openCourse）后把键盘焦点交给正文阅读区，
// 等价于替用户完成「点一下正文」这一步。
//
// 修复二（本次）：md 路径修复后 HTML 页面仍要点一下才生效——iframe 的聚焦时机有讲究：
// focusReadingPane 在 innerHTML 写入后同步调用，此刻 iframe 里还是 about:blank 初始
// 文档，就聚焦它的话，焦点状态建立在即将销毁的临时文档上，src 文档替换后焦点窗口
// 是否保留纯属浏览器竞态；且子框架的键盘扩展（Vimium C 等，document_start 注入）
// 尚未注入，收不到 focus 事件、不会激活，按键事件即使进了子框架也无人处理。
// 因此 iframe 必须等 load 事件（最终文档 + 扩展脚本就位）后再聚焦。
//
// 浏览器无法自动化驱动，故此处按 katex-client.test.js 的既有惯例，用 vm 沙箱加载
// index.html 内联脚本片段 + 源码断言验证前提。真实交互由用户手动冒烟。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('./helpers');

const INDEX_HTML = path.join(REPO_ROOT, 'public', 'index.html');

function readIndex() {
  return fs.readFileSync(INDEX_HTML, 'utf-8');
}

// 抽出页面内联 <script> 中的单个函数源码（含嵌套大括号，按花括号配对截取）
function extractFunction(html, name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html 应定义 ${name}()`);
  let depth = 0, i = html.indexOf('{', start);
  const bodyStart = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1); }
  }
  throw new Error(`${name}() 函数体未闭合`);
}

test('正文容器与课程 iframe 是键盘焦点落点：可编程聚焦且不画焦点框', () => {
  const html = readIndex();

  // .markdown-view 需 tabindex="-1" 才能被 .focus() 编程聚焦（无 tabindex 的 div 不可聚焦）
  assert.match(
    html,
    /<div class="markdown-view" tabindex="-1">/,
    'md 正文容器应带 tabindex="-1"，否则 focusReadingPane() 无法把焦点交给它'
  );

  // 焦点环会干扰阅读：阅读区（md 容器 / 课程 iframe）的 :focus 需隐去 outline
  const focusRule = html.match(/\.markdown-view:focus[^{]*\{([^}]*)\}/);
  assert.ok(focusRule, '应存在 .markdown-view:focus 样式规则');
  assert.match(focusRule[1], /outline:\s*none/, '阅读区焦点框应隐去（outline: none）');
  const frameRule = html.match(/\.course-frame:focus[^{]*\{([^}]*)\}/);
  assert.ok(frameRule, '应存在 .course-frame:focus 样式规则');
  assert.match(frameRule[1], /outline:\s*none/, '课程 iframe 焦点框应隐去（outline: none）');
});

test('loadFile 与 openCourse 渲染后都调用 focusReadingPane()', () => {
  const html = readIndex();

  // 两个入口（知识库文档 / 课程）都要调用，否则只修好一半
  const loadFile = html.slice(html.indexOf('async function loadFile('), html.indexOf('// 编辑模式'));
  assert.match(loadFile, /focusReadingPane\(\)/, 'loadFile() 渲染完成后应调用 focusReadingPane()');

  const openCourse = html.slice(html.indexOf('function openCourse('), html.indexOf('function openCourseInNewTab('));
  assert.match(openCourse, /focusReadingPane\(\)/, 'openCourse() 渲染完成后应调用 focusReadingPane()');

  // 调用必须发生在内容写入之后（innerHTML 替换会销毁旧节点，先聚焦等于没聚焦）
  const innerIdx = loadFile.indexOf("content.innerHTML = `<div class=\"markdown-view\"");
  assert.notEqual(innerIdx, -1, 'loadFile() 应写入 md 正文容器');
  assert.ok(loadFile.indexOf('focusReadingPane()') > innerIdx,
    'focusReadingPane() 必须在正文 innerHTML 写入之后调用');
});

// vm 沙箱里跑真实的 focusReadingPane() + focusFrameWhenReady()，
// 验证聚焦目标选择、防抢焦点守卫与 iframe 的 load 时机处理
function runFocusReadingPane({ editing = false, activeEl = null, mode = 'md', iframeDoc = null } = {}) {
  const vm = require('node:vm');
  const html = readIndex();
  const src = extractFunction(html, 'focusReadingPane') + '\n' + extractFunction(html, 'focusFrameWhenReady');
  const focused = [];
  const listeners = [];

  const mdView = {
    focus(arg) { focused.push({ kind: 'markdown-view', arg }); },
  };
  // iframe mock：iframeDoc 描述 contentDocument 的返回形态
  //   - null：同步抛异常（跨源框架读不到 contentDocument）
  //   - { readyState, url }：返回对应形态的文档
  const frame = {
    focus(arg) { focused.push({ kind: 'course-frame', arg }); },
    get contentDocument() {
      if (iframeDoc === null) throw new Error('Blocked a frame with origin from accessing a cross-origin frame');
      return { readyState: iframeDoc.readyState, URL: iframeDoc.url };
    },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
  };
  const content = {
    querySelector(sel) {
      if (sel === '.markdown-view') return mode === 'md' ? mdView : null;
      if (sel === '#course-frame') return mode === 'html' ? frame : null;
      return null;
    },
  };
  const body = { tagName: 'BODY' };
  const sandbox = {
    isEditing: editing,
    document: {
      activeElement: activeEl || body,
      body,
      documentElement: { tagName: 'HTML' },
      getElementById: (id) => (id === 'content' ? content : null),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'index.html focusReadingPane' });
  vm.runInContext('focusReadingPane();', sandbox);
  return { focused, listeners, frame, sandbox };
}

test('focusReadingPane：md 文档同步聚焦 .markdown-view', () => {
  const md = runFocusReadingPane({ mode: 'md' });
  assert.deepEqual(md.focused.map(f => f.kind), ['markdown-view'],
    'md 文档应聚焦 .markdown-view（Vimium C 的锚点由此落到正文滚动容器）');

  // preventScroll：聚焦不得把已恢复的阅读位置弹回顶部
  assert.equal(md.focused[0].arg && md.focused[0].arg.preventScroll, true,
    '聚焦应带 preventScroll: true，避免打断阅读位置');
});

test('HTML 页面：iframe 还是 about:blank 时不聚焦，等 load 后再聚焦', () => {
  // focusReadingPane 同步调用于 innerHTML 写入后，此刻 iframe 是 about:blank 初始文档
  //（readyState 已是 complete，但 URL 是 about:blank）——不能立刻聚焦
  const pending = runFocusReadingPane({
    mode: 'html',
    iframeDoc: { readyState: 'complete', url: 'about:blank' },
  });
  assert.deepEqual(pending.focused, [],
    'about:blank 初始文档不应被聚焦：焦点会随文档替换丢失，且子框架扩展脚本尚未注入收不到 focus 事件');
  assert.equal(pending.listeners.length, 1, '应挂 load 监听等待最终文档');
  assert.equal(pending.listeners[0].type, 'load', '监听的是 load 事件');

  // load 后（最终文档 + 扩展脚本已就位）聚焦，且带 preventScroll
  pending.listeners[0].fn();
  assert.deepEqual(pending.focused.map(f => f.kind), ['course-frame'],
    'load 后应聚焦 iframe，焦点真正进入子框架并触发 focus 事件（等价用户点一下）');
  assert.equal(pending.focused[0].arg && pending.focused[0].arg.preventScroll, true,
    'load 后聚焦也应带 preventScroll: true');
});

test('HTML 页面：iframe 已是加载完成的最终文档时同步聚焦', () => {
  // 热更新重建 iframe 后 focusReadingPane 被调用时，src 文档可能已加载完成
  const done = runFocusReadingPane({
    mode: 'html',
    iframeDoc: { readyState: 'complete', url: 'http://127.0.0.1:30142/kbfile/0/a.html' },
  });
  assert.deepEqual(done.focused.map(f => f.kind), ['course-frame'],
    '最终文档已就位时应同步聚焦 iframe，不再等 load（否则永远不聚焦）');
  assert.deepEqual(done.listeners, [], '已加载的 iframe 不应再挂 load 监听');
});

test('HTML 页面：跨源 iframe 读不到 contentDocument 时走 load 分支兜底', () => {
  // 部署形态若出现跨源，contentDocument 访问抛异常——不能让聚焦整个失败
  const cross = runFocusReadingPane({ mode: 'html', iframeDoc: null });
  assert.deepEqual(cross.focused, [], '跨源时应等 load，不应同步聚焦');
  assert.equal(cross.listeners.length, 1, '跨源时应挂 load 监听兜底');

  cross.listeners[0].fn();
  assert.deepEqual(cross.focused.map(f => f.kind), ['course-frame'],
    'load 后跨源 iframe 元素本身仍可聚焦（focus 进入子浏览上下文）');
});

test('focusReadingPane 不抢焦点：编辑模式 / 输入框 / 对话框聚焦时不介入', () => {
  // 编辑模式：焦点属于 textarea，抢焦点会打断输入
  assert.equal(runFocusReadingPane({ editing: true }).focused.length, 0,
    '编辑模式不应抢焦点');

  // 对话框输入框正在使用时（如文件热更新触发的重载）不应被抢
  const input = {
    tagName: 'INPUT',
    closest: () => null,
    matches: (sel) => sel.includes('input'),
  };
  assert.equal(runFocusReadingPane({ activeEl: input }).focused.length, 0,
    '输入框聚焦时不应抢焦点');

  const inDialog = {
    tagName: 'INPUT',
    closest: (sel) => (sel === '.dialog-overlay' ? {} : null),
    matches: () => false,
  };
  assert.equal(runFocusReadingPane({ activeEl: inDialog }).focused.length, 0,
    '对话框内的元素聚焦时不应抢焦点');

  // 正文容器自己已聚焦（反复滚动）时重复调用应无害
  const already = {
    tagName: 'DIV',
    closest: () => null,
    matches: () => false,
  };
  assert.equal(runFocusReadingPane({ activeEl: already }).focused.length, 1,
    '焦点在普通元素上时应正常聚焦正文');
});
