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
async function startServer({ t, installDir, env = {}, port = null }) {
  const injectPortEnv = port === null;
  if (injectPortEnv) port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const finalEnv = { ...process.env, ...env };
  if (injectPortEnv) finalEnv.PORT = String(port);
  else delete finalEnv.PORT;
  const child = spawn(process.execPath, ['server.js'], {
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

module.exports = { mkTempDir, makeInstallDir, removeInstallDir, snapshotDir, freePort, startServer, sleep, REPO_ROOT };
