/**
 * lanbook-open — 在浏览器（新标签页）打开任意 Markdown / HTML 文件，用 lanbook 渲染。
 *
 * 命令：
 *   /lanbook                     → 弹出 lanbook 知识库文件选择器，选文件后输出可点击链接
 *   /lanbook <路径>              → 输出指定文件的可点击链接（支持绝对路径 / 相对路径 / ~ 开头）
 *   /lanbook <目录>              → 输出 lanbook 知识库首页链接
 *
 * 行为：
 *   - 自动探测 lanbook 服务（端口来自 ~/.lanbook/settings.json，默认 8080）
 *   - 服务未运行时自动拉起（已注册自启时经服务管理器拉起，自带崩溃自愈），轮询等待就绪
 *   - 链接使用本机局域网 IP（自动探测）；但 host 收敛到回环时只给 127.0.0.1 并提示
 *   - 本机使用时可选择同时自动打开浏览器（配置 openLocalBrowser，默认开启）
 *   - .md 文件 → /api/knowledge/view（Markdown 渲染）
 *   - .html 文件 → /kbfile/<rootIndex>/<rel>（原样托管，相对资源可解析）
 *   - 文件不在任何 knowledge root 下时，经用户确认后把它所在目录加为根目录
 *
 * 作为 pi 包随 npm:lanbook 分发（package.json 的 pi 清单指向本文件）。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { exec, execFile, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 链接主机解析与服务端共用 lib/link-host.js（同一份 port/host 语义，不再各写一遍）。
// 本文件随包分发（extensions/ 与 lib/ 同属包内），相对路径在仓库与安装后都成立。
//
// 不提供本地降级实现：静默回落到「自己猜地址」正是 ADR-0004 要消灭的 bug 成因
// （旧版忽略 host，产出打不开的链接）。缺失时宁可明确报错。
const require_ = createRequire(import.meta.url);
interface LinkHostLib {
  resolveLinkHost: (dataDir: string, opts?: unknown) => { port: number; host: string; loopback: boolean; boundIp: string | null };
  resolveLocalHost: (dataDir: string, opts?: unknown) => string;
}
let linkHostLib: LinkHostLib | null = null;
let linkHostError: string | null = null;
try {
  linkHostLib = require_("../lib/link-host.js");
} catch (e: any) {
  linkHostError = e?.message || String(e);
}

// 自启状态描述也复用 lib/autostart.js（win=计划任务+CMD 守护、mac=launchd、linux=systemd）。
// 注册 / 卸载 / 状态判断一份真相，扩展不自己拼路径或猜平台差异（见 ADR-0005）。
interface AutostartLib {
  describeAutostart: (opts?: { dataDir?: string }) => {
    registered: boolean;
    via: string | null;
    target: string | null;
    launcher: { cmd: string; args: string[] } | null;
  };
}
let autostartLib: AutostartLib | null = null;
try {
  autostartLib = require_("../lib/autostart.js");
} catch {}

// ---------------------------------------------------------------- 配置

function lanbookHome(): string {
  return process.env.LANBOOK_HOME || path.join(os.homedir(), ".lanbook");
}

function dataDir(): string {
  return lanbookHome();
}

// 生成链接用的主机名与端口：全部交给 lib/link-host.js（唯一真相，见 ADR-0004）
function linkHost(): { host: string; port: number; loopback: boolean } {
  if (!linkHostLib) {
    throw new Error(
      `无法加载 lib/link-host.js（${linkHostError}）。\n` +
      `本扩展必须随 lanbook 包一起安装（扩展依赖包内的 lib/）。\n` +
      `请删除手工拷贝的副本，改用: pi install npm:lanbook`,
    );
  }
  const info = linkHostLib.resolveLinkHost(dataDir(), {});
  return { host: info.host, port: info.port, loopback: info.loopback };
}

// 本机浏览器打开用地址：通配监听（0.0.0.0）走回环；绑具体网卡时只能用该网卡地址
function localOpenHost(): string {
  if (!linkHostLib) throw new Error("无法加载 lib/link-host.js");
  return linkHostLib.resolveLocalHost(dataDir(), {});
}

function readKnowledgeConfig(): { roots: string[]; excludeDirs?: string[] } {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), "knowledge.config.json"), "utf-8"));
  } catch {
    return { roots: [] };
  }
}

// 自启状态描述（跨平台）：已注册与否 / 指向哪份 server.js / 如何拉起。
// 未注册、或包内 lib 缺失时返回 null / registered:false，调用方各自降级。
function autostartDescriptor() {
  try {
    return autostartLib ? autostartLib.describeAutostart({ dataDir: dataDir() }) : null;
  } catch {
    return null;
  }
}

// 包内 CLI 路径：扩展与 CLI 同属一个包（extensions/ 与 bin/ 同级），
// 所以 pi 安装的这份包里就带着完整的 lanbook 服务端与 CLI——
// 用户不需要额外 npm i -g，一条 /lanbook autostart 就能注册自启。
function packagedCli(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cli = path.resolve(here, "..", "bin", "lanbook.js");
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

// 调包内 CLI（用 execFile 传数组，不经 shell，免引号与路径空格问题）
async function runCli(args: string[], timeoutMs = 60000): Promise<{ code: number; out: string; err: string }> {
  const cli = packagedCli();
  if (!cli) return { code: -1, out: "", err: "找不到包内 CLI（bin/lanbook.js）" };
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { windowsHide: true, timeout: timeoutMs },
      (e: any, stdout: string, stderr: string) => {
        resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(stdout || ""), err: String(stderr || "") });
      });
  });
}

// ---------------------------------------------------------------- 服务探测 / 拉起

async function fetchJson(url: string, timeoutMs = 4000): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function serviceUp(port: number): Promise<boolean> {
  try {
    await fetchJson(`http://127.0.0.1:${port}/api/knowledge`, 1500);
    return true;
  } catch {
    return false;
  }
}

function startLanbook(port: number): Promise<void> {
  return new Promise((resolve) => {
    // 首选自启守护：已注册时经服务管理器拉起（win: cmd 守护脚本 / mac: launchctl
    // kickstart / linux: systemctl start），自带崩溃自愈
    const d = autostartDescriptor();
    if (d?.registered && d.launcher) {
      try {
        const child = spawn(d.launcher.cmd, d.launcher.args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => {});
        child.unref();
      } catch {}
      resolve();
      return;
    }
    // 未注册自启：用包内 CLI 起（而不是 cwd 下的 server.js——
    // pi 包的扩展运行时 cwd 是用户项目目录，那里没有 server.js）
    const cli = packagedCli();
    if (cli) {
      try {
        const child = spawn(process.execPath, [cli], { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
      } catch {}
      resolve();
      return;
    }
    resolve();
  });
}

async function ensureLanbook(port: number): Promise<boolean> {
  if (await serviceUp(port)) return true;
  await startLanbook(port);
  // 轮询等待就绪（最多 ~10s）
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await serviceUp(port)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 路径解析

// 展开 ~ 前缀；返回绝对路径
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolveTarget(input: string, cwd: string): string {
  const trimmed = input.trim().replace(/^@+/, ""); // 兼容 @路径 引用
  if (!trimmed) return "";
  return path.resolve(cwd, expandHome(trimmed));
}

// ---------------------------------------------------------------- URL 构造

interface RootInfo {
  rootPath: string; // 配置里的原始字符串（resolveRoot 语义）
  absPath: string;  // 绝对路径
  index: number;    // 配置数组下标
}

// 读取配置 roots，返回 { rootPath, absPath, index }[]
function listRoots(): RootInfo[] {
  const cfg = readKnowledgeConfig();
  return (cfg.roots || [])
    .map((root, index) => ({ rootPath: root, absPath: path.resolve(expandHome(root)), index }))
    .filter((r) => fs.existsSync(r.absPath));
}

// 找包含 target 的最长 root（最具体）
function findMatchingRoot(target: string, roots: RootInfo[]): RootInfo | null {
  const norm = (p: string) => p.toLowerCase().replace(/[\\/]+/g, path.sep);
  const t = norm(target);
  let best: RootInfo | null = null;
  for (const r of roots) {
    const a = norm(r.absPath);
    if (t === a || t.startsWith(a + path.sep)) {
      if (!best || a.length > norm(best.absPath).length) best = r;
    }
  }
  return best;
}

function relFromRoot(target: string, root: RootInfo): string {
  return path.relative(root.absPath, target).split(path.sep).join("/");
}

function isHtml(p: string): boolean {
  return /\.html?$/i.test(p);
}

// 经服务端配置 API 追加根目录：走 HTTP 而非直接改文件，服务端会顺带刷新 watcher。
// 返回该根目录在 roots 数组中的下标（/kbfile/<index>/ 需要）。
async function addRootViaApi(dir: string, port: number): Promise<number> {
  const cfg = await fetchJson(`http://127.0.0.1:${port}/api/knowledge/config`);
  const roots: string[] = Array.isArray(cfg.roots) ? cfg.roots.map(String) : [];
  const exists = roots.findIndex((r) => path.resolve(expandHome(r)) === dir);
  if (exists !== -1) return exists;
  roots.push(dir);
  const body: Record<string, unknown> = { roots };
  if (Array.isArray(cfg.excludeDirs)) body.excludeDirs = cfg.excludeDirs.map(String);
  const res = await fetch(`http://127.0.0.1:${port}/api/knowledge/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return roots.length - 1;
}

// 由 root + 相对路径拼出可访问 URL
function buildUrl(target: string, root: RootInfo, rel: string, base: string): string {
  if (isHtml(target)) {
    // HTML 用 /kbfile/<index>/<rel> 原样托管，保证相对资源可解析
    return `${base}/kbfile/${root.index}/${rel.split("/").map(encodeURIComponent).join("/")}`;
  }
  // Markdown 用渲染视图
  return `${base}/api/knowledge/view?root=${encodeURIComponent(root.rootPath)}&path=${encodeURIComponent(rel)}`;
}

// ---------------------------------------------------------------- 浏览器打开

function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      exec(`start "" "${url}"`, { windowsHide: true }, () => resolve());
    } else if (process.platform === "darwin") {
      exec(`open "${url}"`, () => resolve());
    } else {
      exec(`xdg-open "${url}"`, () => resolve());
    }
  });
}

// ---------------------------------------------------------------- 选择器

interface FileNode {
  name: string;
  type: "file" | "dir";
  title?: string;
  kind?: "md" | "html";
  children?: FileNode[];
}

async function pickFromKnowledge(port: number, ctx: any, pi: ExtensionAPI, base: string): Promise<void> {
  let roots: any[];
  try {
    const data = await fetchJson(`http://127.0.0.1:${port}/api/knowledge`);
    roots = data.roots || [];
  } catch (e: any) {
    ctx.ui.notify(`lanbook 服务未就绪: ${e?.message || e}`, "error");
    return;
  }
  if (roots.length === 0) {
    ctx.ui.notify("lanbook 知识库为空（~/.lanbook/knowledge.config.json 未配置 roots）", "warning");
    return;
  }

  // 收集 (label, absPath) 扁平列表：root/相对路径
  const items: { label: string; value: string }[] = [];
  const sep = " / ";
  const collect = (nodes: FileNode[], rootPath: string, rootLabel: string, prefix: string) => {
    for (const n of nodes) {
      const p = prefix ? `${prefix}/${n.name}` : n.name;
      if (n.type === "file") {
        items.push({ label: `${rootLabel}${sep}${p}`, value: path.join(rootPath, p) });
      } else if (n.children) {
        collect(n.children, rootPath, rootLabel, p);
      }
    }
  };
  // root 的 path 是绝对路径（r.path），直接可拼
  roots.forEach((r: any) => collect(r.children || [], r.path, r.name || path.basename(r.path), ""));

  if (items.length === 0) {
    ctx.ui.notify("知识库中没有文档", "warning");
    return;
  }
  // 截断显示，避免选择器过长
  const options = items.slice(0, 500).map((it) => ({ label: it.label, value: it.value }));
  const chosen = await ctx.ui.select("选择要在浏览器打开的文件：", options);
  if (!chosen) return;

  const lt = await resolveLinkTarget(chosen, port, ctx);
  if (!lt) return;
  await emitLink(pi, chosen, buildUrl(chosen, lt.root, lt.rel, base));
  ctx.ui.notify(`已生成链接: ${chosen}`, "info");
}

// ---------------------------------------------------------------- 链接输出

// 配置：本机是否同时自动打开浏览器（默认 true）
function shouldOpenLocalBrowser(): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), "plugin-config.json"), "utf-8"));
    return cfg.openLocalBrowser !== false;
  } catch {
    return true;
  }
}

// 输出可点击链接到会话（pi-web 渲染 markdown-custom-message；TUI 显示链接文本）
async function emitLink(pi: ExtensionAPI, label: string, url: string): Promise<void> {
  const md = `📄 **${label}**\n\n👉 在浏览器打开: [${url}](${url})`;
  await pi.sendMessage(
    {
      customType: "lanbook-link",
      content: md,
      display: true,
    },
    { deliverAs: "nextTurn" },
  );
}

interface LinkTarget {
  root: RootInfo;
  rel: string;
}

// 定位文件所属根目录。文件不在任何根目录下时，经用户确认把它所在目录加为根目录
// （不再静默改写配置再回滚——中途失败会留下脏 roots）。
// 只做一次定位，调用方可按不同 host 反复拼 URL，不会重复弹确认。
async function resolveLinkTarget(
  target: string,
  port: number,
  ctx: { ui: { notify: (m: string, t?: string) => void; confirm: (t: string, m: string) => Promise<boolean> } },
): Promise<LinkTarget | null> {
  const root = findMatchingRoot(target, listRoots());
  if (root) return { root, rel: relFromRoot(target, root) };

  // 不在任何根目录下：请用户确认后正式加入（走服务端 API，watcher 一并刷新）
  const dir = path.dirname(target);
  const ok = await ctx.ui.confirm(
    "添加到 lanbook 知识库？",
    `${dir}\n\n不在任何知识库根目录下。将它添加为根目录后即可生成链接（配置持久保存）。`,
  );
  if (!ok) {
    ctx.ui.notify(`已取消。可手动执行: lanbook add "${dir}"`, "warning");
    return null;
  }
  try {
    const index = await addRootViaApi(dir, port);
    return { root: { rootPath: dir, absPath: dir, index }, rel: path.basename(target) };
  } catch (e: any) {
    ctx.ui.notify(`添加根目录失败: ${e?.message || e}`, "error");
    return null;
  }
}

// ---------------------------------------------------------------- 子命令

// /lanbook autostart —— 一条命令完成「开机自动启动」
// 注册机制跨平台（Win 计划任务 / macOS launchd / Linux systemd，见 lib/autostart.js 与 ADR-0005）。
// 自启脚本里的 server.js 绝对路径由包内 CLI 自己写入，扩展不重复拼路径。
async function cmdAutostart(pi: ExtensionAPI, ctx: any, remove: boolean): Promise<void> {
  if (process.platform !== "win32") {
    ctx.ui.notify("autostart 目前仅支持 Windows；macOS 用 launchd，Linux 用 systemd user 单元", "warning");
    return;
  }
  const { code, out, err } = await runCli(remove ? ["autostart", "--remove"] : ["autostart"]);
  const text = (out + err).trim();
  if (code !== 0) {
    ctx.ui.notify(`autostart 失败：${text || "未知错误"}`, "error");
    return;
  }
  // CLI 输出多行说明，取有信息量的首行作为通知，完整内容随消息落盘
  const firstLine = text.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
  await pi.sendMessage(
    {
      customType: "lanbook-autostart",
      content: `${remove ? "已卸载" : "已注册"} lanbook 开机自启\n\n\`\`\`\n${text}\n\`\`\``,
      display: true,
    },
    { deliverAs: "nextTurn" },
  );
  ctx.ui.notify(remove ? "已卸载自启" : `已注册自启：${firstLine}`, "info");
}

// /lanbook status —— 看服务是否在跑、跑的是哪份代码、自启是否已注册
// 这是排查「为什么服务没起来」的第一站（路径指向已删除安装目录是常见原因）。
async function cmdStatus(pi: ExtensionAPI, ctx: any): Promise<void> {
  const { port, host, loopback } = linkHost();
  const up = await serviceUp(port);
  const lines: string[] = [];
  lines.push(`服务：${up ? `运行中 http://${host}:${port}` : `未运行（端口 ${port} 无响应）`}`);
  if (up && loopback) lines.push("监听：仅本机（settings.json 的 host 已收敛到回环）");

  const d = autostartDescriptor();
  if (d?.registered) {
    // 自启脚本里写死了 server.js 绝对路径；卸载/重装包后可能指向已不存在的副本
    if (d.target && fs.existsSync(d.target)) {
      lines.push(`自启：已注册（${d.via}），指向 ${d.target}`);
    } else {
      lines.push(`自启：已注册（${d.via}），但指向的 server.js 不存在 —— ${d.target || "无法解析"}`);
      lines.push(`     修复：/lanbook autostart`);
    }
  } else {
    lines.push("自启：未注册（/lanbook autostart 可开启开机自启）");
  }

  const cli = packagedCli();
  lines.push(`包内 CLI：${cli || "未找到"}`);
  await pi.sendMessage(
    { customType: "lanbook-status", content: lines.join("\n"), display: true },
    { deliverAs: "nextTurn" },
  );
  ctx.ui.notify(up ? `lanbook 运行中（${host}:${port}）` : "lanbook 未运行", up ? "info" : "warning");
}

// ---------------------------------------------------------------- 命令

export default function (pi: ExtensionAPI) {
  pi.registerCommand("lanbook", {
    description:
      "lanbook 知识库：链接文件到浏览器 / 开启开机自启。用法: /lanbook [路径] | autostart [--remove] | status",
    handler: async (args, ctx) => {
      const trimmed = (args || "").trim();

      // 子命令优先：这些不需要服务先跑起来
      const [sub, ...rest] = trimmed.split(/\s+/);
      if (sub === "autostart") {
        await cmdAutostart(pi, ctx, rest.includes("--remove"));
        return;
      }
      if (sub === "status") {
        await cmdStatus(pi, ctx);
        return;
      }
      if (sub === "help" || sub === "--help" || sub === "-h") {
        await pi.sendMessage(
          {
            customType: "lanbook-help",
            content: [
              "**/lanbook** — 用法",
              "",
              "| 命令 | 作用 |",
              "|---|---|",
              "| `/lanbook` | 弹出知识库文件选择器 |",
              "| `/lanbook <路径>` | 输出该文件的浏览器链接（局域网内任何设备可打开）|",
              "| `/lanbook <目录>` | 输出知识库首页链接 |",
              "| `/lanbook autostart` | **注册开机自启**（登录自启 + 崩溃自动重启，Win / macOS / Linux）|",
              "| `/lanbook autostart --remove` | 卸载自启 |",
              "| `/lanbook status` | 查看服务与自启状态（排查服务没起来）|",
            ].join("\n"),
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
        return;
      }

      const { host: baseHost, port, loopback } = linkHost();
      const base = `http://${baseHost}:${port}`;

      // 确保 lanbook 服务可用
      if (!(await ensureLanbook(port))) {
        ctx.ui.notify(`无法启动 lanbook 服务 (端口 ${port})。可用 /lanbook status 排查`, "error");
        return;
      }
      // host 收敛到回环时局域网不可达，明确告知，避免拿到打不开的链接后困惑
      if (loopback) {
        ctx.ui.notify(`lanbook host 已收敛到回环，链接仅本机可打开（改 ~/.lanbook/settings.json 的 host 可放开）`, "warning");
      }

      if (!trimmed) {
        // 无参数 → 选择器
        await pickFromKnowledge(port, ctx, pi, base);
        return;
      }

      // 2. 解析路径（支持绝对 / 相对 / ~ / @引用）
      const target = resolveTarget(trimmed, ctx.cwd);
      if (!target) {
        ctx.ui.notify("用法: /lanbook [路径]", "warning");
        return;
      }
      if (!fs.existsSync(target)) {
        ctx.ui.notify(`文件不存在: ${target}`, "error");
        return;
      }

      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        // 目录 → 输出 lanbook 知识库首页链接
        await emitLink(pi, target, `${base}/`);
        if (shouldOpenLocalBrowser()) await openInBrowser(`http://127.0.0.1:${port}/`);
        ctx.ui.notify(`已生成链接: ${target}`, "info");
        return;
      }

      // 3. 文件 → 定位根目录后构造 URL（只定位一次，避免重复弹确认）
      const lt = await resolveLinkTarget(target, port, ctx);
      if (!lt) return;
      await emitLink(pi, target, buildUrl(target, lt.root, lt.rel, base));
      // 本机同时自动打开：host 绑具体网卡时 127.0.0.1 不通，需用该网卡地址
      if (shouldOpenLocalBrowser()) {
        await openInBrowser(buildUrl(target, lt.root, lt.rel, `http://${localOpenHost()}:${port}`));
      }
      ctx.ui.notify(`已生成链接: ${target}`, "info");
    },
  });
}
