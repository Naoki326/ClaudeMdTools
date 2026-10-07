'use strict';
// lib/autostart.js 单元测试：跨平台自启（机制映射见 docs/adr/0005）。
// 关键设计：平台分支（platform）、系统命令执行器（run）、目录位置（homeDir /
// xdgConfigHome）、uid 全部可注入——任意宿主平台（含 Windows）上覆盖三平台逻辑，
// 绝不真调 launchctl / systemctl / powershell。
// Windows 真实注册计划任务的集成测试由 test/cli.test.js 覆盖（win32 skip 保护）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  autostartTaskName,
  generateLaunchdPlist,
  generateSystemdUnit,
  launchdPlistPath,
  systemdUnitPath,
  describeAutostart,
  registerAutostart,
  removeAutostart,
  stopAutostartGuard,
} = require('../lib/autostart');

const NODE_BIN = '/opt/node/bin/node';
const SERVER_JS = '/apps/lanbook/server.js';

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// fake runner：记录每次调用；可按「命令判定函数」定制返回值（默认成功）
function fakeRun(overrides = []) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push({ cmd, args });
    for (const [match, result] of overrides) {
      if (match(cmd, args)) return typeof result === 'function' ? result() : result;
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  return run;
}

// 便捷断言：runner 收到过某条命令
function sawCall(run, cmd, ...argsPrefix) {
  return run.calls.some(c => c.cmd === cmd && argsPrefix.every((a, i) => c.args[i] === a));
}

// ---------- 生成器（纯函数，任何平台可测） ----------

test('generateLaunchdPlist：Label / ProgramArguments / RunAtLoad / KeepAlive / 日志路径', () => {
  const logPath = '/home/u/.lanbook/logs/service.log';
  const xml = generateLaunchdPlist({ label: 'lanbook-autostart', nodeBin: NODE_BIN, serverJs: SERVER_JS, logPath });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<!DOCTYPE plist /);
  assert.ok(xml.includes('<string>lanbook-autostart</string>'), '应含 Label');
  assert.ok(xml.includes(`<string>${NODE_BIN}</string>`), 'ProgramArguments 应含 node 绝对路径');
  assert.ok(xml.includes(`<string>${SERVER_JS}</string>`), 'ProgramArguments 应含 server.js 绝对路径');
  assert.ok(xml.includes('<key>RunAtLoad</key>'), '应含 RunAtLoad（注册即启动 / 登录拉起）');
  assert.ok(xml.includes('<key>KeepAlive</key>'), '应含 KeepAlive（崩溃保活）');
  assert.ok(xml.includes(`<string>${logPath}</string>`), 'stdout/stderr 应重定向到数据目录日志');
});

