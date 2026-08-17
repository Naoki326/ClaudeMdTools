'use strict';
// Ticket #9（lanbook T2 · 服务端渲染页 LaTeX 渲染）进程边界测试（spec #7 Testing Decisions #2）
// 覆盖验收标准：/api/knowledge/view 对 `$...$` 行内 / `$$...$$` 块级公式输出 KaTeX 静态 HTML；
// 坏公式降级（页面 200、源码原样显示、不抛错）；`$5` 货币 / `\$` 转义 / 代码块内 `$` 不误渲染。
// seam：真实服务进程 + 原生 fetch，只观察渲染 HTML 输出，不测 marked 管线内部。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer } = require('./helpers');

// 铺安装目录 + 数据目录（知识库配置指向临时 root），写入样例文档后启动服务
// 返回 { srv, fetchDoc }：fetchDoc() 即 GET 渲染页
async function startWithDoc(t, prefix, docContent, docName = 'sample.md') {
  const base = mkTempDir(prefix + '-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir(prefix + '-data-');
  const kbRoot = mkTempDir(prefix + '-kb-');
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [kbRoot] }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(kbRoot, docName), docContent, 'utf-8');
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir, kbRoot]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
  const rootEnc = encodeURIComponent(kbRoot.replace(/\\/g, '/'));
  const fetchDoc = () => srv.fetch(`/api/knowledge/view?root=${rootEnc}&path=${docName}`);
  return { srv, fetchDoc };
}

test('渲染页：行内 $...$ 与块级 $$...$$ 公式渲染为 KaTeX 静态 HTML', async t => {
  const { srv, fetchDoc } = await startWithDoc(t, 'lanbook-t9-render', [
    '# 公式样例',
    '',
    '质能方程 $E = mc^2$ 是行内公式。',
    '',
    '$$\\frac{a}{b}$$',
    '',
  ].join('\n'));

  const r = await fetchDoc();
  assert.equal(r.status, 200, '渲染页应 200');
  const html = await r.text();

  // KaTeX 渲染标记存在（公式已渲染为静态 HTML，而非纯文本）
  assert.ok(html.includes('class="katex"'), 'HTML 应含 KaTeX 渲染标记 class="katex"');
  assert.ok(html.includes('katex-display'), '块级公式应有 katex-display 容器');
  // 公式不再以 $ 包裹的纯文本出现（annotation 里保留的 TeX 源不含 $ 定界符）
  assert.ok(!html.includes('$E = mc^2$'), '行内公式不应以纯文本 $...$ 出现');
  assert.ok(!html.includes('$$\\frac{a}{b}$$'), '块级公式不应以纯文本 $$...$$ 出现');
  // KaTeX 排版依赖本地样式与字体（T1 vendor 资产），渲染页须引用
  assert.ok(html.includes('/vendor/katex.min.css'), '渲染页应引用本地 /vendor/katex.min.css');
  await srv.stop();
});

test('坏公式不抛错：页面仍 200，公式源码原样显示', async t => {
  const { srv, fetchDoc } = await startWithDoc(t, 'lanbook-t9-bad', [
    '# 坏公式样例',
    '',
    '未闭合 $ E = mc^2 没有结尾',
    '',
    '配对但解析失败 $\\frac{$ 继续',
    '',
  ].join('\n'));

  const r = await fetchDoc();
  assert.equal(r.status, 200, '含坏公式的页面应仍 200（不抛错）');
  const html = await r.text();

  // 未闭合 $：无法配对成公式，源码原样显示
  assert.ok(html.includes('$ E = mc^2 没有结尾'), '未闭合公式源码应原样显示');
  // 配对但 KaTeX 解析失败：降级为错误样式内联源码（katex-error），页面不炸、段落其余文本保留
  assert.ok(html.includes('katex-error'), '解析失败公式应降级为 katex-error 显示，而非 500');
  assert.ok(html.includes('继续'), '坏公式段落的其余文本应正常渲染');
  await srv.stop();
});

test('边界不误触发：$5 货币、\\$ 转义、代码块内 $ 均不渲染', async t => {
  const { srv, fetchDoc } = await startWithDoc(t, 'lanbook-t9-edge', [
    '# 边界样例',
    '',
    '价格在 $5 到 $10 之间。',
    '',
    '转义 \\$5 元显示为美元。',
    '',
    '```js',
    'const s = `${x}`; // 代码块里的 $',
    '```',
    '',
  ].join('\n'));

  const r = await fetchDoc();
  assert.equal(r.status, 200);
  const html = await r.text();

  // 整页无 KaTeX 渲染标记（用 class="katex" 精确匹配，避免误伤 katex.min.css 资源引用）
  assert.ok(!html.includes('class="katex"'), '边界文本不应触发 KaTeX 渲染');
  assert.ok(!html.includes('katex-error'), '边界文本不应进入公式降级路径');
  // 三类边界各自原样保留
  assert.ok(html.includes('$5 到 $10'), '货币 $5/$10 应原样保留');
  assert.ok(html.includes('元显示为美元'), '\\$ 转义后的正文应正常渲染');
  assert.ok(html.includes('${x}'), '代码块内的 $ 应原样保留在代码中');
  await srv.stop();
});
