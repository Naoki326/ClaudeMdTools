#!/usr/bin/env node
'use strict';
// lanbook CLI 入口（CONTEXT.md「安装模式」运行身份的统一入口）：
//   lanbook                    启动服务（默认行为，与 node server.js 同进程）
//   lanbook open               打开浏览器；服务未运行时先后台启动
//   lanbook add [--teach] <dir>  添加根目录（默认知识库；--teach 进课程配置）
//   lanbook config             打印三个配置文件路径；设 $EDITOR 时打开
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('node:child_process');
const { resolveDataDir, initDataDir } = require('../lib/data-dir');
const { resolveListen } = require('../lib/settings');

const USAGE = `用法: lanbook [命令]

  (无命令)               启动服务（默认行为）
  open                   打开浏览器访问服务；服务未运行时先后台启动
  add [--teach] <目录>    添加根目录（默认知识库；--teach 添加课程根目录）
  config                 打印三个配置文件路径（设 $EDITOR 时打开编辑）
  help                   显示本帮助`;

function printUsage(stream) {
  stream.write(USAGE + '\n');
}

function fail(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

// 将路径开头的 ~ 展开为用户主目录（与 server.js 根目录解析规则一致）
function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// lanbook add [--teach] <目录>：把根目录写入数据目录的内容配置。
// 默认进知识库 roots（knowledge.config.json），--teach 进课程 roots
// （teach.config.json）。目录不存在时明确报错，零副作用（参照网页 ⚙ 预览行为）。
function cmdAdd(args) {
  let teach = false;
  let dir = null;
  for (const a of args) {
    if (a === '--teach') teach = true;
    else if (dir === null) dir = a;
    else fail(`多余的参数: ${a}\n\n${USAGE}`);
  }
  if (!dir) fail(`缺少 <目录> 参数\n\n${USAGE}`);

  const abs = path.resolve(expandHome(dir));
  let stat;
  try { stat = fs.statSync(abs); } catch { fail(`目录不存在: ${abs}`); }
  if (!stat.isDirectory()) fail(`不是目录: ${abs}`);

  const dataDir = resolveDataDir();
  initDataDir(dataDir, path.join(__dirname, '..'));
  const configFile = path.join(dataDir, teach ? 'teach.config.json' : 'knowledge.config.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf-8')); } catch { config = {}; }
  const roots = Array.isArray(config.roots) ? config.roots : [];
  const already = roots.some(r => path.resolve(expandHome(String(r))) === abs);
  if (!already) roots.push(abs);
  config.roots = roots;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  const kind = teach ? '课程' : '知识库';
  console.log(already ? `该目录已在${kind}根目录中，未重复添加: ${abs}` : `已添加${kind}根目录: ${abs}`);
  console.log(`配置文件: ${configFile}`);
}

// 把「命令 + 空格分隔参数」字符串解析为 [命令, ...参数]：命令本身可能含空格
// （如 "C:\\Program Files\\...\\node.exe script.js"），采用最长存在文件前缀匹配，
// 均不命中时退回简单空格拆分（EDITOR/BROWSER 常见形态：vim / code -w）
function splitShellCommand(value) {
  const parts = value.split(/\s+/);
  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = parts.slice(0, i).join(' ');
    try { if (fs.statSync(candidate).isFile()) return [candidate, ...parts.slice(i)]; } catch {}
  }
  return parts;
}

// lanbook config：打印全部三个配置文件路径（服务配置 / 知识库 / 课程）；
// 设 $EDITOR 时依次打开（port/host 等服务级配置走此入口编辑，网页 ⚙ 不暴露）。
function cmdConfig() {
  const dataDir = resolveDataDir();
  const settings = path.join(dataDir, 'settings.json');
  const knowledge = path.join(dataDir, 'knowledge.config.json');
  const teach = path.join(dataDir, 'teach.config.json');
  console.log(`数据目录: ${dataDir}`);
  console.log(`服务配置: ${settings}`);
  console.log(`知识库配置: ${knowledge}`);
  console.log(`课程配置: ${teach}`);

  const editor = (process.env.EDITOR || '').trim();
  if (editor) {
    const [editCmd, ...editorArgs] = splitShellCommand(editor);
    const res = spawnSync(editCmd, [...editorArgs, settings, knowledge, teach], { stdio: 'inherit' });
    if (res.error) fail(`无法启动编辑器 ${editor}: ${res.error.message}`);
    if (res.status !== 0) process.exitCode = res.status;
  }
}

// 探测 URL 是否有 HTTP 应答（任意状态码即可；连接拒绝 / 超时视为未运行）
async function isUp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

// 打开浏览器：BROWSER 环境变量可覆盖（值为 none 时跳过）；
// 否则按平台选 start / open / xdg-open
function openBrowser(url) {
  const browserEnv = (process.env.BROWSER || '').trim();
  if (browserEnv) {
    if (browserEnv.toLowerCase() === 'none') {
      console.log(`BROWSER=none，跳过打开浏览器: ${url}`);
      return;
    }
    const [browserCmd, ...browserArgs] = splitShellCommand(browserEnv);
    const child = spawn(browserCmd, [...browserArgs, url], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', err => console.error(`无法启动浏览器命令 ${browserEnv}: ${err.message}`));
    child.unref();
    return;
  }
  const platformCmd = process.platform === 'win32'
    ? { cmd: 'cmd', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { cmd: 'open', args: [url] }
      : { cmd: 'xdg-open', args: [url] };
  const child = spawn(platformCmd.cmd, platformCmd.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', err => console.error(`无法打开浏览器: ${err.message}`));
  child.unref();
}

// lanbook open：服务未运行时后台启动（detached，CLI 退出后服务继续），
// 然后打开浏览器。端口解析与服务端同源：PORT 环境变量 > settings > 默认 8080。
async function cmdOpen() {
  const dataDir = resolveDataDir();
  const { port } = resolveListen(dataDir);
  const url = `http://127.0.0.1:${port}/`;

  if (await isUp(url)) {
    console.log(`服务已在运行: ${url}`);
  } else {
    console.log(`服务未运行，正在后台启动...`);
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    child.unref();
    const deadline = Date.now() + 30000;
    while (!(await isUp(url))) {
      if (Date.now() > deadline) {
        fail(`服务启动超时（端口 ${port} 无应答），请直接运行 lanbook 查看错误`);
      }
      await new Promise(r => setTimeout(r, 150));
    }
    console.log(`服务已启动: ${url}`);
  }

  console.log(`正在打开浏览器...`);
  openBrowser(url);
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case undefined:
    // 同进程直启服务端：stdout / 信号处理与 `node server.js` 完全一致
    require('../server.js');
    break;
  case 'open':
    cmdOpen().catch(err => fail(err.stack || String(err)));
    break;
  case 'add':
    cmdAdd(args);
    break;
  case 'config':
    cmdConfig();
    break;
  case 'help':
  case '--help':
  case '-h':
    printUsage(process.stdout);
    break;
  default:
    console.error(`未知命令: ${cmd}\n`);
    printUsage(process.stderr);
    process.exitCode = 1;
}
