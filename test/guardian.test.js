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
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { freePort, sleep, REPO_ROOT, withWindowsTaskLock } = require('./helpers');

const WIN_CMD = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');

// 生成守护脚本：隔离数据目录 + 隔离任务名，注册后立刻删任务，绝不碰用户真实任务
// 注册/删除是机器级全局操作，故整段包在 withWindowsTaskLock 里（见 helpers.js）
async function makeGuardianScript(port) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanbook-guardian-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port, host: '127.0.0.1' }), 'utf-8');
  fs.writeFileSync(path.join(dataDir, 'knowledge.config.json'), JSON.stringify({ roots: [] }), 'utf-8');
  const taskName = `lanbook-guardian-${process.pid}-${Date.now()}`;
  const env = { ...process.env, LANBOOK_HOME: dataDir, LANBOOK_AUTOSTART_TASK: taskName };
  await withWindowsTaskLock(async () => {
    spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'lanbook.js'), 'autostart'],
      { env, encoding: 'utf-8', timeout: 120000, windowsHide: true });
    spawnSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf-8', windowsHide: true });
  });
  return {
    dataDir,
    env,
    cmdPath: path.join(dataDir, 'autostart-task.cmd'),
    vbsPath: path.join(dataDir, 'autostart.vbs'),
    logPath: path.join(dataDir, 'logs', 'service.log'),
  };
}

// 按「生产启动路径」拉起守护：wscript 执行注册产物 vbs（Run "...", 0, True：
// 隐藏窗口、等待守护）。旧用例直接 `cmd /c` 直跑——那有控制台 stdin，节流原语
// 行为正常，复现不了隐藏窗口下的现场。
function launchGuardianViaWscript(g) {
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  return spawn(wscript, [g.vbsPath], { windowsHide: true, stdio: 'ignore', env: g.env });
}

// 停掉 wscript 拉起的守护：按命令行里的数据目录名定位 CMD，兼容历史 Run False
// 脱离出来的孤儿 CMD，也覆盖同步等待的 Run True 包装。按数据目录名
// （lanbook-guardian-<pid>-<ts>，全局唯一）找到守护 cmd，taskkill /T 连 node
// 子进程一起杀。双保险：杀前先写停止标记——即使 taskkill 未命中，守护也会在
// 下一轮循环顶部自退，不会复活服务。
function stopGuardian(dataDir) {
  try {
    fs.writeFileSync(path.join(dataDir, '.service-stopped'), String(Date.now()), 'utf-8');
  } catch {}
  const frag = path.basename(dataDir);
  const ps = `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | `
    + `Where-Object { $_.CommandLine -like '*${frag}*' } | Select-Object -ExpandProperty ProcessId`;
  const found = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf-8', windowsHide: true, timeout: 60000 });
  for (const pid of (found.stdout || '').split(/\s+/).filter(s => /^\d+$/.test(s))) {
    spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { windowsHide: true });
  }
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

// 轮询服务是否就绪（守护拉起的服务），返回就绪时刻 Date.now()，超时返回 null
async function waitUntilUp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/knowledge`)).ok) return Date.now(); } catch {}
    if (Date.now() > deadline) return null;
    await sleep(200);
  }
}

test('守护脚本：端口已被占用时只记一行待命，不刷屏（wscript 隐藏窗口生产路径）', async t => {
  if (process.platform !== 'win32') return t.skip('守护脚本仅 Windows');
  const port = await freePort();
  const g = await makeGuardianScript(port);
  t.after(() => {
    stopGuardian(g.dataDir);
    killPort(port);
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });

  // 先占住端口，模拟「服务已经在跑」
  const holder = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1');setTimeout(()=>{},600000)`],
    { stdio: 'ignore' });
  t.after(() => { try { holder.kill(); } catch {} });
  await sleep(1500);

  // 生产启动路径拉起守护（隐藏窗口），观察 9 秒
  launchGuardianViaWscript(g);
  await sleep(9000);

  const log = fs.existsSync(g.logPath) ? fs.readFileSync(g.logPath, 'utf-8') : '';
  const busyFlag = path.join(g.dataDir, '.service-busy');
  const busyErr = log.split('\n').filter(l => l.includes('被占用')).length;

  assert.equal(busyErr, 0, `端口在监听时不应去拉服务（否则刷「被占用」），日志:\n${log}`);
  assert.ok(!fs.existsSync(g.logPath), '待命分支不应拉起服务：service.log 不应产生（零增长）');
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
  const g = await makeGuardianScript(port);
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

