'use strict';
// Ticket #3（lanbook T3 · 前端三件套 vendor 离线自足）进程边界测试
// 覆盖验收标准：三件套本地资产 GET 200、页面源码零 cdnjs / 外部 CDN 引用
// （首页 index.html + 知识库渲染页 /api/knowledge/view）。
// Ticket #8（lanbook T1 · KaTeX vendor 资产进包）：新增 KaTeX JS / CSS / 字体资产断言。
// 「断网手动冒烟」由用户执行；此处自动验证其前提：资产本地可达 + 页面不引外部资源。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer } = require('./helpers');

// 断言页面源码零外部 CDN 引用：
// 1) 全文不得出现 cdnjs 字样；2) <script src> / <link href> 不得指向 http(s) 绝对地址
function assertNoExternalAssets(html, pageName) {
  assert.doesNotMatch(html, /cdnjs/i, `${pageName} 不应出现 cdnjs 引用`);
  const refs = [...html.matchAll(/<(script|link)\b[^>]*?\b(src|href)\s*=\s*["']([^"']+)["']/gi)];
  for (const m of refs) {
    assert.doesNotMatch(
      m[3], /^https?:\/\//i,
      `${pageName} 的 <${m[1].toLowerCase()} ${m[2]}> 引用了外部地址: ${m[3]}`
    );
  }
}

test('vendor 三件套 + 明暗两套高亮样式本地资产 GET 200', async t => {
  const base = mkTempDir('lanbook-t3-assets-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-t3-assets-data-');
  t.after(() => { removeInstallDir(installDir); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });

  const assets = [
    '/vendor/marked.min.js',
    '/vendor/highlight.min.js',
    '/vendor/mermaid.min.js',
    '/vendor/github.min.css',
    '/vendor/github-dark.min.css',
  ];
  for (const p of assets) {
    const r = await srv.fetch(p);
    assert.equal(r.status, 200, `${p} 应 200`);
    const body = await r.text();
    assert.ok(body.length > 1000, `${p} 内容不应为空壳（长度 ${body.length}）`);
  }
  await srv.stop();
});

test('vendor KaTeX 资产（JS / CSS / 字体）本地 GET 200、非空壳', async t => {
  const base = mkTempDir('lanbook-t8-katex-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-t8-katex-data-');
  t.after(() => { removeInstallDir(installDir); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });

  // 文本资产：与三件套同一断言模式（200 + 长度 > 1000 非空壳）
  for (const p of ['/vendor/katex.min.js', '/vendor/katex.min.css']) {
    const r = await srv.fetch(p);
    assert.equal(r.status, 200, `${p} 应 200`);
    const body = await r.text();
    assert.ok(body.length > 1000, `${p} 内容不应为空壳（长度 ${body.length}）`);
  }

  // 字体（二进制，按字节数断言）：Main-Regular 为 AC 指定项，尺寸合理 > 5KB；
  // Math-Italic / Size2 覆盖变量斜体与 \frac 大算符两类高频字形，非空壳即可
  for (const p of ['/vendor/fonts/KaTeX_Main-Regular.woff2', '/vendor/fonts/KaTeX_Math-Italic.woff2', '/vendor/fonts/KaTeX_Size2-Regular.woff2']) {
    const r = await srv.fetch(p);
    assert.equal(r.status, 200, `${p} 应 200`);
    const buf = await r.arrayBuffer();
    const minBytes = p.endsWith('KaTeX_Main-Regular.woff2') ? 5 * 1024 : 1024;
    assert.ok(buf.byteLength > minBytes, `${p} 字体文件尺寸不合理（${buf.byteLength}B，要求 > ${minBytes}B）`);
  }
  await srv.stop();
});

test('首页零 cdnjs / 外部 CDN 引用，改引本地 vendor 资产', async t => {
  const base = mkTempDir('lanbook-t3-index-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-t3-index-data-');
  t.after(() => { removeInstallDir(installDir); try { fs.rmSync(base, { recursive: true, force: true }); } catch {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} });

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  const r = await srv.fetch('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assertNoExternalAssets(html, '首页 index.html');
  // 三件套确实从本地 vendor 加载（而非被整体删掉）
  for (const p of ['/vendor/marked.min.js', '/vendor/highlight.min.js', '/vendor/mermaid.min.js']) {
    assert.ok(html.includes(p), `首页应引用本地资产 ${p}`);
  }
  assert.ok(html.includes('/vendor/github.min.css'), '首页应引用明色高亮样式');
  assert.ok(html.includes('/vendor/github-dark.min.css'), '首页应引用暗色高亮样式');
  await srv.stop();
});

test('知识库渲染页零 cdnjs / 外部 CDN 引用，改引本地 vendor 资产', async t => {
  const base = mkTempDir('lanbook-t3-view-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-t3-view-data-');
  const kbRoot = mkTempDir('lanbook-t3-view-kb-');
  t.after(() => { removeInstallDir(installDir); for (const d of [base, dataDir, kbRoot]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

  // 数据目录预置知识库配置 + 含代码块与 mermaid 图的样例文档
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [kbRoot] }, null, 2), 'utf-8');
  fs.writeFileSync(path.join(kbRoot, 'sample.md'), [
    '# Vendor 冒烟样例',
    '',
    '```js',
    'const x = hljs.highlight("code", {language: "js"}).value;',
    '```',
    '',
    '```mermaid',
    'graph TD; A-->B;',
    '```',
    '',
  ].join('\n'), 'utf-8');

  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  const rootEnc = encodeURIComponent(kbRoot.replace(/\\/g, '/'));
  const r = await srv.fetch(`/api/knowledge/view?root=${rootEnc}&path=sample.md`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assertNoExternalAssets(html, '知识库渲染页');
  // 渲染页（服务端 marked 渲染）仍需本地 highlight.js + mermaid + 明暗两套样式
  for (const p of ['/vendor/highlight.min.js', '/vendor/mermaid.min.js', '/vendor/github.min.css', '/vendor/github-dark.min.css']) {
    assert.ok(html.includes(p), `渲染页应引用本地资产 ${p}`);
  }
  await srv.stop();
});
