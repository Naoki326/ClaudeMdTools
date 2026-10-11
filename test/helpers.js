'use strict';
// 进程边界测试地基（spec #1 Testing Decisions）：
// spawn 真实 `node server.js` 进程，用原生 fetch 打 HTTP、用 fs 断言文件状态。
// 不引 supertest、不导出 app 工厂、零新 devDependencies。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 建临时目录
function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 在临时目录里铺一个「安装目录」（模拟源码模式 / 安装模式的服务所在处）：
// 拷贝 server.js / lib / public / package.json；node_modules 以 junction 指向仓库
// （require 只读，不产生拷贝开销，也不会向仓库写入）。
function makeInstallDir(base) {
  const installDir = fs.mkdtempSync(path.join(base, 'install-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'server.js'), path.join(installDir, 'server.js'));
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(installDir, 'package.json'));
  if (fs.existsSync(path.join(REPO_ROOT, 'lib'))) {
    fs.cpSync(path.join(REPO_ROOT, 'lib'), path.join(installDir, 'lib'), { recursive: true });
  }
  if (fs.existsSync(path.join(REPO_ROOT, 'bin'))) {
    fs.cpSync(path.join(REPO_ROOT, 'bin'), path.join(installDir, 'bin'), { recursive: true });
  }
  fs.cpSync(path.join(REPO_ROOT, 'public'), path.join(installDir, 'public'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(installDir, 'node_modules'), 'junction');
  return installDir;
}

// 清理安装目录：先摘掉 node_modules junction（rmdir 只删链接本身），再整树删除
function removeInstallDir(installDir) {
  if (!installDir) return;
  try { fs.rmdirSync(path.join(installDir, 'node_modules')); } catch {}
  try { fs.rmSync(installDir, { recursive: true, force: true }); } catch {}
}

// 目录快照（相对路径 → 文件内容），node_modules 除外；用于「零写入」断言
function snapshotDir(dir) {
  const map = {};
  function walk(d, prefix) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules') continue;
      const rel = prefix ? prefix + '/' + e.name : e.name;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) map[rel] = fs.readFileSync(full, 'utf-8');
    }
  }
  walk(dir, '');
  return map;
}

// 动态分配一个空闲端口
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// 启动真实服务进程，轮询 /api/knowledge/config 直到就绪
// 返回 { baseUrl, port, stdout(), stderr(), fetch(), stop() }
// port 参数：省略 → 动态分配端口并以 PORT 环境变量注入（既有行为，抵御外部残留 PORT）；
//           传数字 → 不携带 PORT 环境变量，服务端口由 settings.json / 内置默认决定，
//           就绪轮询打在该端口上（settings 生效性由「能否在该端口应答」动态断言）
// entry 参数：服务入口脚本，缺省 'server.js'；传 'bin/lanbook.js' 即从 CLI 入口启动
async function startServer({ t, installDir, env = {}, port = null, entry = 'server.js' }) {
  const injectPortEnv = port === null;
  if (injectPortEnv) port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const finalEnv = { ...process.env, ...env };
  if (injectPortEnv) finalEnv.PORT = String(port);
  else delete finalEnv.PORT;
  const child = spawn(process.execPath, [entry], {
    cwd: installDir,
    env: finalEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { err += d; });

  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill();
    await new Promise(res => {
      const timer = setTimeout(res, 5000);
      child.once('exit', () => { clearTimeout(timer); res(); });
    });
  };
  t.after(() => stop());

  const deadline = Date.now() + 20000;
  let lastErr = '';
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`服务进程提前退出 code=${child.exitCode}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    }
    try {
      const r = await fetch(`${baseUrl}/api/knowledge/config`);
      if (r.ok) break;
      lastErr = `status ${r.status}`;
    } catch (e) { lastErr = e.cause ? (e.cause.code || e.cause.message) : e.message; }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`等待服务就绪超时 baseUrl=${baseUrl} lastErr=${lastErr}\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
    }
    await sleep(150);
  }

  return {
    baseUrl,
    port,
    stdout: () => out,
    stderr: () => err,
    fetch: (p, opts) => fetch(baseUrl + p, opts),
    stop,
  };
}

// Windows 计划任务锁：计划任务是**全机器唯一**的资源，而 node --test 默认并行
// 跑各测试文件。而「注册时自动清理残留任务」（lib/autostart.js 的
// pruneOrphanAutostart）是**全局操作**——A 文件注册时会顺手清掉 B 文件刚造出的
// 孤儿任务，B 随后的 `--prune` 只能报「未发现残留」，断言随机失败（实测确定性
// 复现：造孤儿 → 另一安装注册 → 原任务已被清掉）。
//
// 两道闸门，缺一不可：
// - 进程内 async 互斥（promise 队列）：同一进程的**并发**用例不得同时进入
// - 跨进程 mkdir 目录锁（AGENTS.md 惯例）：并行跑的**不同**测试文件之间互斥
//
// 可重入性靠 AsyncLocalStorage 判定：它按异步上下文区分「嵌套调用」（继承 store，
// 直接执行）与「并发调用」（无 store，排队）。不可用「深度计数」代替——那会让
// 同进程的并发调用都误判为重入，锁形同虚设（本工具的自检用例就钉死这一点）。
const { AsyncLocalStorage } = require('node:async_hooks');
const WINTASK_LOCK = path.join(os.tmpdir(), 'lanbook-wintask.lock');
const wintaskHeld = new AsyncLocalStorage();
let wintaskTail = Promise.resolve();

async function withWindowsTaskLock(fn, { timeout = 240000, stale = 120000 } = {}) {
  if (process.platform !== 'win32') return fn(); // 计划任务仅 Windows
  if (wintaskHeld.getStore()) return fn(); // 嵌套调用：已持锁，直接执行

  // 进程内排队：把本次调用接到队尾，保证同进程的并发用例串行
  const prev = wintaskTail;
  let release;
  wintaskTail = new Promise(r => { release = r; });
  await prev;
  try {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        fs.mkdirSync(WINTASK_LOCK);
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // 陈旧锁自愈：持锁进程被强杀（Ctrl+C / 超时）时锁会留下
        try {
          if (Date.now() - fs.statSync(WINTASK_LOCK).mtimeMs > stale) {
            fs.rmdirSync(WINTASK_LOCK);
            continue;
          }
        } catch { /* 锁刚被释放/抢占，下一轮重试 */ }
        if (Date.now() > deadline) {
          throw new Error(`等待 Windows 计划任务锁超时：${WINTASK_LOCK}`);
        }
        await sleep(250);
      }
    }
    try {
      // 在 store 里执行：其内部的嵌套调用据此判定为「已持锁」
      return await wintaskHeld.run(true, fn);
    } finally { try { fs.rmdirSync(WINTASK_LOCK); } catch {} }
  } finally {
    release();
  }
}

module.exports = { mkTempDir, makeInstallDir, removeInstallDir, snapshotDir, freePort, startServer, sleep, REPO_ROOT, withWindowsTaskLock };
