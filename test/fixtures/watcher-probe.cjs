'use strict';
// Test-only observation at the real chokidar boundary. Cap traversal so a
// regression cannot exhaust memory before the assertions see the cycle.
const { FSWatcher } = require('chokidar');
const add = FSWatcher.prototype.add;
const observed = new WeakSet();
FSWatcher.prototype.add = function(paths, ...args) {
  if (!observed.has(this)) {
    observed.add(this);
    this.options = Object.freeze({ ...this.options, depth: 8 });
    this.once('ready', () => {
      console.log('[watcher-test] ' + JSON.stringify({
        roots: Array.isArray(paths) ? paths : [paths],
        directories: Object.keys(this.getWatched()),
      }));
    });
  }
  return add.call(this, paths, ...args);
};
