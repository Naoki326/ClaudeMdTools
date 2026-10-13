'use strict';
// 服务侧端口冲突容忍（工单 #4）：EADDRINUSE 先做有界重试（3 次 × ~1s），
// 耗尽后打印既有冲突文案恰好一次、以约定退出码退出（lib/exit-codes.js）。
// 守护按退出码契约做失败退避（docs/adr/0005 修订）。
//
// 被测行为：同端口起两个服务时，第二个必须**有界时间**内退出——重试窗口同时
// 给「前一个实例正在优雅关闭、端口即将释放」的竞态一个自愈机会；而旧行为
// （立即 exit 1）既没有重试窗口，退出码也无法与一般崩溃区分。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { mkTempDir, makeInstallDir, removeInstallDir, startServer, freePort } = require('./helpers');
const { PORT_CONFLICT_EXIT_CODE } = require('../lib/exit-codes');

// 有界退出上界：node 启动（~1-2s）+ 3 次 × 1s 重试 + 余量；
// 无限重试的回归会在这里被 kill 成 null 而判红
const BOUNDED_EXIT_MS = 20000;

test('同端口起两个服务：第二个在有界时间内以约定退出码退出，冲突文案只出现一次', async t => {
  const base = mkTempDir('lanbook-port-conflict-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-port-conflict-data-');
  t.after(() => {
    removeInstallDir(installDir);
    for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  const port = await freePort();
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ port, host: '127.0.0.1' }) + '\n', 'utf-8');

  // 第一个服务：真实占用端口（无 PORT env，端口来自 settings.json，与自启路径一致）
  const first = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir }, port });

  // 第二个服务：同数据目录、同端口，必然 EADDRINUSE
  const env = { ...process.env, LANBOOK_HOME: dataDir };
  delete env.PORT; // 与 cmdOpen/守护一致：只认 settings.json
  const second = spawn(process.execPath, [path.join(installDir, 'server.js')], {
    cwd: dataDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  second.stdout.on('data', d => { out += d; });
  second.stderr.on('data', d => { err += d; });

  const exitCode = await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { second.kill(); } catch {}
      resolve(null); // 未在有界时间内退出
    }, BOUNDED_EXIT_MS);
    second.once('exit', code => { clearTimeout(timer); resolve(code); });
  });

  assert.notEqual(exitCode, null,
    `第二个服务应在有界时间内退出（≤${BOUNDED_EXIT_MS}ms）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);
  assert.equal(exitCode, PORT_CONFLICT_EXIT_CODE,
    `应以约定退出码 ${PORT_CONFLICT_EXIT_CODE} 退出，实测 ${exitCode}（旧行为是 1）\n--- stdout ---\n${out}\n--- stderr ---\n${err}`);

  // 冲突文案恰好一次：重试期间静默，放弃时才打印既有文案
  const conflicts = (out + '\n' + err).split('\n').filter(l => l.includes('被占用'));
  assert.equal(conflicts.length, 1, `冲突文案应恰好一行，实际 ${conflicts.length} 行:\n${conflicts.join('\n')}`);

  // 第二个服务的重试与退出不得干扰第一个服务
  assert.equal(await first.fetch('/api/knowledge/config').then(r => r.ok), true, '第一个服务应保持健康');
  await first.stop();
});