test('守护脚本：服务被杀后 ~3 秒节流内恰好一次重新拉起（崩溃自愈节律）', async t => {
  if (process.platform !== 'win32') return t.skip('守护脚本仅 Windows');
  const port = await freePort();
  const g = await makeGuardianScript(port);
  t.after(() => {
    stopGuardian(g.dataDir);
    killPort(port);
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });

  // 生产启动路径拉起守护，等第一次拉起成功
  launchGuardianViaWscript(g);
  const firstUp = await waitUntilUp(port, 20000);
  assert.ok(firstUp, '守护应先拉起服务');
  const logText = () => (fs.existsSync(g.logPath) ? fs.readFileSync(g.logPath, 'utf-8') : '');
  const bannerCount = () => (logText().match(/已启动/g) || []).length;
  const bannersBefore = bannerCount();

  // 杀掉服务（守护拉起的服务不在守护进程树里，按端口找）
  const t0 = Date.now();
  killPort(port);

  // 重启基线 3 秒（ping -n 4）：服务应在数秒内回来。节流失效（旧睡眠原语在
  // 隐藏窗口下 65ms 即返）时 <1 秒即回，判红；上限放宽到 8 秒是给 node 启动
  // 时间留余量——守护的契约是「~3 秒节流后尝试拉起」，不含服务自身启动耗时。
  const backUp = await waitUntilUp(port, 10000);
  assert.ok(backUp, '服务被杀后应被守护重新拉起');
  const elapsed = backUp - t0;
  assert.ok(elapsed >= 2500, `重启应被节流到 ~3 秒，实测 ${elapsed}ms（节流失效时 <1s）`);
  assert.ok(elapsed <= 8000, `重启应在数秒内完成，实测 ${elapsed}ms`);

  // 恰好一次重新拉起：再观察 4 秒，启动 banner 只新增一个，不得反复尝试
  await sleep(4000);
  const bannersAfter = bannerCount();
  assert.equal(bannersAfter, bannersBefore + 1,
    `应恰好重新拉起一次（banner ${bannersBefore} → ${bannersAfter}），日志:\n${logText()}`);
});

