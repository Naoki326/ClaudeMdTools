'use strict';
// 守护脚本（autostart-task.cmd）的行为测试。
//
// 背景：脚本是无上限的 :loop。解锁触发会让计划任务再起一个守护，而上一轮服务
// 往往还活着；旧实现无条件执行 `node server.js`，于是新进程撞 EADDRINUSE 退出、
// 守护 3 秒后重试——同一行错误无上限刷屏。本机实测日志 121,324 行 / 11MB 中
// 99.87% 是这一行。修复后：先探端口，已在监听就转 30 秒周期的待命，
// 且「已待命」只记一行。
//
// 两个用例配对：一个证明「不刷屏」，一个证明「仍能拉起」（崩溃自愈不能失效）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { freePort, sleep, REPO_ROOT } = require('./helpers');

const WIN_CMD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

// 生成守护脚本：隔离数据目录 + 隔离任务名，注册后立刻删任务，绝不碰用户真实任务
function makeGuardianScript(port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanbook-guardian-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port, host: '127.0.0.1' }), 'utf-8');
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [] }), 'utf-8');
  const taskName = `lanbook-guardian-${process.pid}-${Date.now()}`;
  const env = { ...process.env, LANBOOK_HOME: dataDir, LANBOOK_AUTOSTART_TASK: taskName };
  spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'lanbook.js'), 'autostart'],
    { env, encoding: 'utf-8', timeout: 120000, windowsHide: true });
  spawnSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf-8', windowsHide: true });
  return {
    dataDir,
    env,
    cmdPath: path.join(dataDir, 'autostart-task.cmd'),
    logPath: path.join(dataDir, 'logs', 'service.log'),
  };
}

// 杀掉占用指定端口的进程（守护拉起的服务不在守护进程树里，需按端口找）
function killPort(port) {
  const ns = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf-8' }).stdout || '';
  for (const line of ns.split('\n')) {
    if (line.includes(`:${port} `) && line.includes('LISTENING')) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) spawnSync('taskkill', ['/PID', pid, '/F'], { windowsHide: true });
    }
  }
}

test('守护脚本：端口已被占用时只记一行待命，不刷屏', async t => {
  if (process.platform !== 'win32') return t.skip('守护脚本仅 Windows');
  const port = await freePort();
  const g = makeGuardianScript(port);
  t.after(() => {
    killPort(port);
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });

  // 先占住端口，模拟「服务已经在跑」
  const holder = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1');setTimeout(()=>{},600000)`],
    { stdio: 'ignore' });
  t.after(() => { try { holder.kill(); } catch {} });
  await sleep(1500);

  // 跑守护脚本观察 9 秒：旧实现会在此期间刷出约 3 行「被占用」
  const guardian = spawn(WIN_CMD, ['/c', g.cmdPath], { windowsHide: true, stdio: 'ignore', env: g.env });
  t.after(() => {
    try { spawnSync('taskkill', ['/PID', String(guardian.pid), '/T', '/F'], { windowsHide: true }); } catch {}
  });
  await sleep(9000);

  const log = fs.existsSync(g.logPath) ? fs.readFileSync(g.logPath, 'utf-8') : '';
  const busyFlag = path.join(g.dataDir, '.service-busy');
  const busyErr = log.split('\n').filter(l => l.includes('被占用')).length;

  assert.equal(busyErr, 0, `端口在监听时不应去拉服务（否则刷「被占用」），日志:\n${log}`);
  assert.ok(fs.existsSync(busyFlag), '应写下待命标记以抑制重复提示');

  // 诊断信息写在标记文件里，而不是 service.log：
  // cmd 的 `>>` 把日志句柄传给 node 子进程并继承，服务运行期间该文件被独占，
  // 而待命恰好只在服务在跑时触发——写日志会报「另一个程序正在使用此文件」而丢失。
  const note = fs.readFileSync(busyFlag, 'utf-8');
  assert.match(note, /\[standby\]/, `待命标记应含可读诊断信息，实际: ${JSON.stringify(note)}`);
  assert.match(note, new RegExp(String(port)), '诊断信息应含端口号');

  // 且不得重复写（9 秒内多轮循环也只应保持一份内容）
  const again = fs.readFileSync(busyFlag, 'utf-8');
  assert.equal(again, note, '待命提示不应被反复重写');
});

test('守护脚本：端口空闲时仍能拉起服务（崩溃自愈不失效）', async t => {
  if (process.platform !== 'win32') return t.skip('守护脚本仅 Windows');
  const port = await freePort();
  const g = makeGuardianScript(port);
  t.after(() => {
    killPort(port);
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });

  // 必须把 LANBOOK_HOME 传给守护：否则它拉起的 server.js 会去读真实
  // ~/.lanbook/settings.json（那里是另一个端口），测试端口永远起不来
  const guardian = spawn(WIN_CMD, ['/c', g.cmdPath], { windowsHide: true, stdio: 'ignore', env: g.env });
  t.after(() => {
    try { spawnSync('taskkill', ['/PID', String(guardian.pid), '/T', '/F'], { windowsHide: true }); } catch {}
  });

  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(`http://127.0.0.1:${port}/api/knowledge`)).ok; } catch {}
    if (!up) await sleep(400);
  }

  const log = fs.existsSync(g.logPath) ? fs.readFileSync(g.logPath, 'utf-8') : '';
  assert.ok(up, `守护应拉起服务，日志:\n${log}`);
  assert.ok(!log.includes('[standby]'), `端口空闲时不应误判待命，日志:\n${log}`);
  assert.ok(!fs.existsSync(path.join(g.dataDir, '.service-busy')),
    '端口空闲拉起服务后不应留下待命标记');
});

test('autostart --remove 清理待命标记（重新注册不留残留状态）', async t => {
  if (process.platform !== 'win32') return t.skip('仅 Windows');
  const port = await freePort();
  const g = makeGuardianScript(port);
  t.after(() => { try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {} });

  // 造一个待命标记，模拟守护曾处于待命
  const busyFlag = path.join(g.dataDir, '.service-busy');
  fs.writeFileSync(busyFlag, '', 'utf-8');
  assert.ok(fs.existsSync(busyFlag));

  const taskName = `lanbook-rm-${process.pid}-${Date.now()}`;
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'lanbook.js'), 'autostart', '--remove'],
    { env: { ...process.env, LANBOOK_HOME: g.dataDir, LANBOOK_AUTOSTART_TASK: taskName },
      encoding: 'utf-8', timeout: 60000, windowsHide: true });

  assert.equal(r.status, 0, `--remove 应成功退出\n${r.stderr}`);
  assert.ok(!fs.existsSync(busyFlag), '--remove 应一并删除待命标记');
  assert.ok(!fs.existsSync(g.cmdPath), '--remove 应删除守护脚本');
});
