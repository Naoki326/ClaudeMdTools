'use strict';
// /lanbook 命令的链接地址解析：host 收敛、Tailscale 优先序、端口来源。
// 这是修复「生成的局域网链接打不开」的回归测试——原先扩展完全忽略 settings.host，
// host=127.0.0.1 时仍给出局域网 IP 链接，而服务根本没绑那张网卡。
//
// 直接单元测试 lib/link-host.js（扩展与服务端共用的解析模块），
// 用注入的网卡快照 + 临时数据目录，不依赖本机真实网络配置。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkTempDir } = require('./helpers');
const { resolveLinkHost, resolveLocalHost, pickLanIPv4, ipRank } = require('../lib/link-host');

// 造一个数据目录，写入 settings.json（可省略 → 全部走默认）
function dataDirWith(settings) {
  const dir = mkTempDir('lanbook-link-');
  if (settings) {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings), 'utf-8');
  }
  return dir;
}

// 典型双网卡快照：Wi-Fi 私网 + Tailscale（枚举顺序故意把 Tailscale 放前面）
const IFACES_TAILSCALE_FIRST = {
  'Tailscale': [{ family: 'IPv4', internal: false, address: '100.114.42.112' }],
  'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.2.144' }],
  'Loopback': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
};

test('host 收敛到回环 → 链接给 127.0.0.1 并标记 loopback（不再给局域网 IP）', async t => {
  const dir = dataDirWith({ port: 30142, host: '127.0.0.1' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const info = resolveLinkHost(dir, { interfaces: IFACES_TAILSCALE_FIRST, env: {} });
  assert.equal(info.host, '127.0.0.1', '回环 host 必须给回环地址（局域网 IP 必然连不通）');
  assert.equal(info.loopback, true, '需标记 loopback 以便上层提示用户');
  assert.equal(info.port, 30142);
});

test('host 收敛到回环时，本机打开地址也是回环（不受 boundIp 影响）', async t => {
  const dir = dataDirWith({ host: '127.0.0.1' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(resolveLocalHost(dir, { interfaces: IFACES_TAILSCALE_FIRST, env: {} }), '127.0.0.1');
});

test('host 绑定具体网卡 → 直接用该地址（不猜网卡，本机打开也用该地址）', async t => {
  const dir = dataDirWith({ port: 9000, host: '192.168.2.144' });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const info = resolveLinkHost(dir, { interfaces: IFACES_TAILSCALE_FIRST, env: {} });
  assert.equal(info.host, '192.168.2.144');
  assert.equal(info.loopback, false);
  assert.equal(info.boundIp, '192.168.2.144');
  // 绑定具体网卡时回环不通，本机也必须走该地址
  assert.equal(resolveLocalHost(dir, { interfaces: IFACES_TAILSCALE_FIRST, env: {} }), '192.168.2.144');
});

test('host 通配（默认）→ 私网地址优先于 Tailscale（枚举顺序不生效）', async t => {
  const dir = dataDirWith({ port: 30142 }); // 不写 host → 默认 0.0.0.0
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const info = resolveLinkHost(dir, { interfaces: IFACES_TAILSCALE_FIRST, env: {} });
  assert.equal(info.host, '192.168.2.144', '应优先选真实私网地址，而非枚举在前的 Tailscale 地址');
  assert.equal(info.loopback, false);
  assert.equal(info.port, 30142);
});

test('host 通配 + 只有 Tailscale → 仍给出可达地址（Tailscale 好过回环）', async t => {
  const dir = dataDirWith({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const only = { 'Tailscale': [{ family: 'IPv4', internal: false, address: '100.114.42.112' }] };
  const info = resolveLinkHost(dir, { interfaces: only, env: {} });
  assert.equal(info.host, '100.114.42.112');
  assert.equal(info.loopback, false, '有可用地址时不应误报为仅本机可达');
});

test('host 通配 + 只有虚拟网卡 → 降级使用虚拟网卡地址（聊胜于无，不谎报回环）', async t => {
  const dir = dataDirWith({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const onlyVirt = { 'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.0.1' }] };
  const info = resolveLinkHost(dir, { interfaces: onlyVirt, env: {} });
  assert.equal(info.host, '172.20.0.1');
  assert.equal(info.loopback, false);
});

test('host 通配 + 无任何非回环网卡 → 回落回环并标记 loopback（提示用户）', async t => {
  const dir = dataDirWith({ port: 8080 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const onlyLoopback = { 'Loopback': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] };
  const info = resolveLinkHost(dir, { interfaces: onlyLoopback, env: {} });
  assert.equal(info.host, '127.0.0.1');
  assert.equal(info.loopback, true, '无局域网可达地址时必须标记 loopback');
  assert.equal(info.port, 8080, '端口回落默认 8080');
});

test('端口来源：settings.port 生效，且忽略进程 PORT（pi/pi-web 自带 PORT 不干扰）', async t => {
  const dir = dataDirWith({ port: 30142 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // 显式传 env={} 时（扩展的调用方式），进程 PORT 不参与
  assert.equal(resolveLinkHost(dir, { interfaces: IFACES_TAILSCALE_FIRST, env: {} }).port, 30142);

  // 对比：服务端自身调用时 PORT 环境变量优先（保持既有语义）
  const withEnv = resolveLinkHost(dir, { interfaces: IFACES_TAILSCALE_FIRST, env: { PORT: '40000' } });
  assert.equal(withEnv.port, 40000, 'PORT 环境变量对服务端仍是一等覆盖项');
});

test('settings.json 缺失 / 损坏 / 值非法 → 一律静默回落默认（8080 + 通配探测）', async t => {
  const broken = mkTempDir('lanbook-link-broken-');
  fs.writeFileSync(path.join(broken, 'settings.json'), '{ 这不是 JSON', 'utf-8');
  const missing = mkTempDir('lanbook-link-missing-');
  const badValues = dataDirWith({ port: 'abc', host: 42 });
  t.after(() => {
    for (const d of [broken, missing, badValues]) fs.rmSync(d, { recursive: true, force: true });
  });

  for (const dir of [broken, missing, badValues]) {
    const info = resolveLinkHost(dir, { interfaces: IFACES_TAILSCALE_FIRST, env: {} });
    assert.equal(info.port, 8080, '非法/缺失端口应回落 8080');
    assert.equal(info.host, '192.168.2.144', '非法/缺失 host 应回落通配探测');
    assert.equal(info.loopback, false);
  }
});

test('地址优先级：192.168 最优，其次 10.x / 172.16-31 / Tailscale，最后其它', async t => {
  assert.ok(ipRank('192.168.1.5') < ipRank('10.0.0.5'), '192.168 优先于 10.x');
  assert.ok(ipRank('10.0.0.5') < ipRank('172.16.0.5'), '10.x 优先于 172.16-31');
  assert.ok(ipRank('172.16.0.5') < ipRank('100.64.0.5'), '172.16-31 优先于 Tailscale');
  assert.ok(ipRank('100.64.0.5') < ipRank('203.0.113.5'), 'Tailscale 优先于公网/其它地址');

  // 172.15 / 172.32 不属于私网段，应排在 Tailscale 之后
  assert.ok(ipRank('172.15.0.1') > ipRank('100.64.0.5'), '172.15 不是私网段');
  assert.ok(ipRank('172.32.0.1') > ipRank('100.64.0.5'), '172.32 不是私网段');

  // Tailscale CGNAT 边界：100.63 与 100.128 不在 100.64/10 内
  assert.ok(ipRank('100.63.0.1') > ipRank('100.64.0.1'), '100.63 不在 CGNAT 段内');
  assert.ok(ipRank('100.128.0.1') > ipRank('100.127.0.1'), '100.128 不在 CGNAT 段内');
});

test('pickLanIPv4：跳过回环，虚拟网卡仅在无其它选择时使用', async t => {
  assert.equal(pickLanIPv4({ 'Loopback': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] }), null);
  assert.equal(
    pickLanIPv4({
      'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.9' }],
      'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.20.0.1' }],
    }),
    '192.168.1.9',
    '有真实网卡时不应选虚拟网卡',
  );
  // IPv6-only 快照：当前实现只认 IPv4，返回 null 由上层回落回环
  assert.equal(pickLanIPv4({ 'Wi-Fi': [{ family: 'IPv6', internal: false, address: 'fe80::1' }] }), null);
});
