/* HTML 内嵌服务端目录选择器：仅交互时读取一层目录，不持有目录缓存或计时器。 */
(function () {
  'use strict';
  let active = null;
  window.openDirectoryPicker = function (inputId) {
    const target = document.getElementById(inputId);
    if (!target) return;
    if (active) active.close();
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay directory-picker-overlay';
    overlay.innerHTML = `
      <div class="dialog settings-dialog directory-picker" role="dialog" aria-modal="true" aria-labelledby="directory-picker-title">
        <h3 id="directory-picker-title">📁 选择文件夹</h3>
        <div class="directory-picker-hint">浏览运行 lanbook 的电脑上的文件夹，不会上传文件。</div>
        <form id="directory-picker-form" class="directory-picker-path-row">
          <input id="directory-picker-path" type="text" aria-label="文件夹路径" placeholder="输入绝对路径，例如 C:/Work 或 D:/" autocomplete="off" spellcheck="false">
          <button class="btn" type="submit">前往</button>
        </form>
        <div class="directory-picker-toolbar">
          <button id="directory-picker-up" class="btn" type="button">↑ 上一级</button>
          <button id="directory-picker-home" class="btn" type="button">主目录</button>
          <select id="directory-picker-locations" aria-label="常用位置"></select>
        </div>
        <div id="directory-picker-list" class="directory-picker-list" aria-label="子文件夹"></div>
        <button id="directory-picker-more" class="btn directory-picker-more" type="button" hidden>加载更多文件夹</button>
        <div id="directory-picker-status" class="directory-picker-status" role="status" aria-live="polite"></div>
        <div class="dialog-actions">
          <button id="directory-picker-cancel" class="btn" type="button">取消</button>
          <button id="directory-picker-choose" class="btn btn-primary" type="button" disabled>选择此文件夹</button>
        </div>
      </div>`;
    const get = id => overlay.querySelector('#directory-picker-' + id);
    const pathInput = get('path'), list = get('list'), status = get('status');
    const choose = get('choose'), up = get('up'), homeButton = get('home');
    const locations = get('locations'), more = get('more');
    let current = null, home = null, parent = null;
    let count = 0, nextOffset = 0, epoch = 0, controller = null;
    const context = { close };
    active = context;

    function close() {
      if (active !== context) return;
      active = null;
      epoch++;
      if (controller) controller.abort();
      overlay.remove();
      target.focus();
    }
    async function navigate(dir, append = false) {
      if (active !== context) return;
      if (controller) controller.abort();
      controller = new AbortController();
      const request = ++epoch;
      const offset = append ? nextOffset : 0;
      if (!append) {
        current = null; parent = null; count = 0;
        get('title').textContent = '📁 选择文件夹';
        list.replaceChildren(); more.hidden = true;
        pathInput.value = dir;
      }
      choose.disabled = up.disabled = more.disabled = true;
      homeButton.disabled = false;
      status.textContent = '正在读取文件夹…';
      overlay.setAttribute('aria-busy', 'true');
      try {
        const query = new URLSearchParams({ path: dir, offset: String(offset) });
        const response = await fetch('/api/directories?' + query, { signal: controller.signal });
        const data = await response.json();
        if (active !== context || request !== epoch) return;
        if (!response.ok) throw new Error(data.error || '无法读取文件夹，请重试');
        if (typeof data.path !== 'string' || !Array.isArray(data.directories)) throw new Error('目录响应无效，请重试');
        current = data.path;
        parent = typeof data.parent === 'string' ? data.parent : null;
        home = typeof data.home === 'string' ? data.home : null;
        pathInput.value = current;
        get('title').textContent = '📁 选择文件夹 · ' + (current.split(/[\\/]/).filter(Boolean).pop() || current);
        if (!append) {
          locations.replaceChildren();
          const placeholder = document.createElement('option');
          placeholder.value = ''; placeholder.textContent = '常用位置…'; locations.appendChild(placeholder);
          for (const location of (data.locations || []).slice(0, 64)) {
            if (typeof location.path !== 'string' || typeof location.name !== 'string') continue;
            const option = document.createElement('option');
            option.value = location.path; option.textContent = location.name;
            locations.appendChild(option);
          }
        }
        for (const entry of data.directories.slice(0, 200)) {
          if (count >= 5000) break;
          if (typeof entry.name !== 'string' || typeof entry.path !== 'string') continue;
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'directory-picker-entry';
          // 路径与名字只经过 value/textContent，绝不拼进 HTML 或 onclick。
          button.textContent = '📁 ' + entry.name;
          button.addEventListener('click', () => navigate(entry.path));
          list.appendChild(button); count++;
        }
        nextOffset = offset + 200;
        more.hidden = !data.hasMore || count >= 5000;
        status.textContent = count ? `已显示 ${count} 个文件夹` : '当前文件夹下没有子文件夹，仍可选择当前文件夹';
        if (data.truncated || count >= 5000) status.textContent += '；目录项较多，请输入更具体的路径';
      } catch (err) {
        if (active !== context || request !== epoch) return;
        status.textContent = err.name === 'AbortError' ? '读取已取消，请重新前往' : (err.message || '读取失败，请重试');
      } finally {
        if (active === context && request === epoch) {
          choose.disabled = !current;
          up.disabled = !current || !parent;
          homeButton.disabled = false;
          more.disabled = false;
          overlay.setAttribute('aria-busy', 'false');
        }
      }
    }
    get('form').addEventListener('submit', event => { event.preventDefault(); navigate(pathInput.value.trim()); });
    up.addEventListener('click', () => { if (parent) navigate(parent); });
    homeButton.addEventListener('click', () => navigate(home || ''));
    locations.addEventListener('change', () => { if (locations.value) navigate(locations.value); });
    more.addEventListener('click', () => { if (current) navigate(current, true); });
    get('cancel').addEventListener('click', close);
    choose.addEventListener('click', () => {
      if (!current || choose.disabled) return;
      target.value = current;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      close();
    });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const focusable = [...overlay.querySelectorAll('button:not(:disabled):not([hidden]), input, select')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    document.body.appendChild(overlay);
    pathInput.focus();
    navigate(target.value.trim());
  };
})();
