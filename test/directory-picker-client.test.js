'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const index = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const pickerFile = path.join(__dirname, '../public/directory-picker.js');
const tick = () => new Promise(r => setImmediate(r));
function app() {
  const requests = [], overlays = [];
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.handlers = {}; this.ids = new Map(); this.value = ''; this.disabled = false; this.hidden = false; this.textContent = ''; this.attrs = {}; }
    set innerHTML(value) { this.markup = value; this.children = []; this.ids.clear(); for (const match of value.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) this.ids.set(match[2], new Element(match[1])); }
    get innerHTML() { return this.markup || ''; }
    querySelector(selector) { return this.ids.get(selector.slice(1)); }
    querySelectorAll() { return [...this.ids.values()].filter(e => ['INPUT', 'BUTTON', 'SELECT'].includes(e.tagName) && !e.disabled && !e.hidden); }
    setAttribute(k, v) { this.attrs[k] = v; }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    dispatchEvent(event) { for (const fn of this.handlers[event.type] || []) fn(event); return true; }
    click() { if (!this.disabled) this.dispatchEvent({ type: 'click', target: this, preventDefault() {} }); }
    focus() { sandbox.document.activeElement = this; }
    remove() { this.removed = true; }
  }
  const target = new Element('input'); target.value = '';
  const sandbox = {
    URLSearchParams, AbortController,
    Event: class { constructor(type) { this.type = type; } },
    document: {
      activeElement: null,
      getElementById: id => id === 'new-root' || id === 'kb-new-root' ? target : null,
      createElement: tag => new Element(tag),
      body: { appendChild(overlay) { overlays.push(overlay); } },
    },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.existsSync(pickerFile) ? fs.readFileSync(pickerFile, 'utf8') : '', sandbox);
  return {
    target, requests, overlays, sandbox,
    open: () => sandbox.openDirectoryPicker('new-root'),
    get overlay() { return overlays.at(-1); },
    control(id) { return overlays.at(-1).querySelector('#' + id); },
    reply(n, data = {}) { requests[n].resolve({ ok: true, json: async () => ({ path: 'C:/Work', parent: 'C:/', home: 'C:/Users/user', locations: [], directories: [], offset: 0, limit: 200, hasMore: false, truncated: false, ...data }) }); },
    navigate(p) { this.control('directory-picker-path').value = p; this.control('directory-picker-form').dispatchEvent({ type: 'submit', preventDefault() {} }); },
  };
}
test('两种设置均提供 HTML 浏览按钮，保留手动输入和添加，不用系统选择器', () => {
  assert.match(index, /openDirectoryPicker\('new-root'\)/);
  assert.match(index, /openDirectoryPicker\('kb-new-root'\)/);
  assert.match(index, /src="\/directory-picker\.js"/);
  const source = fs.existsSync(pickerFile) ? fs.readFileSync(pickerFile, 'utf8') : '';
  assert.doesNotMatch(source, /showDirectoryPicker|webkitdirectory|type=["']file/);
});
test('按需进入子目录/返回上级，选择当前目录只回填路径不自动保存', async () => {
  const a = app(); a.open();
  assert.equal(a.requests.length, 1);
  a.reply(0, { directories: [{ name: "项目 'A'", path: "C:/Work/项目 'A'" }] }); await tick();
  a.control('directory-picker-list').children[0].click();
  assert.equal(new URL(a.requests[1].url, 'http://localhost').searchParams.get('path'), "C:/Work/项目 'A'");
  a.reply(1, { path: "C:/Work/项目 'A'", parent: 'C:/Work' }); await tick();
  a.control('directory-picker-up').click();
  assert.equal(new URL(a.requests[2].url, 'http://localhost').searchParams.get('path'), 'C:/Work');
  a.reply(2); await tick();
  a.control('directory-picker-choose').click();
  assert.equal(a.target.value, 'C:/Work');
  assert.equal(a.overlay.removed, true);
  assert.equal(a.requests.length, 3, '选择文件夹不能修改服务器配置或扫描课程根');
  assert.equal(a.sandbox.document.activeElement, a.target);
});
test('路径导航失败可见提示且不能误选旧目录，之后可以重试', async () => {
  const a = app(); a.open(); a.reply(0); await tick();
  a.navigate('C:/missing');
  a.requests[1].resolve({ ok: false, json: async () => ({ error: '目录不存在' }) }); await tick();
  assert.equal(a.control('directory-picker-choose').disabled, true);
  assert.equal(a.control('directory-picker-status').textContent, '目录不存在');
  a.navigate('D:/'); a.reply(2, { path: 'D:/', parent: null }); await tick();
  assert.equal(a.control('directory-picker-up').disabled, true);
  a.control('directory-picker-choose').click(); assert.equal(a.target.value, 'D:/');
});
test('初始手输路径无效时仍可通过主目录恢复浏览', async () => {
  const a = app(); a.target.value = 'C:/bad'; a.open();
  a.requests[0].resolve({ ok: false, json: async () => ({ error: '目录不存在' }) }); await tick();
  assert.equal(a.control('directory-picker-home').disabled, false);
  a.control('directory-picker-home').click();
  assert.equal(new URL(a.requests[1].url, 'http://localhost').searchParams.get('path'), '');
  a.reply(1); await tick();
  assert.equal(a.control('directory-picker-choose').disabled, false);
});

test('取消中止请求、忽略迟到结果，不修改输入，也不保留活动弹窗', async () => {
  const a = app(); a.target.value = 'C:/typed'; a.open();
  a.control('directory-picker-cancel').click();
  assert.equal(a.requests[0].options.signal.aborted, true);
  a.reply(0); await tick();
  assert.equal(a.target.value, 'C:/typed'); assert.equal(a.overlay.removed, true);
  a.open(); assert.equal(a.overlays.length, 2);
});
test('快速前往新路径时旧请求返回不能覆盖新目录；失败不产生未处理拒绝', async () => {
  const a = app(); a.open(); a.navigate('D:/');
  assert.equal(a.requests[0].options.signal.aborted, true);
  a.reply(1, { path: 'D:/', parent: null }); await tick();
  a.reply(0, { path: 'C:/old' }); await tick();
  a.control('directory-picker-choose').click(); assert.equal(a.target.value, 'D:/');
  a.open(); a.requests[2].reject(new Error('offline')); await tick();
  assert.equal(a.control('directory-picker-choose').disabled, true);
  assert.ok(a.control('directory-picker-status').textContent);
});
test('分页加载只请求当前层下一页，目录名以文本渲染', async () => {
  const a = app(); a.open();
  a.reply(0, { directories: [{ name: '<img onerror=alert(1)>', path: 'C:/Work/a' }], hasMore: true }); await tick();
  const list = a.control('directory-picker-list');
  assert.equal(list.children[0].textContent, '📁 <img onerror=alert(1)>');
  a.control('directory-picker-more').click();
  assert.equal(new URL(a.requests[1].url, 'http://localhost').searchParams.get('offset'), '200');
  a.reply(1, { directories: [{ name: 'B', path: 'C:/Work/b' }], offset: 200 }); await tick();
  assert.equal(list.children.length, 2);
  assert.equal(a.control('directory-picker-more').hidden, true);
});
test('Escape 关闭弹窗；重复打开不会叠加活动请求', async () => {
  const a = app(); a.open(); const first = a.overlay;
  a.open(); assert.equal(first.removed, true); assert.equal(a.requests[0].options.signal.aborted, true);
  a.overlay.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {} });
  assert.equal(a.overlay.removed, true); assert.equal(a.requests[1].options.signal.aborted, true);
});