test('autostart --remove 清理待命标记（重新注册不留残留状态）', async t => {
  if (process.platform !== 'win32') return t.skip('仅 Windows');
  await withWindowsTaskLock(async () => {
  const port = await freePort();
  const g = await makeGuardianScript(port);
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
});

// 注册 → 删数据目录 → --prune → 校验，整段必须在同一把锁里：
// 中间任何一次「另一安装的注册」都会顺手清掉我们刚造的孤儿，
// 导致 --prune 只能报「未发现残留」（实测确定性复现）。
test('autostart --prune：数据目录被删后清掉孤儿任务（登录弹「无法找到脚本文件」的根因）', async t => {
  if (process.platform !== 'win32') return t.skip('仅 Windows');
  await withWindowsTaskLock(async () => {
  const port = await freePort();
  const g = await makeGuardianScript(port);

  // makeGuardianScript 注册后已删任务，重新注册一个并保留（模拟真实安装）
  const taskName = `lanbook-prune-${process.pid}-${Date.now()}`;
  const env = { ...process.env, LANBOOK_HOME: g.dataDir, LANBOOK_AUTOSTART_TASK: taskName };
  const cli = path.join(REPO_ROOT, 'bin', 'lanbook.js');
  const reg = spawnSync(process.execPath, [cli, 'autostart'], { env, encoding: 'utf-8', timeout: 120000, windowsHide: true });
  assert.equal(reg.status, 0, `注册应成功\n${reg.stderr}`);
  t.after(() => {
    spawnSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf-8', windowsHide: true });
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });

  const q0 = spawnSync('schtasks', ['/Query', '/TN', taskName], { encoding: 'utf-8', windowsHide: true });
  assert.equal(q0.status, 0, '任务应已注册');

  // 制造故障：删掉整个数据目录（autostart.vbs 随之消失），任务留着 → 孤儿
  fs.rmSync(g.dataDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(path.join(g.dataDir, 'autostart.vbs')), '包装脚本应已消失（故障现场）');

  // --prune 应认领并清掉它（此时描述含 marker，且目标已不存在）
  const r = spawnSync(process.execPath, [cli, 'autostart', '--prune'], { env, encoding: 'utf-8', timeout: 120000, windowsHide: true });
  assert.equal(r.status, 0, `--prune 应成功退出\n${r.stderr}`);
  assert.ok(r.stdout.includes(taskName), `--prune 输出应报告清理了该任务\n${r.stdout}`);

  const q1 = spawnSync('schtasks', ['/Query', '/TN', taskName], { encoding: 'utf-8', windowsHide: true });
  assert.notEqual(q1.status, 0, '孤儿任务应已被删除');
  });
});

test('autostart --prune：目标健在的任务不得误删', async t => {
  if (process.platform !== 'win32') return t.skip('仅 Windows');
  await withWindowsTaskLock(async () => {
  const port = await freePort();
  const g = await makeGuardianScript(port);
  const taskName = `lanbook-prune-keep-${process.pid}-${Date.now()}`;
  const env = { ...process.env, LANBOOK_HOME: g.dataDir, LANBOOK_AUTOSTART_TASK: taskName };
  const cli = path.join(REPO_ROOT, 'bin', 'lanbook.js');
  const reg = spawnSync(process.execPath, [cli, 'autostart'], { env, encoding: 'utf-8', timeout: 120000, windowsHide: true });
  assert.equal(reg.status, 0, `注册应成功\n${reg.stderr}`);
  t.after(() => {
    spawnSync('schtasks', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf-8', windowsHide: true });
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });

  // 数据目录健在（autostart.vbs 存在）→ 不该被当成残留
  const r = spawnSync(process.execPath, [cli, 'autostart', '--prune'], { env, encoding: 'utf-8', timeout: 120000, windowsHide: true });
  assert.equal(r.status, 0, `--prune 应成功退出\n${r.stderr}`);
  const q = spawnSync('schtasks', ['/Query', '/TN', taskName], { encoding: 'utf-8', windowsHide: true });
  assert.equal(q.status, 0, '目标健在的任务必须保留');
  });
});

test('autostart --remove 与 --prune 互斥', async () => {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'lanbook.js'), 'autostart', '--remove', '--prune'],
    { encoding: 'utf-8', timeout: 60000, windowsHide: true });
  assert.notEqual(r.status, 0, '互斥参数应报错退出');
  assert.match(r.stderr + r.stdout, /不能同时使用/);
});

// 锁本身的自检：确保串行化工具按预期工作（否则上面的用例会静默失去保护）
test('withWindowsTaskLock：同一时刻只有一个持有者', async () => {
  let inCritical = 0, maxConcurrent = 0;
  const worker = () => withWindowsTaskLock(async () => {
    inCritical++;
    maxConcurrent = Math.max(maxConcurrent, inCritical);
    await sleep(60);
    inCritical--;
  });
  await Promise.all([worker(), worker(), worker()]);
  assert.equal(maxConcurrent, 1, '临界区不得并发进入');
});

// ---------- 工单 #4：失败退避 + 退出码契约 + 日志归档 ----------
//
// 为什么用「假服务」而不是真服务去撞 EADDRINUSE：守护拉起前会探端口（前票的
// 节流/探测），端口被占时根本不会拉起（转待命）——真服务没有「每次启动都撞
// 端口」的确定性入口。而本票被测对象是**守护对退出码的解释**，所以让真实生成
// 的 cmd 拉起一个「立即以指定退出码退出的假服务」，即可沿生产路径全链路验证：
// wscript 隐藏窗口启动 + 真实端口探测 + 真实日志追加 + 真实退避节律。
// 服务侧（真 EADDRINUSE → 退出码 42）由 test/port-conflict.test.js 钉住。

