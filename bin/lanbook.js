#!/usr/bin/env node
'use strict';
// lanbook CLI 入口（CONTEXT.md「安装模式」运行身份的统一入口）：
//   lanbook                    启动服务（默认行为，与 node server.js 同进程）
//   lanbook open               打开浏览器；服务未运行时先后台启动
//   lanbook add [--teach] <dir>  添加根目录（默认知识库；--teach 进课程配置）
//   lanbook config [k] [v]   无参数打印配置路径；带参数查看/设置 port、host
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('node:child_process');
const { resolveDataDir, initDataDir } = require('../lib/data-dir');
const { SETTINGS_FILE_NAME, resolveListen, parsePort, parseHost } = require('../lib/settings');
const { registerAutostart, removeAutostart, stopAutostartGuard } = require('../lib/autostart');

const USAGE = `用法: lanbook [命令] [参数]

  (无命令)                启动服务（默认行为）
  open                    打开浏览器访问服务；服务未运行时先后台启动
  add [--teach] <目录>    添加根目录（默认知识库；--teach 添加课程根目录）
  config [key] [value]    无参数打印配置文件路径；带参数查看/设置 port、host
  autostart [--remove]    注册登录自启（Win 计划任务 / macOS launchd / Linux systemd）；--remove 卸载
  stop                    停止正在运行的服务
  version                 显示版本号
  help                    显示详细帮助`;

const HELP = `${USAGE}

服务配置项（config <key> [value]，写入数据目录 settings.json，服务重启后生效）:
  port     监听端口，1–65535 整数（默认 8080）
  host     监听地址（默认 0.0.0.0；仅本机访问设为 127.0.0.1）

环境变量:
  PORT                    一次性覆盖端口（优先级高于 settings.json）
  EDITOR                  lanbook config 打开的编辑器（如 "code -w"）
  BROWSER                 lanbook open 打开的浏览器（设为 none 则不打开）
  LANBOOK_HOME            数据目录位置（默认 ~/.lanbook）
  LANBOOK_AUTOSTART_TASK  自启任务名：Win 计划任务 / macOS launchd 标签 / Linux systemd 单元基名（默认 lanbook-autostart）

示例:
  lanbook config port 30142        改监听端口
  lanbook config host 127.0.0.1    仅本机可访问
  lanbook config port              查看端口当前生效值与来源
  lanbook add D:\\Docs             添加知识库根目录
  lanbook add --teach ~/courses    添加课程根目录
  lanbook stop && lanbook open     重启服务应用新配置

文档: https://github.com/Naoki326/ClaudeMdTools`;

function printUsage(stream) {
  stream.write(USAGE + '\n');
}

