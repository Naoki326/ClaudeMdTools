'use strict';
// 课程索引的唯一生产入口。HTTP 热路径只查当前快照，不扫描外部根目录。
// 资源约束：串行异步遍历、single-flight、有限缓存、有限 watcher、低占空比发现。
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const chokidar = require('chokidar');

const DEFAULT_LIMITS = Object.freeze({
  directories: 50000, workspaces: 512, files: 10000,
  scanMs: 30000, titleBytes: 16384, titleChars: 512, watchDirectories: 2048, watchFiles: 10000,
});
const norm = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

function createCourseService({ dataDir, resolveRoot, knowledge, onChange,
  discoveryIntervalMs = 30000, debounceMs = 500, limits: overrides,
  watch = (...args) => chokidar.watch(...args), logger = console,
}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const configFile = path.join(dataDir, 'teach.config.json');
  let snapshot = null;
  let titles = new Map();
  let flight = null;
  let previewFlight = null;
  let revision = 0;
  let resourceRevision = 0;
  let publishedResourceRevision = 0;
  let pending = false;
  let discoveryPending = false;
  let closed = false;
  let started = false;
  let pollTimer = null;
  let debounceTimer = null;
  let watcher = null;
  let watcherKey = null;
  let watchDirs = new Set();
  let watchFiles = new Set();
  let lastDelay = discoveryIntervalMs;
  let lastError = null;
  let watchLimitWarned = false;
  let watcherLimited = false;
  let watcherCloseFailed = false;
  const counters = { discoveries: 0, rebuilds: 0, activeScans: 0, maxActiveScans: 0 };

  function readConfig() {
    try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
    catch { return { roots: [] }; }
  }
  function writeConfig(config) {
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
  }
  function policy(config) {
    const excluded = knowledge.getExcludedSet(['worktree-archive', ...(config.excludeDirs || [])]);
    const skip = p => p.split(/[\\/]+/).some(s => excluded.has(s.toLowerCase()))
      || knowledge.isExcluded(p, path.basename(p), excluded);
    return { excluded, skip, key: JSON.stringify([config.roots || [], [...excluded].sort()]) };
  }
  function budget() {
    const deadline = Date.now() + limits.scanMs;
    let directories = 0;
    let files = 0;
    return {
      check() {
        if (closed) throw Object.assign(new Error('课程索引已关闭'), { code: 'COURSES_CLOSED' });
        if (Date.now() > deadline) throw new Error(`课程扫描超过 ${limits.scanMs}ms 预算，请缩小课程根目录`);
      },
      directory() {
        this.check();
        if (++directories > limits.directories) throw new Error(`课程扫描超过 ${limits.directories} 个目录预算，请缩小课程根目录`);
      },
      file() {
        this.check();
        if (++files > limits.files) throw new Error(`课程索引超过 ${limits.files} 个文件预算，请缩小课程根目录`);
      },
    };
  }
  async function isDir(p) {
    try { return (await fsp.lstat(p)).isDirectory(); } catch { return false; }
  }
  async function entries(dir, b, visit) {
    b.directory();
    let handle;
    try { handle = await fsp.opendir(dir, { bufferSize: 256 }); }
    catch (err) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) return;
      throw err;
    }
    // opendir 按批读取；即使单目录有海量文件也不一次性装入数组。
    for await (const e of handle) { b.check(); await visit(e); }
  }
  async function findWorkspaces(roots, p, b) {
    if (roots.length > 256) throw new Error('课程根目录超过 256 个预算');
    const seen = new Set();
    const found = [];
    async function walk(dir, depth) {
      b.check();
      // 同一目录作为配置容器与作为子工作区是两种访问，不能互相吞掉。
      const key = (depth === 0 ? 'container:' : 'workspace:') + norm(dir);
      if (depth > 8 || p.skip(dir) || seen.has(key)) return;
      seen.add(key);
      if (!await isDir(dir)) return; // 不跟随配置根或嵌套 junction / symlink。
      // 保持配置根作为发现容器的既有语义：根自身有 lessons/ 也仍查找子工作区。
      // 否则像 RobimSrc 这样兼有 lessons/ 的大型根会吞掉其全部子项目课程。
      if (depth > 0 && await isDir(path.join(dir, 'lessons'))) {
        if (found.length >= limits.workspaces) throw new Error(`课程超过 ${limits.workspaces} 个工作区预算`);
        found.push(dir);
        return;
      }
      await entries(dir, b, async e => {
        if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
      });
    }
    for (const root of roots) await walk(resolveRoot(root), 0);
    return found;
  }
  async function title(file, type, nextTitles, b) {
    b.check();
    try {
      const stat = await fsp.lstat(file);
      if (!stat.isFile()) return null;
      const identity = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      const cached = titles.get(file);
      if (cached && cached.identity === identity) { nextTitles.set(file, cached); return cached; }
      // 只读头部提取标题，绝不缓存 HTML 正文 / 图片 / CSS。
      const handle = await fsp.open(file, 'r');
      let text;
      try {
        const buffer = Buffer.alloc(Math.min(limits.titleBytes, stat.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
      const value = type === 'mission'
        ? text.match(/^#\s*Mission:?\s*(.+)$/m)?.[1]?.trim() || null
        : knowledge.titleFromHtml(text) || path.basename(file).replace(/\.html$/i, '');
      const boundedTitle = value?.slice(0, limits.titleChars) || null;
      // 不让短标题子串持有整块读取缓冲解码后的正文头部。
      const item = { identity, value: boundedTitle === null ? null : Buffer.from(boundedTitle, 'utf8').toString('utf8'), mtime: stat.mtimeMs };
      nextTitles.set(file, item);
      return item;
    } catch (err) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) return null;
      throw err;
    }
  }
  async function content(wsPath, p, nextTitles, b) {
    const result = { lessons: [], reference: [] };
    for (const kind of ['lessons', 'reference']) {
      const base = path.join(wsPath, kind);
      async function walk(dir, depth) {
        if (depth > 8 || p.skip(dir) || !await isDir(dir)) return;
        await entries(dir, b, async e => {
          const full = path.join(dir, e.name);
          if (p.skip(full)) return;
          if (e.isDirectory()) await walk(full, depth + 1);
          else if (e.isFile() && /\.html$/i.test(e.name)) {
            b.file();
            const meta = await title(full, 'html', nextTitles, b);
            if (meta) result[kind].push({ file: path.relative(base, full).replace(/\\/g, '/'), title: meta.value, mtime: meta.mtime });
          }
        });
      }
      await walk(base, 0);
      result[kind].sort((a, b) => a.file.localeCompare(b.file));
    }
    return result;
  }
  function warnWatchLimit() {
    watcherLimited = true;
    if (watchLimitWarned) return;
    watchLimitWarned = true;
    logger.warn('[courses] 达到课程监听预算，超出部分的列表变化由定期索引发现，CSS/JS 可能需手动刷新；请缩小课程根目录');
  }
  async function syncWatcher(workspaces, p, reconcile = false) {
    const key = JSON.stringify([workspaces.map(w => norm(w.path)).sort(), p.key]);
    if ((key === watcherKey && !reconcile) || closed || watcherCloseFailed) return;
    // 必须等旧 watcher 释放后才建新的，反复保存配置也不会叠加监听。
    if (watcher) {
      try { await watcher.close(); }
      catch (err) {
        watcherCloseFailed = watcherLimited = true;
        logger.error('[courses] 旧监听关闭失败，停止新建监听并保留定期索引刷新:', err.message);
        return;
      }
      watcher = null;
    }
    watcherKey = null;
    watchDirs = new Set(); watchFiles = new Set(); watcherLimited = false;
    if (closed) return;
    const paths = workspaces.map(w => w.path);
    if (paths.length) {
      watcher = watch(paths, {
        followSymlinks: false, ignoreInitial: true, depth: 8,
        // 不使用 polling / awaitWriteFinish 的持续轮询；应用层合并写入事件。
        usePolling: false,
        ignored: (file, stat) => {
          if (p.skip(file) || knowledge.isWatcherIgnored(file, p.excluded)) return true;
          if (!stat) return false;
          if (stat.isSymbolicLink()) return true;
          const key = norm(file);
          const dirs = stat.isDirectory();
          if (!dirs && !/\.(html|css|js)$/i.test(file) && path.basename(file) !== 'MISSION.md') return true;
          if (!dirs && typeof stat.mode === 'number' && !(stat.mode & 0o400)) return true;
          const set = dirs ? watchDirs : watchFiles;
          const limit = dirs ? limits.watchDirectories : limits.watchFiles;
          if (!set.has(key) && set.size >= limit) { warnWatchLimit(); return true; }
          set.add(key);
          return false;
        },
      });
      watcher.on('error', err => knowledge.onWatcherError('teach', err));
      watcher.on('all', (event, file) => {
        const key = norm(file);
        if (event === 'unlink') watchFiles.delete(key);
        if (event === 'unlinkDir') {
          for (const p of watchDirs) if (inside(p, key)) watchDirs.delete(p);
          for (const p of watchFiles) if (inside(p, key)) watchFiles.delete(p);
        }
        if (event.endsWith('Dir') || /\.(html|css|js)$/i.test(file) || path.basename(file) === 'MISSION.md') {
          resourceRevision++;
          scheduleContent(event);
        }
      });
    }
    watcherKey = key;
  }
  function armPoll() {
    if (closed || !started || pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      requestRefresh(true).catch(() => {});
    }, lastDelay);
    pollTimer.unref?.();
  }
  function scheduleContent(event = 'change') {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      requestRefresh(false, event).catch(() => {});
    }, debounceMs);
    debounceTimer.unref?.();
  }
  let pendingEvent = 'change';
  function requestRefresh(discover, event = 'change') {
    if (closed) return Promise.resolve();
    pending = true;
    discoveryPending ||= discover;
    pendingEvent = event;
    revision++;
    if (flight) return flight;
    flight = (async () => {
      // 每轮最多两趟；持续配置/文件风暴不霸占执行器，剩余任务去抖后再做。
      for (let pass = 0; pending && !closed && pass < 2; pass++) {
        pending = false;
        const gen = revision;
        const resourceGen = resourceRevision;
        const event = pendingEvent;
        const config = readConfig();
        const p = policy(config);
        const discover = discoveryPending || !snapshot || snapshot.key !== p.key;
        discoveryPending = false;
        const b = budget();
        const start = Date.now();
        counters.activeScans++;
        counters.maxActiveScans = Math.max(counters.maxActiveScans, counters.activeScans);
        try {
          if (discover) counters.discoveries++;
          const paths = discover ? await findWorkspaces(config.roots || [], p, b) : snapshot.workspaces.map(w => w.path);
          const nextTitles = new Map();
          const workspaces = [];
          const used = new Set();
          // 保持仍存在的课程 ID，新增/删除同名课程不能让已打开链接串到另一课程。
          const oldIds = new Map((snapshot?.workspaces || []).map(w => [norm(w.path), w.id]));
          for (const wsPath of paths) if (oldIds.has(norm(wsPath))) used.add(oldIds.get(norm(wsPath)));
          for (const wsPath of paths) {
            b.check();
            if (!await isDir(path.join(wsPath, 'lessons'))) continue;
            const name = path.basename(wsPath);
            let id = oldIds.get(norm(wsPath));
            if (!id) {
              id = name; let n = 2;
              while (used.has(id)) id = `${name}-${n++}`;
              used.add(id);
            }
            b.file();
            const mission = await title(path.join(wsPath, 'MISSION.md'), 'mission', nextTitles, b);
            workspaces.push({ id, name, title: mission?.value || name, path: wsPath, ...await content(wsPath, p, nextTitles, b) });
          }
          b.check();
          // 在飞扫描不得吞掉配置/文件失效；丢弃旧代结果，下一趟再建。
          if (closed || gen !== revision) { discoveryPending ||= discover; continue; }
          // 超限时定期重新核对监听准入，回收监听落地前消失且无 unlink 的预留。
          await syncWatcher(workspaces, p, discover && watcherLimited);
          if (closed || gen !== revision) { discoveryPending ||= discover; continue; }
          const rows = workspaces.map(({ path: _, ...row }) => row);
          const signature = JSON.stringify(rows);
          const previous = snapshot;
          snapshot = { key: p.key, workspaces, rows, byId: new Map(workspaces.map(w => [w.id, w])), signature };
          titles = nextTitles; // 替换而非累加：删除文件、移除根目录会释放旧缓存。
          counters.rebuilds++;
          if (!previous || previous.signature !== signature) {
            logger.log(`[courses] 索引更新: workspaces=${rows.length} files=${titles.size} ${Date.now() - start}ms`);
          }
          // CSS/JS 内容不入列表，但编辑后仍须通知 iframe 刷新。
          if (previous && (previous.signature !== signature || resourceGen > publishedResourceRevision)) {
            onChange?.({ type: 'course-change', event });
          }
          publishedResourceRevision = resourceGen;
          lastError = null;
          if (discover) lastDelay = Math.min(300000, Math.max(discoveryIntervalMs, (Date.now() - start) * 50));
        } finally { counters.activeScans--; }
      }
    })().catch(err => {
      if (!closed) {
        if (err.message !== lastError) logger.error('[courses] 索引刷新失败（保留上次快照）:', err.message);
        lastError = err.message;
        lastDelay = Math.min(300000, Math.max(discoveryIntervalMs, lastDelay * 2));
      }
      throw err;
    }).finally(() => {
      flight = null;
      if (!closed && pending) scheduleContent();
      armPoll();
    });
    return flight;
  }
  async function ready() {
    if (closed) throw new Error('课程索引已关闭');
    if (!snapshot) await (flight || requestRefresh(true));
    if (!snapshot) throw new Error('课程索引尚未就绪');
    return snapshot;
  }
  async function preview(roots) {
    if (closed) throw new Error('课程索引已关闭');
    if (roots.length > 256) throw new Error('课程根目录超过 256 个预算');
    const config = { ...readConfig(), roots };
    const key = JSON.stringify(config);
    if (previewFlight) {
      if (previewFlight.key === key) return previewFlight.promise;
      throw Object.assign(new Error('课程预览正在进行，请稍后重试'), { status: 429 });
    }
    const promise = (async () => {
      const p = policy(config);
      const b = budget();
      const result = [];
      for (const root of roots) {
        const rootPath = resolveRoot(String(root));
        const exists = await isDir(rootPath);
        const paths = exists ? await findWorkspaces([rootPath], p, b) : [];
        result.push({ root, exists, workspaces: paths.map(w => path.relative(rootPath, w).replace(/\\/g, '/') || '.') });
      }
      return result;
    })();
    previewFlight = { key, promise };
    try { return await promise; } finally { previewFlight = null; }
  }
  async function close() {
    closed = true;
    if (pollTimer) clearTimeout(pollTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    pollTimer = debounceTimer = null;
    await Promise.allSettled([flight, previewFlight?.promise]);
    if (watcher) await watcher.close();
    watcher = null; watcherKey = null;
    watchDirs.clear(); watchFiles.clear(); titles.clear(); snapshot = null;
  }
  return {
    readConfig, writeConfig, preview,
    start() { if (started) return flight || Promise.resolve(); started = true; return requestRefresh(true); },
    refresh() { return requestRefresh(true); },
    async list() { return (await ready()).rows; },
    async workspace(id) { return (await ready()).byId.get(id); },
    close,
    // 本地诊断/测试接缝；不增加对局域网暴露的 HTTP 管理端点。
    diagnostics() {
      return { ...counters, cachedTitles: titles.size, workspaces: snapshot?.rows.length || 0,
        watchDirectories: watchDirs.size, watchFiles: watchFiles.size, watchers: watcher ? 1 : 0,
        timers: Number(!!pollTimer) + Number(!!debounceTimer), nextDiscoveryMs: lastDelay, closed };
    },
  };
}
module.exports = { createCourseService, DEFAULT_LIMITS };