// 生成假服务脚本写入数据目录，并把守护 cmd 启动行里的 server.js 绝对路径
// 替换成假服务路径——守护脚本的其余内容保持生产原样
function writeFakeServer(g, { exitCode, conflictLine }) {
  const script = path.join(g.dataDir, 'fake-server.js');
  const lines = [
    `'use strict';`,
    `// guardian-behavior test fake: exercises the cmd exit-code contract`,
    `console.log('[fake-launch] pid=' + process.pid);`,
  ];
  if (conflictLine) lines.push(`console.error(${JSON.stringify(conflictLine)});`);
  lines.push(`process.exit(${exitCode});`);
  fs.writeFileSync(script, lines.join('\n'), 'utf-8');
  const real = path.join(REPO_ROOT, 'server.js');
  const cmd = fs.readFileSync(g.cmdPath, 'utf-8');
  assert.ok(cmd.includes(`"${real}"`), '生成的守护脚本应含 server.js 绝对路径（替换前提）');
  fs.writeFileSync(g.cmdPath, cmd.replace(`"${real}"`, `"${script}"`), 'utf-8');
  return script;
}

test('守护脚本：并发拉起只留一个守护，正常退出/强杀后都能重新获得锁', async t => {
  if (process.platform !== 'win32') return t.skip('守护脚本仅 Windows');
  const g = await makeGuardianScript(await freePort());
  t.after(() => {
    stopGuardian(g.dataDir);
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });
  // 假服务立即退出且不绑定端口：重复守护不能靠「探到端口」侥幸避免被测症状。
  // 整个重启延时期间仍必须持锁，而不是仅在服务启动时互斥。
  writeFakeServer(g, { exitCode: 100 });
  const wrappers = Array.from({ length: 8 }, () => launchGuardianViaWscript(g));
  const alive = child => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const log = fs.existsSync(g.logPath) ? fs.readFileSync(g.logPath, 'utf8') : '';
    if (log.includes('[fake-launch]') && wrappers.filter(alive).length === 1) break;
    await sleep(100);
  }
  assert.equal(wrappers.filter(alive).length, 1, '重复启动必须退出，不能累积等待 ping 的 CMD/VBS');
  assert.match(fs.readFileSync(g.logPath, 'utf8'), /\[fake-launch\]/, '唯一实例仍应执行服务启动');
  const first = wrappers.find(alive);
  // 保留锁文件，正常停止后再启动；文件存在本身不能阻止重启。
  fs.writeFileSync(path.join(g.dataDir, '.service-stopped'), 'test stop');
  await waitForWrapperExit(first);
  const lockPath = path.join(g.dataDir, '.autostart-guardian.lock');
  assert.ok(fs.existsSync(lockPath), '句柄锁文件无需删除');
  fs.rmSync(path.join(g.dataDir, '.service-stopped'));
  const before = fs.readFileSync(g.logPath, 'utf8').split('[fake-launch]').length - 1;
  const second = launchGuardianViaWscript(g);
  const launches = await collectLaunchTimes(g.logPath, before + 1, 15000);
  assert.ok(launches.length > before && alive(second), '正常停止后应可接管残留锁文件');

  // 强杀整个测试进程树，模拟异常退出，不执行任何用户态解锁/删除逻辑。
  const killed = spawnSync('taskkill', ['/PID', String(second.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  assert.equal(killed.status, 0, '应确实结束本用例创建的进程树');
  await waitForWrapperExit(second);
  const thirdBefore = fs.readFileSync(g.logPath, 'utf8').split('[fake-launch]').length - 1;
  const third = launchGuardianViaWscript(g);
  const restarted = await collectLaunchTimes(g.logPath, thirdBefore + 1, 15000);
  assert.ok(restarted.length > thirdBefore && alive(third), '强杀后内核应自动释放锁，不留永久陈旧锁');
  fs.writeFileSync(path.join(g.dataDir, '.service-stopped'), 'test stop');
  await waitForWrapperExit(third);
});

for (const phase of ['service-running', 'standby', 'backoff']) {
  test(`守护脚本：${phase} 期间新入口不能累积第二个守护`, async t => {
    if (process.platform !== 'win32') return t.skip('守护脚本仅 Windows');
    const port = await freePort();
    const g = await makeGuardianScript(port);
    t.after(() => {
      stopGuardian(g.dataDir);
      try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
    });
    if (phase === 'standby') {
      const holder = net.createServer();
      await new Promise((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(port, '127.0.0.1', resolve);
      });
      t.after(() => new Promise(resolve => holder.close(resolve)));
    } else {
      const script = writeFakeServer(g, { exitCode: 42 });
      if (phase === 'service-running') {
        // 不绑端口且持续运行，不能用端口独占冒充守护单实例。
        fs.writeFileSync(script, `console.log('[fake-launch]');\nsetInterval(() => {}, 1000);\n`, 'utf8');
      }
    }
    const owner = launchGuardianViaWscript(g);
    if (phase === 'standby') {
      const busyFlag = path.join(g.dataDir, '.service-busy');
      const deadline = Date.now() + 15000;
      while (!fs.existsSync(busyFlag) && Date.now() < deadline) await sleep(100);
      assert.ok(fs.existsSync(busyFlag), '先确认守护进入端口待命');
    } else {
      const count = phase === 'backoff' ? 2 : 1;
      const launches = await collectLaunchTimes(g.logPath, count, 15000);
      assert.ok(launches.length >= count, '先确认服务运行或重复冲突进入失败退避');
      if (phase === 'backoff') await sleep(250); // 假服务退出后，处于第二次约 6s 退避窗口
    }
    const duplicates = Array.from({ length: 3 }, () => launchGuardianViaWscript(g));
    await Promise.all(duplicates.map(waitForWrapperExit));
    assert.equal(owner.exitCode, null, '原守护必须持续持锁，不能由新入口抢占');
    assert.equal(owner.signalCode, null);
    assert.ok(duplicates.every(child => child.exitCode === 0), '所有重复入口应直接成功退出，而非积累待命/退避循环');
  });
}

async function waitForWrapperExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener('exit', done); reject(new Error('等待守护包装退出超时')); }, 15000);
    function done() { clearTimeout(timer); resolve(); }
    child.once('exit', done);
  });
}