test('generateLaunchdPlist：路径含 XML 特殊字符时转义', () => {
  const xml = generateLaunchdPlist({
    label: 'lanbook-autostart', nodeBin: NODE_BIN,
    serverJs: '/apps/a&b/server.js', logPath: '/home/u/.lanbook/logs/service.log',
  });
  assert.ok(xml.includes('<string>/apps/a&amp;b/server.js</string>'), '& 应转义为 &amp;');
  assert.doesNotMatch(xml, /<string>\/apps\/a&b\//, '原样 & 不应出现在 XML 里');
});

test('generateSystemdUnit：ExecStart 引号路径 / Restart=on-failure / RestartSec=3 / append 日志 / default.target', () => {
  const logPath = '/home/u/.lanbook/logs/service.log';
  const unit = generateSystemdUnit({ nodeBin: NODE_BIN, serverJs: SERVER_JS, logPath });
  assert.ok(unit.includes(`ExecStart="${NODE_BIN}" "${SERVER_JS}"`), 'ExecStart 路径应双引号包裹（空格安全）');
  assert.ok(unit.includes('Restart=on-failure'), '崩溃自愈：Restart=on-failure');
  assert.ok(unit.includes('RestartSec=3'), '对齐 Windows 守护循环：3 秒后重启');
  assert.ok(unit.includes(`StandardOutput=append:${logPath}`), 'stdout 追加写数据目录日志');
  assert.ok(unit.includes(`StandardError=append:${logPath}`), 'stderr 追加写数据目录日志');
  assert.ok(unit.includes('WantedBy=default.target'), '登录（用户 manager 启动）时拉起');
});

// ---------- 路径解析（XDG 覆盖 / 默认回退） ----------

test('launchdPlistPath / systemdUnitPath：注入根目录与 XDG_CONFIG_HOME', () => {
  assert.equal(
    launchdPlistPath('lanbook-autostart', '/home/u'),
    path.join('/home/u', 'Library', 'LaunchAgents', 'lanbook-autostart.plist'),
  );
  assert.equal(
    systemdUnitPath('lanbook-autostart', { xdgConfigHome: '/xdg-root' }),
    path.join('/xdg-root', 'systemd', 'user', 'lanbook-autostart.service'),
  );
  assert.equal(
    systemdUnitPath('lanbook-autostart', { homeDir: '/home/u', xdgConfigHome: '' }),
    path.join('/home/u', '.config', 'systemd', 'user', 'lanbook-autostart.service'),
  );
});

// ---------- 注册（macOS / Linux，注入 fake run + 临时目录） ----------

test('registerAutostart(darwin)：写 plist + bootout 旧实例 + bootstrap gui/<uid>', () => {
  const base = mkTempDir('lanbook-as-mac-');
  t_cleanup(base);
  const dataDir = path.join(base, 'data');
  const run = fakeRun();
  const uid = 501;
  const result = registerAutostart({
    dataDir, serverJs: SERVER_JS, platform: 'darwin', run, uid, homeDir: base,
  });

  assert.equal(result.kind, 'launchd');
  const plistPath = launchdPlistPath('lanbook-autostart', base);
  assert.equal(result.plistPath, plistPath);
  assert.ok(fs.existsSync(plistPath), 'plist 应写入 ~/Library/LaunchAgents（注入的 homeDir）');
  const xml = fs.readFileSync(plistPath, 'utf-8');
  assert.ok(xml.includes(SERVER_JS), 'plist 应写 server.js 绝对路径');
  assert.ok(xml.includes(path.join(dataDir, 'logs', 'service.log')), 'plist 日志应指向数据目录');

  assert.ok(sawCall(run, 'launchctl', 'bootout', 'gui/501/lanbook-autostart'), '注册前应先卸旧实例（重复注册 = 覆盖）');
  const bs = run.calls.find(c => c.args[0] === 'bootstrap');
  assert.ok(bs, '应调用 launchctl bootstrap');
  assert.deepEqual(bs.args, ['bootstrap', 'gui/501', plistPath]);
});

test('registerAutostart(darwin)：bootstrap 失败时报错并提示无图形会话场景', () => {
  const base = mkTempDir('lanbook-as-mac-fail-');
  t_cleanup(base);
  const run = fakeRun([
    [(cmd, args) => cmd === 'launchctl' && args[0] === 'bootstrap', { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }],
  ]);
  assert.throws(
    () => registerAutostart({ dataDir: path.join(base, 'data'), serverJs: SERVER_JS, platform: 'darwin', run, uid: 501, homeDir: base }),
    /bootstrap 失败.*Input\/output error.*图形登录/s,
  );
});

test('registerAutostart(linux)：写 unit + daemon-reload + enable --now', () => {
  const base = mkTempDir('lanbook-as-linux-');
  t_cleanup(base);
  const dataDir = path.join(base, 'data');
  const run = fakeRun();
  const result = registerAutostart({
    dataDir, serverJs: SERVER_JS, platform: 'linux', run, xdgConfigHome: path.join(base, 'xdg'),
  });

  assert.equal(result.kind, 'systemd');
  assert.equal(result.unitName, 'lanbook-autostart.service');
  const unitPath = systemdUnitPath('lanbook-autostart', { xdgConfigHome: path.join(base, 'xdg') });
  assert.equal(result.unitPath, unitPath);
  assert.ok(fs.existsSync(unitPath), 'unit 应写入 $XDG_CONFIG_HOME/systemd/user');
  assert.ok(fs.readFileSync(unitPath, 'utf-8').includes(SERVER_JS), 'unit 应写 server.js 绝对路径');

  assert.ok(sawCall(run, 'systemctl', '--user', 'daemon-reload'), '应 daemon-reload');
  assert.ok(sawCall(run, 'systemctl', '--user', 'enable', '--now', 'lanbook-autostart.service'), '应 enable --now（注册即启动 + 登录自启）');
});

test('registerAutostart(linux)：enable 失败时报错', () => {
  const base = mkTempDir('lanbook-as-linux-fail-');
  t_cleanup(base);
  const run = fakeRun([
    [(cmd, args) => cmd === 'systemctl' && args.includes('enable'), { status: 1, stdout: '', stderr: 'Failed to connect to bus' }],
  ]);
  assert.throws(
    () => registerAutostart({ dataDir: path.join(base, 'data'), serverJs: SERVER_JS, platform: 'linux', run, xdgConfigHome: path.join(base, 'xdg') }),
    /enable --now .*失败.*Failed to connect to bus/s,
  );
});

test('registerAutostart(win32)：生成 vbs/cmd 守护包装 + PowerShell 注册命令', () => {
  const base = mkTempDir('lanbook-as-win-');
  t_cleanup(base);
  const dataDir = path.join(base, 'data');
  const run = fakeRun();
  const result = registerAutostart({ dataDir, serverJs: SERVER_JS, platform: 'win32', run });

  assert.equal(result.kind, 'windows');
  assert.ok(fs.existsSync(path.join(dataDir, 'autostart.vbs')), '应生成 autostart.vbs 隐藏窗口包装');
  const cmdContent = fs.readFileSync(path.join(dataDir, 'autostart-task.cmd'), 'utf-8');
  assert.ok(cmdContent.includes(':loop'), '守护循环应有 :loop');
  assert.ok(cmdContent.includes(SERVER_JS), '守护脚本应写 server.js 绝对路径');
  assert.ok(cmdContent.includes('.service-stopped'), '守护脚本应检测停止标记（lanbook stop 防复活）');

  const ps = run.calls.find(c => c.cmd === 'powershell.exe');
  assert.ok(ps, '应经 powershell 注册计划任务');
  assert.ok(ps.args[3].includes('Register-ScheduledTask'), 'PS 脚本应含 Register-ScheduledTask');
  assert.ok(sawCall(run, 'schtasks', '/Query', '/TN', 'lanbook-autostart'), '注册后应查询校验');
});

test('registerAutostart：未知平台报错', () => {
  assert.throws(
    () => registerAutostart({ dataDir: '/tmp/x', serverJs: SERVER_JS, platform: 'freebsd', run: fakeRun() }),
    /不支持的平台: freebsd/,
  );
});

// ---------- 卸载 ----------

test('removeAutostart(darwin / linux)：bootout / disable 后删文件；未注册返回 removed:false', () => {
  const base = mkTempDir('lanbook-as-rm-');
  t_cleanup(base);

  // darwin：预置 plist → removed:true + bootout + 删文件
  const plistPath = launchdPlistPath('lanbook-autostart', base);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, 'x', 'utf-8');
  const runMac = fakeRun();
  const rmMac = removeAutostart({ platform: 'darwin', run: runMac, homeDir: base, uid: 501 });
  assert.equal(rmMac.removed, true);
  assert.ok(!fs.existsSync(plistPath), '应删除 plist');
  assert.ok(sawCall(runMac, 'launchctl', 'bootout', 'gui/501/lanbook-autostart'), '应先 bootout 卸载会话实例');

  // darwin：无 plist → 无需卸载
  assert.equal(removeAutostart({ platform: 'darwin', run: fakeRun(), homeDir: base, uid: 501 }).removed, false);

  // linux：预置 unit → removed:true + disable --now + 删文件 + daemon-reload
  const xdg = path.join(base, 'xdg');
  const unitPath = systemdUnitPath('lanbook-autostart', { xdgConfigHome: xdg });
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, 'x', 'utf-8');
  const runLinux = fakeRun();
  const rmLinux = removeAutostart({ platform: 'linux', run: runLinux, xdgConfigHome: xdg });
  assert.equal(rmLinux.removed, true);
  assert.ok(!fs.existsSync(unitPath), '应删除 unit 文件');
  assert.ok(sawCall(runLinux, 'systemctl', '--user', 'disable', '--now', 'lanbook-autostart.service'), '应 disable --now');
});