function printHelp() {
  process.stdout.write(HELP + '\n');
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

// 可设置的服务配置项（settings.json）：key → 校验解析 + 无效值报错文案。
// 校验与服务端同源（lib/settings.js），CLI 接受的值服务端一定能识别。
const CONFIG_KEYS = {
  port: { parse: parsePort, invalid: v => `无效的端口: ${v}（需 1–65535 的整数）` },
  host: { parse: parseHost, invalid: v => `无效的 host: ${v}（需非空字符串，如 127.0.0.1）` },
};

// lanbook config [key] [value]：
//   无参数        打印三个配置文件路径（服务配置 / 知识库 / 课程）；设 $EDITOR 时依次打开
//   <key>         查看该配置项当前生效值与来源（PORT 环境变量 > settings.json > 默认）
//   <key> <value> 校验后写入 settings.json（保留其他字段；服务重启后生效）
async function cmdConfig(args) {
  const dataDir = resolveDataDir();

  if (args.length > 0) {
    if (args.length > 2) fail(`多余的参数: ${args.slice(2).join(' ')}\n\n${USAGE}`);
    const [key, value] = args;
    const spec = CONFIG_KEYS[key];
    if (!spec) fail(`未知的配置项: ${key}（可用: ${Object.keys(CONFIG_KEYS).join(', ')}）`);

    initDataDir(dataDir, path.join(__dirname, '..'));
    const settingsFile = path.join(dataDir, SETTINGS_FILE_NAME);
    let stored;
    try { stored = JSON.parse(fs.readFileSync(settingsFile, 'utf-8')); } catch { stored = {}; }

    // 查询：生效值 + 来源标注（优先级与 resolveListen 一致）
    if (args.length === 1) {
      const effective = resolveListen(dataDir);
      if (key === 'port') {
        const source = parsePort(process.env.PORT) != null ? '环境变量 PORT'
          : parsePort(stored.port) != null ? 'settings.json' : '内置默认';
        console.log(`port = ${effective.port}（来源: ${source}）`);
      } else {
        const source = parseHost(stored.host) != null ? 'settings.json' : '内置默认';
        console.log(`host = ${effective.host}（来源: ${source}）`);
      }
      return;
    }

    // 写入：先记写入前的生效端口（运行中服务用的端口），写完后探测给重启提示
    const before = resolveListen(dataDir);
    const parsed = spec.parse(value);
    if (parsed == null) fail(spec.invalid(value));
    stored[key] = parsed;
    fs.writeFileSync(settingsFile, JSON.stringify(stored, null, 2) + '\n', 'utf-8');
    console.log(`已设置 ${key} = ${parsed}`);
    console.log(`配置文件: ${settingsFile}`);
    if (await isUp(`http://127.0.0.1:${before.port}/`)) {
      console.log(`注意: 服务正在运行（端口 ${before.port}），新配置重启后生效: lanbook stop && lanbook open`);
    } else {
      console.log('服务未在运行，下次启动时新配置生效');
    }
    return;
  }

  // 无参数：打印三个配置文件路径；设 $EDITOR 时依次打开
  // （settings.json 之外的知识库 / 课程配置仍走编辑器；roots 推荐 lanbook add）
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

// —— 常驻与停止（1.3 起，替代 PM2 方案；跨平台机制见 lib/autostart.js 与 ADR-0005）——

// lanbook autostart：注册登录自启 + 崩溃自愈（Windows 计划任务 + VBS/CMD 守护、
// macOS launchd LaunchAgent、Linux systemd user 单元）。实现与系统调用全在 lib/autostart.js，
// 这里只做参数解析与平台化输出。
function cmdAutostart(args) {
  const remove = args.includes('--remove');
  const extra = args.filter(a => a !== '--remove');
  if (extra.length) fail(`多余参数: ${extra.join(' ')}\n\n${USAGE}`);

  const dataDir = resolveDataDir();
  let result;
  try {
    result = remove
      ? removeAutostart({ dataDir })
      : registerAutostart({ dataDir, serverJs: path.join(__dirname, '..', 'server.js') });
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
  }

  if (remove) {
    if (result.kind === 'windows') {
      console.log(result.removed ? `已卸载自启任务: ${result.taskName}` : `自启任务不存在（无需卸载）: ${result.taskName}`);
    } else if (result.kind === 'launchd') {
      console.log(result.removed ? `已卸载自启 LaunchAgent: ${result.label}` : `LaunchAgent 未注册（无需卸载）`);
    } else {
      console.log(result.removed ? `已卸载自启 systemd 单元: ${result.unitName}` : `systemd 单元未注册（无需卸载）`);
    }
    return;
  }

  const name = result.kind === 'windows' ? result.taskName : result.kind === 'launchd' ? result.label : result.unitName;
  console.log(`已注册开机自启（${result.kind === 'windows' ? '登录 + 工作站解锁触发' : '登录触发'}，崩溃自动重启）: ${name}`);
  for (const note of result.notes || []) console.log(`  ${note}`);
  if (result.kind === 'windows') {
    console.log(`  启动包装: ${result.vbsPath}`);
    console.log(`  守护方式: 服务崩溃后 3 秒自动重启（autostart-task.cmd 循环守护）`);
    console.log(`  立即启动一次: schtasks /Run /TN ${result.taskName}`);
    console.log(`  停止服务: lanbook stop（写入停止标记，守护循环退出，服务不复活）`);
  } else if (result.kind === 'launchd') {
    console.log(`  配置文件: ${result.plistPath}（注册即启动）`);
    console.log(`  守护方式: KeepAlive（服务崩溃后立即自动拉起，覆盖锁屏/唤醒场景）`);
    console.log(`  立即重启服务: launchctl kickstart gui/${result.uid}/${result.label}`);
    console.log(`  停止服务: lanbook stop（卸载本次会话守护，下次登录恢复自启）`);
  } else {
    console.log(`  单元文件: ${result.unitPath}（注册即启动）`);
    console.log(`  守护方式: 崩溃后 3 秒自动重启（Restart=on-failure，需 systemd >= 240）`);
    console.log(`  立即重启服务: systemctl --user restart ${result.unitName}`);
    console.log(`  停止服务: lanbook stop（停止单元，下次登录恢复自启）`);
  }
  console.log(`  服务日志: ${result.logPath}（追加写，过大可手动清理）`);
  console.log(`  端口 / 监听地址: 数据目录 settings.json（自启场景没有 PORT 环境变量）`);
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
  // 先停自启守护、防复活（win 写停止标记；mac launchd bootout、linux systemctl stop
  // 会直接停掉托管的服务进程），再扫端口兜底处理手动启动的实例
  const guard = stopAutostartGuard({ dataDir });
  const pids = findListeningPids(port);
  if (!pids.length) {
    if (guard && guard.stopped) {
      console.log(`已通过 ${guard.via} 停止自启服务（端口 ${port}，下次登录恢复自启）`);
    } else {
      console.log(`端口 ${port} 无监听进程，服务未在运行`);
    }
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
    cmdConfig(args).catch(err => fail(err.stack || String(err)));
    break;
  case 'autostart':
    cmdAutostart(args);
    break;
  case 'stop':
    cmdStop();
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(require('../package.json').version);
    break;
  case 'help':
  case '--help':
  case '-h':
    printHelp();
    break;
  default:
    console.error(`未知命令: ${cmd}\n`);
    printUsage(process.stderr);
    process.exitCode = 1;
}
