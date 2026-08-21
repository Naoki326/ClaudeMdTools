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
  autostart              注册开机登录自启（Windows）；--remove 卸载
  stop                   停止正在运行的服务
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

// —— 常驻与停止（1.3 起，替代 PM2 方案）——

// 自启任务名（LANBOOK_AUTOSTART_TASK 仅供测试隔离覆盖）
function autostartTaskName() {
  return (process.env.LANBOOK_AUTOSTART_TASK || '').trim() || 'lanbook-autostart';
}

// lanbook autostart：注册登录触发的计划任务，隐藏窗口拉起服务。
// 链路：计划任务 → wscript(autostart.vbs，隐藏窗口) → autostart-task.cmd(重定向日志)
//   → node server.js。不需要管理员：任务以当前用户身份注册、仅本人登录时触发。
function cmdAutostart(args) {
  const remove = args.includes('--remove');
  const extra = args.filter(a => a !== '--remove');
  if (extra.length) fail(`多余参数: ${extra.join(' ')}\n\n${USAGE}`);

  if (process.platform !== 'win32') {
    console.error('lanbook autostart 目前仅支持 Windows（计划任务）。');
    console.error('macOS 可用 launchd（~/Library/LaunchAgents/），Linux 可用 systemd user 单元。');
    process.exitCode = 1;
    return;
  }

  const taskName = autostartTaskName();
  const dataDir = resolveDataDir();

  if (remove) {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Unregister-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -Confirm:$false`],
      { encoding: 'utf-8', windowsHide: true });
    if (res.status === 0) {
      console.log(`已卸载自启任务: ${taskName}`);
    } else {
      console.log(`自启任务不存在（无需卸载）: ${taskName}`);
    }
    // 包装脚本是注册时生成的附属物，一并清理（不存在则忽略）
    for (const f of ['autostart.vbs', 'autostart-task.cmd']) {
      try { fs.rmSync(path.join(dataDir, f)); } catch {}
    }
    return;
  }

  initDataDir(dataDir, path.join(__dirname, '..'));
  const serverJs = path.join(__dirname, '..', 'server.js');
  const logDir = path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const vbsPath = path.join(dataDir, 'autostart.vbs');
  const cmdPath = path.join(dataDir, 'autostart-task.cmd');
  const logPath = path.join(logDir, 'service.log');

  // 生成的包装脚本内容保持纯 ASCII（cmd / wscript 对非 ASCII 编码敏感）
  fs.writeFileSync(vbsPath, [
    `' lanbook autostart wrapper (generated by \`lanbook autostart\`; re-register overwrites)`,
    `' Hidden-window launch; port/host come from settings.json in the data directory`,
    `CreateObject("WScript.Shell").Run """${cmdPath}""", 0, False`,
    '',
  ].join('\n'), 'utf-8');
  fs.writeFileSync(cmdPath, [
    `@echo off`,
    `rem lanbook service launcher (generated by \`lanbook autostart\`); logs append below`,
    `"${process.execPath}" "${serverJs}" >> "${logPath}" 2>&1`,
    '',
  ].join('\n'), 'utf-8');

  // PowerShell 注册（PS 单引号串内 ' 翻倍转义；Argument 值带双引号防路径空格）
  const psArg = `"${vbsPath}"`.replace(/'/g, "''");
  const psScript = [
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '${psArg}'`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `Register-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
  ].join('; ');
  const reg = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript],
    { encoding: 'utf-8', windowsHide: true });
  if (reg.status !== 0) {
    fail(`注册计划任务失败（exit ${reg.status}）\n${reg.stderr || reg.stdout}`);
  }
  const query = spawnSync('schtasks', ['/Query', '/TN', taskName], { encoding: 'utf-8', windowsHide: true });
  if (query.status !== 0) fail(`注册后查询不到任务 ${taskName}，注册可能未生效`);

  console.log(`已注册开机自启（登录触发）: ${taskName}`);
  console.log(`  启动包装: ${vbsPath}`);
  console.log(`  服务日志: ${logPath}（追加写，过大可手动清理）`);
  console.log(`  端口 / 监听地址: 数据目录 settings.json（自启场景没有 PORT 环境变量）`);
  console.log(`  立即启动一次: schtasks /Run /TN ${taskName}`);
  console.log(`  停止服务: lanbook stop`);
  console.log(`  卸载自启: lanbook autostart --remove`);
}

// 按端口找 LISTENING 进程 pid（Windows: netstat -ano；Unix: lsof）
function findListeningPids(port) {
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    const pids = new Set();
    const re = new RegExp(`[:.]${port}\\s`);
    for (const line of out.split('\n')) {
      if (/\sLISTENING\s/.test(line) && re.test(line)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) pids.add(Number(pid));
      }
    }
    return [...pids];
  }
  const out = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).stdout || '';
  return out.split('\n').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
}

// lanbook stop：停止本机正在运行的 lanbook 服务。
// 全局规则：终止前验明身份——Windows 下用 CommandLine 确认是 node 跑的 server.js 才杀。
function cmdStop() {
  const dataDir = resolveDataDir();
  const { port } = resolveListen(dataDir);
  const pids = findListeningPids(port);
  if (!pids.length) {
    console.log(`端口 ${port} 无监听进程，服务未在运行`);
    return;
  }
  for (const pid of pids) {
    if (process.platform === 'win32') {
      const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', windowsHide: true });
      const cmdline = (probe.stdout || '').trim();
      if (probe.status !== 0 || !/node/i.test(cmdline) || !cmdline.includes('server.js')) {
        fail(`端口 ${port} 的监听进程 ${pid} 不是 lanbook 的 node server.js（CommandLine: ${cmdline || '未知'}），拒绝终止`);
      }
      spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true });
    } else {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    console.log(`已停止进程 ${pid}（端口 ${port}）`);
  }
  // 等端口真正释放（最多 3 秒），给「stop 后立刻重启」一个确定状态
  const deadline = Date.now() + 3000;
  while (findListeningPids(port).length && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); // 同步睡 150ms
  }
  console.log('服务已停止');
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
  case 'autostart':
    cmdAutostart(args);
    break;
  case 'stop':
    cmdStop();
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
