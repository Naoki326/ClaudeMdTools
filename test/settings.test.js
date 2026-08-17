'use strict';
// Ticket #4（lanbook T2 · 服务配置 settings 与启动横幅）进程边界测试
// 覆盖验收标准：settings 自定义端口生效、host 收敛到回环仅本机可达、
// PORT 环境变量覆盖 settings、settings 缺省回落默认 8080 不报错、
// 启动 stdout 含监听地址与局域网读写风险警告（ADR-0003 落地）。
// 全部走「预写 settings.json + spawn 真实进程 + 动态断言监听行为」。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mkTempDir, makeInstallDir, removeInstallDir, freePort, startServer } = require('./helpers');

// ADR-0003 横幅风险警告文案（用户故事 5 原文）
const RISK_WARNING = '局域网内设备可读写所配置目录';
const DEFAULT_PORT = 8080;

// 预写数据目录 settings.json（CONTEXT.md「服务配置」）
function writeSettings(dataDir, settings) {
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
}

// 本机第一个非回环 IPv4（用于断言「仅回环可达」）；无则返回 null
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

// 探测 url 是否有 HTTP 应答（任意状态码即可）；错误或 2 秒无应答视为不可达
async function isReachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

test('settings.json 写自定义端口 → 服务监听该端口，横幅含监听地址与风险警告', async t => {
  const base = mkTempDir('lanbook-t2-port-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-t2-port-data-');
  t.after(() => { removeInstallDir(installDir); for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

  const port = await freePort();
  writeSettings(dataDir, { port });

  // port 显式传入 → 不带 PORT 环境变量；就绪轮询打在该端口，
  // 能通过即证明服务确实监听 settings 指定的端口
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir }, port });
  assert.equal(await srv.fetch('/').then(r => r.status), 200);

  // 启动横幅（ADR-0003）：监听地址 + 局域网读写风险警告
  assert.match(srv.stdout(), new RegExp(`:${port}\\b`), '横幅应含实际监听端口');
  assert.ok(srv.stdout().includes(RISK_WARNING), '横幅应含局域网读写风险警告');
  await srv.stop();
});

test('settings.json 写 host: 127.0.0.1 → 仅回环可达，横幅不再出现局域网警告', async t => {
  const base = mkTempDir('lanbook-t2-host-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-t2-host-data-');
  t.after(() => { removeInstallDir(installDir); for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

  const ip = lanIPv4();
  if (!ip) return t.skip('本机无非回环网卡，无法动态断言仅回环可达');

  writeSettings(dataDir, { host: '127.0.0.1' });
  // 端口走动态 PORT env（与 host 配置正交）
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  assert.equal(await srv.fetch('/').then(r => r.status), 200, '回环地址可访问（就绪轮询走 127.0.0.1）');

  // 非回环本机地址应不可达（连接被拒绝 / 无应答）
  assert.equal(await isReachable(`http://${ip}:${srv.port}/`), false, `非回环地址 ${ip} 不应可达`);

  // 横幅：给出回环监听地址；收敛后不再宣称局域网风险
  assert.match(srv.stdout(), new RegExp(`127\\.0\\.0\\.1:${srv.port}`), '横幅应含回环监听地址');
  assert.ok(!srv.stdout().includes(RISK_WARNING), '收敛到回环后不应再出现局域网风险警告');
  await srv.stop();
});

test('PORT 环境变量覆盖 settings（一次性场景优先）', async t => {
  const base = mkTempDir('lanbook-t2-env-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-t2-env-data-');
  t.after(() => { removeInstallDir(installDir); for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

  const settingsPort = await freePort();
  writeSettings(dataDir, { port: settingsPort });

  // 默认模式：动态分配端口并注入 PORT 环境变量（优先级：env > settings > 默认）
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir } });
  assert.equal(await srv.fetch('/').then(r => r.status), 200, '服务应答在 PORT env 端口（就绪轮询已证明）');

  // settings 里写的端口不应被监听
  assert.equal(await isReachable(`http://127.0.0.1:${settingsPort}/`), false, 'settings 端口不应生效（env 覆盖 settings）');
  await srv.stop();
});

test('settings 文件不存在 → 回落默认 8080 不报错，横幅完整', async t => {
  const base = mkTempDir('lanbook-t2-default-');
  const installDir = makeInstallDir(base);
  const dataDir = mkTempDir('lanbook-t2-default-data-');
  t.after(() => { removeInstallDir(installDir); for (const d of [base, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

  // 固定默认端口无法动态分配：已被其他进程占用时跳过，避免 EADDRINUSE 假红
  if (await isReachable(`http://127.0.0.1:${DEFAULT_PORT}/`)) {
    return t.skip(`本机 ${DEFAULT_PORT} 端口已被其他进程占用，无法验证默认回落`);
  }

  // 不写 settings.json、不带 PORT env → 应监听内置默认 8080
  const srv = await startServer({ t, installDir, env: { LANBOOK_HOME: dataDir }, port: DEFAULT_PORT });
  assert.equal(await srv.fetch('/').then(r => r.status), 200);

  const out = srv.stdout();
  assert.match(out, new RegExp(`:${DEFAULT_PORT}\\b`), '横幅应含默认监听端口');
  assert.ok(out.includes(RISK_WARNING), '默认 0.0.0.0 监听时横幅应含风险警告');
  assert.ok(!/Error|Exception/i.test(srv.stderr()), '回落默认值不应产生报错输出');
  await srv.stop();
});