// ---------- stop 防复活钩子 ----------

test('stopAutostartGuard(win32)：写停止标记、返回 null（进程由 stop 主流程杀）', () => {
  const base = mkTempDir('lanbook-as-stop-win-');
  t_cleanup(base);
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const guard = stopAutostartGuard({ dataDir, platform: 'win32', run: fakeRun() });
  assert.equal(guard, null);
  assert.ok(fs.existsSync(path.join(dataDir, '.service-stopped')), '应写入停止标记（守护循环退出，服务不复活）');
});

test('stopAutostartGuard(darwin / linux)：已注册时停服务管理器实例；未注册返回 null', () => {
  const base = mkTempDir('lanbook-as-stop-unix-');
  t_cleanup(base);

  // darwin：无 plist → null；有 plist → bootout + stopped:true
  assert.equal(stopAutostartGuard({ platform: 'darwin', run: fakeRun(), homeDir: base, uid: 501 }), null);
  const plistPath = launchdPlistPath('lanbook-autostart', base);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, 'x', 'utf-8');
  const runMac = fakeRun();
  const gMac = stopAutostartGuard({ platform: 'darwin', run: runMac, homeDir: base, uid: 501 });
  assert.deepEqual(gMac, { stopped: true, via: 'launchd' });
  assert.ok(sawCall(runMac, 'launchctl', 'bootout', 'gui/501/lanbook-autostart'));

  // linux：有 unit → systemctl --user stop + stopped:true
  const xdg = path.join(base, 'xdg');
  const unitPath = systemdUnitPath('lanbook-autostart', { xdgConfigHome: xdg });
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, 'x', 'utf-8');
  const runLinux = fakeRun();
  const gLinux = stopAutostartGuard({ platform: 'linux', run: runLinux, xdgConfigHome: xdg });
  assert.deepEqual(gLinux, { stopped: true, via: 'systemd' });
  assert.ok(sawCall(runLinux, 'systemctl', '--user', 'stop', 'lanbook-autostart.service'));
});