// 轮询 service.log 统计 [fake-launch] 行数，记录每一次新增的墙钟时刻
//（用于断言重启间隔）。等到 count 次或超时为止，返回时刻数组（相对 ms）。
async function collectLaunchTimes(logPath, count, timeoutMs) {
  const times = [];
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
    const n = text.split('[fake-launch]').length - 1;
    while (times.length < n) times.push(Date.now());
    if (count && times.length >= count) break;
    if (n < seen) break; // 日志被归档清零（不该发生在本组用例）即停
    seen = n;
    await sleep(120);
  }
  const base = times.length ? times[0] : Date.now();
  return times.map(ts => ts - base);
}

test('守护脚本：端口冲突退出码触发失败退避（10 秒窗口 ≤4 行，间隔逐级倍增）', async t => {
  if (process.platform !== 'win32') return t.skip('守护脚本仅 Windows');
  const port = await freePort();
  const g = await makeGuardianScript(port);
  t.after(() => {
    stopGuardian(g.dataDir);
    killPort(port);
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });

  // 假服务复刻真实冲突文案（服务侧重试耗尽后的既有文案），每次启动打一行
  const conflictLine = `端口 ${port} 被占用，请确认是否已有 lanbook 在运行（lanbook stop 可停止）`;
  writeFakeServer(g, { exitCode: 42, conflictLine });

  launchGuardianViaWscript(g);
  // 退避序列 3s→6s→12s：第 4 次启动约在首启后 ~22s；45s 上界留给慢机器
  const times = await collectLaunchTimes(g.logPath, 4, 45000);
  const log = fs.existsSync(g.logPath) ? fs.readFileSync(g.logPath, 'utf-8') : '';

  assert.ok(times.length >= 4, `退避期间应持续重试（观测到 ${times.length} 次启动），日志:\n${log}`);

  // AC：10 秒窗口内冲突行数 ≤ 小上界（风暴形态下为 30+）
  const conflicts = log.split('\n').filter(l => l.includes('被占用')).length;
  const inFirst10s = times.filter(dt => dt <= 10000).length;
  assert.ok(inFirst10s <= 4,
    `10 秒窗口内冲突行应 ≤4，实测 ${inFirst10s}（冲突行 ${conflicts}），启动时刻: ${JSON.stringify(times)}`);

  // 重试间隔逐级退避：~3.5s → ~6.5s → ~12.5s（下界放宽到 5s/9.5s；
  // 无退避的基线 3s 节律 gap 稳定在 ~3.5s，两个下界都会判红）
  const gaps = times.slice(1).map((dt, i) => dt - times[i]);
  assert.ok(gaps[0] >= 2500, `第一次重试应 ≥ ~3s 节流，实测 ${gaps[0]}ms`);
  assert.ok(gaps[1] >= 5000, `第二次重试应退避到 ~6s，实测 ${gaps[1]}ms，全部间隔: ${JSON.stringify(gaps)}`);
  assert.ok(gaps[2] >= 9500, `第三次重试应退避到 ~12s，实测 ${gaps[2]}ms，全部间隔: ${JSON.stringify(gaps)}`);
});

