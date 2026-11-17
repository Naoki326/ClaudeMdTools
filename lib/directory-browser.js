'use strict';
// Read-only, current-level directory browser. No watchers, timers or retained listings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const LIMIT = 200;
const MAX_ENTRIES = 20000;
const MAX_DIRECTORIES = 5000;
const SCAN_MS = 3000;
const MAX_PATH = 8192;
const MAX_LOCATIONS = 64;

class BrowserError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function failure(err) {
  if (err instanceof BrowserError) return err;
  if (err?.code === 'EACCES' || err?.code === 'EPERM') return new BrowserError(403, '无权访问目录');
  if (err?.code === 'ENOENT') return new BrowserError(404, '目录不存在');
  if (err?.code === 'ENOTDIR') return new BrowserError(400, '路径不是目录');
  return new BrowserError(500, '无法读取目录');
}

// io/platform/home/now are small test seams; production budgets are not configurable.
// getLocations yields configured absolute root strings, without inspecting those roots.
function createDirectoryBrowser({ getLocations = () => [], io = fs.promises,
  platform = process.platform, home = os.homedir(), now = () => performance.now(),
} = {}) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const portable = p => windows ? p.replace(/\\/g, '/') : p;
  const identity = p => windows ? p.toLowerCase() : p;
  // Contains ONLY active work (at most two entries), never a completed listing cache.
  const flights = new Map();

  function absolute(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_PATH || value.includes('\0')
      || /^[\\/]{2}/.test(value)
      || (windows ? !/^[a-z]:[\\/]/i.test(value) : !paths.isAbsolute(value))) {
      throw new BrowserError(400, '需要本地绝对目录路径');
    }
    return paths.resolve(value);
  }
  // A Windows network home must not crash service startup; browsing it still fails validation.
  const homePath = paths.resolve(home);

  function parse(query) {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      throw new BrowserError(400, '无效查询参数');
    }
    const values = Object.create(null);
    const entries = query instanceof URLSearchParams ? query.entries() : Object.entries(query);
    for (const [key, value] of entries) {
      if (!['path', 'offset'].includes(key) || Object.hasOwn(values, key) || typeof value !== 'string') {
        throw new BrowserError(400, '无效或重复查询参数');
      }
      values[key] = value;
    }
    const offset = values.offset === undefined ? 0 : Number(values.offset);
    if ((values.offset !== undefined && !/^\d+$/.test(values.offset)) || !Number.isSafeInteger(offset)) {
      throw new BrowserError(400, 'offset 必须是非负整数');
    }
    return { requested: absolute(values.path === undefined || values.path === '' ? homePath : values.path), offset };
  }

  function locations(current) {
    const result = [];
    const seen = new Set();
    function add(candidate, name) {
      let normalized;
      try { normalized = absolute(candidate); } catch { return; }
      const key = identity(normalized);
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ name: name || paths.basename(normalized) || portable(normalized), path: portable(normalized) });
    }
    add(homePath, '主目录');
    add(paths.parse(current).root);
    for (const candidate of getLocations()) {
      if (result.length >= MAX_LOCATIONS) break;
      add(candidate);
    }
    return result;
  }

  async function scan(requested, offset) {
    const started = now();
    // Explicitly entered links may resolve, but never accept a resolved UNC/device path.
    const current = absolute(await io.realpath(requested));
    const names = [];
    let read = 0;
    let truncated = false;
    let handle;
    try {
      // A one-entry buffer also bounds native prefetch at the 20,000-entry cutoff.
      handle = await io.opendir(current, { bufferSize: 1 });
      for (;;) {
        if (read >= MAX_ENTRIES || names.length >= MAX_DIRECTORIES || now() - started >= SCAN_MS) {
          // Conservative at an exact boundary: no extra read just to prove EOF.
          truncated = true;
          break;
        }
        const dirent = await handle.read();
        if (!dirent) break;
        read++;
        if (!dirent.isSymbolicLink() && dirent.isDirectory()) names.push(dirent.name);
      }
    } finally {
      if (handle) await handle.close();
    }
    // Deterministic UTF-16 name order, independent of OS enumeration order/locale.
    names.sort();
    const parent = paths.dirname(current);
    return {
      path: portable(current),
      parent: parent === current ? null : portable(parent),
      home: portable(homePath),
      locations: locations(current),
      directories: names.slice(offset, offset + LIMIT).map(name => ({ name, path: portable(paths.join(current, name)) })),
      offset, limit: LIMIT,
      hasMore: offset + LIMIT < names.length,
      truncated,
    };
  }

  async function list(query = {}) {
    let parsed;
    try { parsed = parse(query); } catch (err) { throw failure(err); }
    const { requested, offset } = parsed;
    const key = JSON.stringify([identity(requested), offset]);
    if (flights.has(key)) return flights.get(key);
    // Reserve before realpath/opendir, not after: even slow/failed IO is bounded.
    if (flights.size >= 2) throw new BrowserError(429, '目录浏览繁忙，请稍后重试');
    const flight = scan(requested, offset)
      .catch(err => { throw failure(err); })
      .finally(() => { flights.delete(key); });
    flights.set(key, flight);
    return flight;
  }

  return { list };
}

module.exports = { createDirectoryBrowser };