// ---------- 状态描述（CLI 提示与 pi 扩展 /lanbook status 共用一份真相） ----------

test('describeAutostart：三平台从注册产物提取 server.js 指向与拉起命令', () => {
  const base = mkTempDir('lanbook-as-desc-');
  t_cleanup(base);
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // win32：守护 cmd 内容里的 server.js
  fs.writeFileSync(path.join(dataDir, 'autostart-task.cmd'),
    `@echo off\r\n"${NODE_BIN}" "${SERVER_JS}" >> log 2>&1\r\n`, 'utf-8');
  const dWin = describeAutostart({ dataDir, platform: 'win32' });
  assert.equal(dWin.registered, true);
  assert.equal(dWin.target, SERVER_JS);
  assert.deepEqual(dWin.launcher, { cmd: 'cmd', args: ['/c', 'start', '', path.join(dataDir, 'autostart-task.cmd')] });

  // darwin：plist（含 XML 转义还原）+ kickstart 拉起
  const plistPath = launchdPlistPath('lanbook-autostart', base);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, generateLaunchdPlist({
    label: 'lanbook-autostart', nodeBin: NODE_BIN,
    serverJs: '/apps/a&b/server.js', logPath: '/home/u/.lanbook/logs/service.log',
  }), 'utf-8');
  const dMac = describeAutostart({ dataDir, platform: 'darwin', homeDir: base, uid: 501 });
  assert.equal(dMac.registered, true);
  assert.equal(dMac.target, '/apps/a&b/server.js', 'XML 转义应还原为真实路径');
  assert.deepEqual(dMac.launcher, { cmd: 'launchctl', args: ['kickstart', 'gui/501', 'lanbook-autostart'] });

  // linux：unit（ExecStart 引号内路径）+ systemctl start 拉起
  const xdg = path.join(base, 'xdg');
  const unitPath = systemdUnitPath('lanbook-autostart', { xdgConfigHome: xdg });
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, generateSystemdUnit({ nodeBin: NODE_BIN, serverJs: SERVER_JS, logPath: '/tmp/log' }), 'utf-8');
  const dLinux = describeAutostart({ dataDir, platform: 'linux', xdgConfigHome: xdg });
  assert.equal(dLinux.registered, true);
  assert.equal(dLinux.target, SERVER_JS);
  assert.deepEqual(dLinux.launcher, { cmd: 'systemctl', args: ['--user', 'start', 'lanbook-autostart.service'] });

  // 未注册：产物文件不存在 → registered:false（用独立 homeDir，避免上面的 plist 干扰）
  assert.equal(describeAutostart({ dataDir: path.join(base, 'none'), platform: 'darwin', homeDir: path.join(base, 'home2') }).registered, false);
});

// ---------- 任务名 ----------

test('autostartTaskName：LANBOOK_AUTOSTART_TASK 覆盖，默认 lanbook-autostart', () => {
  assert.equal(autostartTaskName(), 'lanbook-autostart');
  process.env.LANBOOK_AUTOSTART_TASK = '  my-task ';
  assert.equal(autostartTaskName(), 'my-task', '前后空白应被裁剪');
  delete process.env.LANBOOK_AUTOSTART_TASK;
});

// 简易清理登记（node:test 无 t.after 的顶层场景下逐 test 手动调用）
const cleanups = [];
function t_cleanup(dir) {
  cleanups.push(dir);
  process.on('exit', () => {
    for (const d of cleanups) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });
}