test('守护脚本：崩溃退出码（>42）不误分类为端口冲突，仍按基线 3s 重启', async t => {
  if (process.platform !== 'win32') return t.skip('守护脚本仅 Windows');
  const port = await freePort();
  const g = await makeGuardianScript(port);
  t.after(() => {
    stopGuardian(g.dataDir);
    killPort(port);
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });

  // 退出码 100 > 42：若守护误用 `if errorlevel 42`（≥ 语义），100 会被当成
  // 端口冲突而逐级退避；精确相等比较下它是普通崩溃，按基线 3s 节律重启
  writeFakeServer(g, { exitCode: 100 });

  launchGuardianViaWscript(g);
  const times = await collectLaunchTimes(g.logPath, 6, 45000);
  const log = fs.existsSync(g.logPath) ? fs.readFileSync(g.logPath, 'utf-8') : '';

  // 基线节律 6 次启动 ≈ 17.5s；若被误退避（3/6/12/24s）第 6 次要到 ~58s，观测不满
  assert.ok(times.length >= 6,
    `崩溃应按基线 3s 节律重启（观测到 ${times.length} 次），误退避时 45s 内不足 6 次，日志:\n${log}`);
  const span = times[5] - times[0];
  assert.ok(span <= 25000, `基线节律 6 次启动应 ≤25s，实测 ${span}ms，启动时刻: ${JSON.stringify(times)}`);
  const gaps = times.slice(1).map((dt, i) => dt - times[i]);
  assert.ok(gaps[1] <= 5500,
    `第二次重启应仍是基线 ~3s（不得误退避到 6s），实测 ${gaps[1]}ms，全部间隔: ${JSON.stringify(gaps)}`);
});

test('守护脚本：超限 service.log 在追加前归档为 .old，日志重新从空累积', async t => {
  if (process.platform !== 'win32') return t.skip('守护脚本仅 Windows');
  const port = await freePort();
  const g = await makeGuardianScript(port);
  t.after(() => {
    stopGuardian(g.dataDir);
    killPort(port);
    try { fs.rmSync(g.dataDir, { recursive: true, force: true }); } catch {}
  });

  writeFakeServer(g, { exitCode: 42 });

  // 预置 21 MiB 超限日志：先写标记行，再稀疏截断到目标体积（不占真实磁盘）
  const oversized = 21 * 1024 * 1024;
  const oldLog = g.logPath + '.old';
  fs.mkdirSync(path.dirname(g.logPath), { recursive: true });
  fs.writeFileSync(g.logPath, 'PRESET-OVERSIZE-MARKER\n', 'utf-8');
  fs.truncateSync(g.logPath, oversized);

  launchGuardianViaWscript(g);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (fs.existsSync(oldLog) && fs.existsSync(g.logPath)) break;
    await sleep(200);
  }

  assert.ok(fs.existsSync(oldLog), '超限日志应在追加前被归档为 .old');
  const oldStat = fs.statSync(oldLog);
  assert.ok(oldStat.size >= oversized, `.old 应保有原体积，实测 ${oldStat.size}`);
  assert.ok(fs.readFileSync(oldLog, 'utf-8').startsWith('PRESET-OVERSIZE-MARKER'),
    '.old 应是归档的原文件（保留标记行）');

  const fresh = fs.readFileSync(g.logPath, 'utf-8');
  assert.ok(!fresh.includes('PRESET-OVERSIZE-MARKER'), '归档后 service.log 应从空重新累积');
  assert.ok(fresh.includes('[fake-launch]'), `新日志应已开始累积服务输出:\n${fresh.slice(0, 300)}`);
});
