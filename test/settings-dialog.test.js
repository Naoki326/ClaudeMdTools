'use strict';
// VM 执行真实弹窗函数，锁定两种设置共用的布局；几何与滚动另由浏览器验收。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]+)\\}'));
  assert.ok(match, `缺少布局规则 ${selector}`);
  return match[1];
}
function source(start, end) {
  const a = html.indexOf(start), b = html.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return html.slice(a, b);
}
async function dialog(kind) {
  const overlays = [];
  const roots = Array.from({ length: 40 }, (_, n) => `C:/projects/project-${n}`);
  const sandbox = {
    fetch: async () => ({ json: async () => ({ roots, excludeDirs: [] }) }),
    document: {
      createElement: () => ({ innerHTML: '', querySelector: () => ({ addEventListener() {} }) }),
      body: { appendChild: overlay => overlays.push(overlay) },
    },
    renderRootsList() {}, refreshRootPreview() {}, kbRenderList() {}, kbRefreshPreview() {},
    escapeHtml: s => s,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const fn = kind === 'courses' ? 'showCourseConfigDialog' : 'showKnowledgeConfigDialog';
  const end = kind === 'courses' ? '// 预览：调后端' : 'async function kbRefreshPreview';
  vm.runInContext(source(`async function ${fn}()`, end), sandbox);
  await vm.runInContext(`${fn}()`, sandbox);
  return { markup: overlays[0].innerHTML, roots: kind === 'courses' ? sandbox._pendingRoots : sandbox._kbPendingRoots };
}
for (const kind of ['courses', 'knowledge']) {
  test(`${kind} 设置使用受限弹窗和独立滚动目录列表，保存/取消不在列表中`, async () => {
    const { markup, roots } = await dialog(kind);
    assert.equal(roots.length, 40, '目录不能因布局限制被截断');
    assert.match(markup, /class="dialog settings-dialog"/);
    assert.doesNotMatch(markup, /min-width:\s*(480|520)px/);
    assert.match(markup, /id="(?:kb-)?roots-list" class="settings-roots-list"/);
    assert.ok(markup.indexOf('dialog-actions') > markup.indexOf('settings-roots-list'));
    assert.match(markup, />取消<\/button>/);
    assert.match(markup, />保存<\/button>/);
  });
}
test('弹窗适应视口，目录列表可收缩滚动，固定控件不挤出屏幕', () => {
  assert.match(rule('.dialog-overlay'), /padding:\s*16px/);
  const base = rule('.dialog');
  assert.match(base, /max-width:\s*100%/);
  assert.match(base, /max-height:\s*calc\(100dvh - 32px\)/);
  assert.match(base, /overflow-y:\s*auto/);
  assert.match(rule('.dialog.settings-dialog'), /flex-direction:\s*column/);
  assert.match(rule('.settings-dialog > *'), /flex-shrink:\s*0/);
  const list = rule('.settings-dialog > .settings-roots-list');
  assert.match(list, /flex:\s*0 1 auto/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /scrollbar-gutter:\s*stable/);
  assert.match(rule('.settings-root-row'), /flex-wrap:\s*wrap/);
  assert.match(rule('.settings-root-path'), /min-width:\s*0/);
});
