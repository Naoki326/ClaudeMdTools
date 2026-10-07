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
 *   - 服务未运行时自动拉起（复用 ~/.lanbook/autostart-task.cmd），轮询等待就绪
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
import { exec } from "node:child_process";
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

function autostartCmdPath(): string {
  return path.join(dataDir(), "autostart-task.cmd");
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
    // 复用 lanbook 自带的 autostart-task.cmd（隐藏窗口后台启动，日志追加到 ~/.lanbook/logs/service.log）
    const cmd = autostartCmdPath();
    if (fs.existsSync(cmd)) {
      exec(`cmd /c start "" "${cmd}"`, { windowsHide: true }, () => resolve());
    } else {
      // 兜底：直接 node server.js（源码模式路径）
      const server = path.join(process.cwd(), "server.js");
      exec(`cmd /c start "" node "${server}"`, { windowsHide: true }, () => resolve());
    }
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

// ---------------------------------------------------------------- 命令

export default function (pi: ExtensionAPI) {
  pi.registerCommand("lanbook", {
    description:
      "输出 Markdown / HTML 文件在 lanbook 的可点击链接（局域网内任何设备可打开）。用法: /lanbook [路径]，无参数时弹出知识库文件选择器",
    handler: async (args, ctx) => {
      const { host: baseHost, port, loopback } = linkHost();
      const base = `http://${baseHost}:${port}`;

      // 1. 确保 lanbook 服务可用
      if (!(await ensureLanbook(port))) {
        ctx.ui.notify(`无法启动 lanbook 服务 (端口 ${port})`, "error");
        return;
      }
      // host 收敛到回环时局域网不可达，明确告知，避免拿到打不开的链接后困惑
      if (loopback) {
        ctx.ui.notify(`lanbook host 已收敛到回环，链接仅本机可打开（改 ~/.lanbook/settings.json 的 host 可放开）`, "warning");
      }

      const trimmed = (args || "").trim();
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
