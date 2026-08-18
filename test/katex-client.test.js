'use strict';
// Ticket #10（lanbook T3 · 客户端三入口公式渲染）进程边界测试（spec #7 D4）
// 覆盖验收标准：知识库视图 / 编辑预览共用的客户端 marked 管线对 `$...$` / `$$...$$`
// 输出 KaTeX 静态 HTML（块级居中）；坏公式降级不抛错；边界文本不误渲染；
// 首页接线完整（引用 vendor 资产 + marked.use(markedKatex(...))）。
// seam：浏览器无法自动化驱动，退而测其前提——用 vm 沙箱按 index.html 同款
// 加载顺序（marked → katex → marked-katex-extension UMD）执行真实 vendor 资产，
// 观察渲染 HTML 输出；页面接线经 HTTP 看首页源码。「明暗主题可读性」由用户
// 手动冒烟（与 T3 断网冒烟同一惯例），此处自动验证其前提：公式颜色继承页面主题。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, REPO_ROOT } = require('./helpers');

// 在 vm 沙箱里复刻浏览器脚本加载：marked → katex → marked-katex-extension（UMD
// 全局挂载，markedKatex 依赖 window.katex），再按 index.html 同款接线启用扩展。
// 沙箱里没有 module/exports/define → UMD 走浏览器分支挂全局，与真实页面一致。
function loadBrowserPipeline() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['marked.min.js', 'katex.min.js', 'marked-katex-extension.umd.js']) {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'public', 'vendor', f), 'utf-8');
    vm.runInContext(src, sandbox, { filename: f });
  }
  vm.runInContext(
    'window.marked.use(window.markedKatex({ throwOnError: false }));',
    sandbox, { filename: 'index.html <script> 接线' }
  );
  return sandbox;
}

test('浏览器管线（真实 vendor 资产）：行内 / 块级公式渲染为 KaTeX 静态 HTML', () => {
  const sandbox = loadBrowserPipeline();
  const inline = vm.runInContext('window.marked.parse("质能 $E = mc^2$ 是行内公式。")', sandbox);
  assert.ok(inline.includes('class="katex"'), '行内公式应渲染为 KaTeX HTML（class="katex"）');
  assert.ok(!inline.includes('$E = mc^2$'), '行内公式不应以 $...$ 纯文本出现');

  const block = vm.runInContext('window.marked.parse("$$\\\\frac{a}{b}$$")', sandbox);
  assert.ok(block.includes('class="katex"'), '块级公式应渲染为 KaTeX HTML');
  assert.ok(block.includes('katex-display'), '块级公式应有 katex-display 容器（居中挂载点）');
  assert.ok(!block.includes('$$\\frac{a}{b}$$'), '块级公式不应以 $$...$$ 纯文本出现');

  // 块级居中由本地 katex.min.css 的 .katex-display 规则落地（真实资产断言，非实现细节）
  const css = fs.readFileSync(path.join(REPO_ROOT, 'public', 'vendor', 'katex.min.css'), 'utf-8');
  assert.match(css, /\.katex-display\{[^}]*text-align:center/, 'katex.min.css 应含 .katex-display 居中样式');

  // 暗色主题可读前提：公式 HTML 不携带内联 color/background——颜色继承页面
  // data-theme 正文色（KaTeX 排版跟随主题切换，无需按主题重算公式节点）
  assert.ok(!inline.includes('color:') && !inline.includes('background'),
    '公式输出不应携带内联颜色样式（须继承页面主题）');
});

test('浏览器管线：坏公式降级显示源码，不抛错', () => {
  const sandbox = loadBrowserPipeline();
  // 未闭合 $：无法配对成公式 → 原样文本（parse 不抛错本身就是断言的一部分）
  const unclosed = vm.runInContext('window.marked.parse("未闭合 $ E = mc^2 没有结尾")', sandbox);
  assert.ok(!unclosed.includes('class="katex"'), '未闭合 $ 不应触发渲染');
  assert.ok(unclosed.includes('$ E = mc^2 没有结尾'), '未闭合公式源码应原样显示');
  // 配对但 KaTeX 解析失败 → katex-error 降级，段落其余文本保留，整页不炸
  const broken = vm.runInContext('window.marked.parse("配对但解析失败 $\\\\frac{$ 继续")', sandbox);
  assert.ok(broken.includes('katex-error'), '解析失败公式应降级为 katex-error 显示');
  assert.ok(broken.includes('继续'), '坏公式段落的其余文本应正常渲染');
});

test('浏览器管线：$5 货币、代码块内 $ 不误渲染（编辑预览同管线受益）', () => {
  const sandbox = loadBrowserPipeline();
  const edge = vm.runInContext([
    'window.marked.parse("价格在 $5 到 $10 之间。\\n\\n```js\\nconst s = `${x}`; // 代码块里的 $\\n```")',
  ].join(''), sandbox);
  assert.ok(!edge.includes('class="katex"'), '边界文本不应触发 KaTeX 渲染');
  assert.ok(edge.includes('$5 到 $10'), '货币 $5/$10 应原样保留');
  assert.ok(edge.includes('${x}'), '代码块内的 $ 应原样保留');
});

test('首页接线：引用 vendor 化 katex 三资产，并接入 marked.use(markedKatex)', async t => {
  const base = mkTempDir('lanbook-t10-index-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-t10-index-data-');
  t.after(() => { removeInstallDir(installDir); for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  const r = await srv.fetch('/');
  assert.equal(r.status, 200);
  const html = await r.text();

  // 资产引用：UMD 扩展 + KaTeX JS/CSS 全部本地 vendor（引用断言与零外部 CDN
  // 由 frontend-vendor.test.js 首页用例覆盖，此处聚焦渲染接线完整性）
  for (const p of ['/vendor/marked-katex-extension.umd.js', '/vendor/katex.min.js', '/vendor/katex.min.css']) {
    assert.ok(html.includes(p), `首页应引用本地资产 ${p}`);
  }
  // 管线接线：客户端 marked 实例启用数学扩展（知识库视图 loadFile 与编辑预览
  // toggleEdit / updatePreview 共用该实例，一次接入即覆盖两入口）
  assert.match(html, /marked\.use\(\s*markedKatex\(/, '首页应存在 marked.use(markedKatex(...)) 接线');
  await srv.stop();
});
