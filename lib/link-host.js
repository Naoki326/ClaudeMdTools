'use strict';
// 链接主机解析（扩展与测试共用）：把「服务配置里的 port/host」翻译成
// 「浏览器该访问哪个地址」。
//
// 为什么单独成模块：pi 扩展原先自己复制了一份端口解析逻辑、且完全忽略 host，
// 于是在 host 收敛到 127.0.0.1 时仍生成局域网 IP 链接（必然连不通）。
// 这里让扩展与服务端共用 lib/settings.js 的解析规则，host 语义只有一处定义。
//
// 关键规则：
//   - host 为回环（127.0.0.1 / ::1 / localhost）→ 链接只能是 127.0.0.1（loopback: true）
//   - host 为具体网卡地址 → 直接用该地址（不猜网卡）
//   - host 为通配（0.0.0.0 / ::，默认）→ 探测局域网 IPv4，按「真实私网优先」排序
const os = require('os');
const { resolveListen } = require('./settings');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

// 局域网地址优先级：真实私网 > Tailscale CGNAT（100.64/10）> 其它。
// os.networkInterfaces() 的枚举顺序不保证，装了 Tailscale 时
// 100.x 地址可能排在 Wi-Fi 私网地址前面，生成的链接对普通设备不可达。
function ipRank(ip) {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return 3; // Tailscale CGNAT
  return 4;
}

// 常见虚拟网卡名（VMware / VirtualBox / WSL / Docker / Hyper-V），其地址不适合对外分享
const VIRTUAL_IFACE = /vmnet|vEthernet|virtual|vbox|docker|wsl|loopback/i;

// 从网络接口快照中挑一个用于生成链接的局域网 IPv4；没有则返回 null
function pickLanIPv4(interfaces = os.networkInterfaces()) {
  const candidates = [];
  const fallback = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const ni of list || []) {
      if (!ni || ni.family !== 'IPv4' || ni.internal) continue;
      fallback.push(ni.address);
      if (!VIRTUAL_IFACE.test(name)) candidates.push(ni.address);
    }
  }
  const pool = candidates.length > 0 ? candidates : fallback;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) => ipRank(a) - ipRank(b))[0];
}

// 解析链接主机。env 默认传 {}（只认 settings）——调用方是 pi 扩展时，
// 进程环境里的 PORT 属于 pi / pi-web 自己（如 30141），与 lanbook 无关。
function resolveLinkHost(dataDir, { interfaces = os.networkInterfaces(), env = {} } = {}) {
  const { port, host } = resolveListen(dataDir, env);
  if (LOOPBACK_HOSTS.has(host)) {
    return { port, host: '127.0.0.1', loopback: true, boundIp: null };
  }
  if (!WILDCARD_HOSTS.has(host)) {
    // 绑定到具体网卡地址：该地址就是唯一可达入口
    return { port, host, loopback: false, boundIp: host };
  }
  const lan = pickLanIPv4(interfaces);
  return { port, host: lan || '127.0.0.1', loopback: lan === null, boundIp: null };
}

// 本机（同机浏览器）打开用的地址：通配监听走回环；绑具体网卡时回环不通，用该网卡地址
function resolveLocalHost(dataDir, opts) {
  const info = resolveLinkHost(dataDir, opts);
  return info.boundIp || '127.0.0.1';
}

module.exports = { resolveLinkHost, resolveLocalHost, pickLanIPv4, ipRank };
