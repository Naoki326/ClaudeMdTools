'use strict';
// 阅读区焦点测试（修复「Vimium C 的 j/k 滚不动正文，必须先鼠标点一下」）
//
// 问题背景：正文滚动发生在内层容器里（body overflow:hidden；md 是 .markdown-view，
// HTML 是 iframe 内部文档），而侧边栏 #file-list 本身也是 overflow:auto 的滚动容器。
// Vimium C 执行 j/k 时，会从「最近一次真实点击的元素」出发向上找第一个可滚动祖先——
// 用户点侧边栏打开文档后，第一步就命中 #file-list，于是 j/k 滚侧边栏、正文不动。
//
// 修复：打开文档（loadFile / openCourse）后把键盘焦点交给正文阅读区，等价于替用户
// 完成「点一下正文」这一步。
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

// vm 沙箱里跑真实的 focusReadingPane()，验证它的聚焦目标选择与防抢焦点守卫
function runFocusReadingPane({ editing = false, activeEl = null, view = 'md' } = {}) {
  const vm = require('node:vm');
  const src = extractFunction(readIndex(), 'focusReadingPane');
  const focused = [];

  const mkView = (kind) => ({
    kind,
    focus(arg) { focused.push({ kind, arg }); },
  });
  const mdView = mkView('markdown-view');
  const frame = mkView('course-frame');
  const content = {
    querySelector(sel) {
      if (sel === '.markdown-view') return view === 'md' ? mdView : null;
      if (sel === '#course-frame') return view === 'html' ? frame : null;
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
  return { focused, sandbox };
}

test('focusReadingPane：md 文档聚焦 .markdown-view，HTML 课程聚焦 iframe', () => {
  const md = runFocusReadingPane({ view: 'md' });
  assert.deepEqual(md.focused.map(f => f.kind), ['markdown-view'],
    'md 文档应聚焦 .markdown-view（Vimium C 的锚点由此落到正文滚动容器）');

  const html = runFocusReadingPane({ view: 'html' });
  assert.deepEqual(html.focused.map(f => f.kind), ['course-frame'],
    'HTML 课程应聚焦 iframe（Vimium C 会走 detectUsableChild 把 j/k 转发进子框架）');

  // preventScroll：聚焦不得把已恢复的阅读位置弹回顶部
  assert.equal(md.focused[0].arg && md.focused[0].arg.preventScroll, true,
    '聚焦应带 preventScroll: true，避免打断阅读位置');
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
