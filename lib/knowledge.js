'use strict';
// 知识库领域模块（工单 #5 prefactor）：扫描 / 树 / 标题缓存 / 监听 / 失效的
// 唯一真相。server.js 的 /api/knowledge*、/kb*、/kbfile 路由只做委托——
// 树数据（与标题缓存）只由本模块生产，后续树级缓存 / 目录级剪枝 / view 复用
// 以此为共同地基。
//
// 纯抽取自 server.js，行为不变。接缝：
// - dataDir            数据目录（knowledge.config.json 的家，ADR-0001）
// - baseDir            安装目录（LOCAL_EXCLUDE_DIRS 按绝对路径排除其中的 docs/）
// - resolveRoot        配置 root 字符串 → 绝对路径（~ 展开 + resolve；课程配置
//                      共用同一规则，真源留在 server.js，此处注入）
// - onKnowledgeChange  知识库文档变化回调（server.js 注入 WebSocket 广播，
//                      payload 固定 { type: 'knowledge-change', event }）
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

// /kbfile 静态托管允许的文件类型（HTML 文档及其相对资源）
const KB_STATIC_EXTS = ['.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf'];

function createKnowledgeService({ dataDir, baseDir, resolveRoot, onKnowledgeChange }) {
  const KNOWLEDGE_CONFIG_FILE = path.join(dataDir, 'knowledge.config.json');

  // 内置默认排除的目录名（小写匹配）
  // 注意：'docs' 不在默认列表中 -- 大多数项目的 docs/ 里有有价值的文档。
  // 如需排除特定目录，通过 knowledge.config.json 的 excludeDirs 配置。
  // lanbook 自身的 docs/ 通过 LOCAL_EXCLUDE_DIRS 按绝对路径排除，避免误伤其他项目。
  const DEFAULT_EXCLUDED = [
    'node_modules', '.git', '.svn', 'bin', 'obj', 'dist', 'build',
    '.next', 'coverage', '__pycache__', '.venv', 'venv', '.idea',
    'target', 'out', 'logs', '.cache', '.vs', 'packages',
    '.vscode', '.claude', '.husky', '.turbo', '.gradle',
    // pi / 其它 agent 工具目录：内含瞬态任务锁文件（.pi/tasks/*.lock），
    // 若不排除，chokidar 会监听它们并在 Windows 上触发 EPERM 崩溃
    '.pi', '.pi-glla', '.zread',
    // 注意：.scratch 不在此列 —— 它是 agent 草稿区，常含需频繁查阅的文档
    // （审查报告、spec 草稿、图表产物），知识库需收录；其中的瞬态文件
    // （.log/.png/.lock 等）由 WATCHER_TRANSIENT_PATTERNS + knowledge
    // watcher 的文档级剪枝（ignored 回调）双重兜底，不会进监听
  ];

  // 瞬态文件/目录名（watcher 专用）：锁文件、临时文件、Office 占用锁等。
  // 这些文件被其它进程占用/删除时，Windows 上访问会 EPERM，必须从监听中排除。
  // 注意：这些不加入 DEFAULT_EXCLUDED，避免影响扫描（扫描只看文档扩展名，天然忽略）。
  const WATCHER_TRANSIENT_PATTERNS = [
    /\.lock$/i,        // 锁文件（pi tasks、git index.lock 等）
    /\.tmp$/i,         // 临时文件
    /~\$.*$/i,         // Office 占用锁（~$xxx.docx）
    /^\.#.*$/i,       // Emacs 自动保存锁
    /\/\.[^\/]+?\.sw[p-x]$/i, // Vim swap
  ];

  // 按绝对路径排除的目录（源码模式下本仓库的 docs/，防止管理文档在知识库视图中重复；
  // 与 1.1 行为保持一致）
  const LOCAL_EXCLUDE_DIRS = [path.join(baseDir, 'docs')];

  // 构建有效排除集合：内置默认 + 配置文件中的 excludeDirs + 可选的额外目录
  function getExcludedSet(extraDirs) {
    const config = readConfig();
    const fromConfig = (config.excludeDirs || []).map(d => String(d).toLowerCase());
    const fromArg = (extraDirs || []).map(d => String(d).toLowerCase());
    return new Set([...DEFAULT_EXCLUDED, ...fromConfig, ...fromArg]);
  }

  // 判断路径是否应被排除：先查目录名黑名单，再查绝对路径黑名单
  function isExcluded(fullPath, dirName, excludedSet) {
    const excluded = excludedSet || getExcludedSet();
    if (dirName && excluded.has(dirName.toLowerCase())) return true;
    const norm = path.resolve(fullPath);
    return LOCAL_EXCLUDE_DIRS.some(d => norm === d || norm.startsWith(d + path.sep));
  }

  function readConfig() {
    try {
      if (fs.existsSync(KNOWLEDGE_CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(KNOWLEDGE_CONFIG_FILE, 'utf-8'));
      }
    } catch {}
    return { roots: [] };
  }

  function writeConfig(config) {
    fs.writeFileSync(KNOWLEDGE_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  }

  // 从 Markdown 内容提取标题（# 标题）
  function titleFromMarkdown(content) {
    const m = content.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : null;
  }

  // 知识库文档扩展名：.md / .html / .htm
  function isKnowledgeDoc(fileName) {
    const n = String(fileName).toLowerCase();
    return n.endsWith('.md') || n.endsWith('.html') || n.endsWith('.htm');
  }

  // 是否为 HTML 文档
  function isHtmlDoc(fileName) {
    const n = String(fileName).toLowerCase();
    return n.endsWith('.html') || n.endsWith('.htm');
  }

  // 从 HTML 提取标题：<title> 优先，其次第一个 <h1>，都无则 null
  function titleFromHtml(content) {
    const t = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) { const s = t[1].replace(/<[^>]+>/g, '').trim(); if (s) return s; }
    const h = content.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h) { const s = h[1].replace(/<[^>]+>/g, '').trim(); if (s) return s; }
    return null;
  }

  // 从 Markdown 提取目录（标题列表）：只取 ## ~ ######（h1 视为文档标题不入目录）
  // 返回 [{ level, text }]
  // 注意：仅用于读取文档标题信息，实际锚点 id 由渲染页客户端基于 DOM 生成（与 index.html 一致）
  function tocFromMarkdown(content) {
    const toc = [];
    const lines = String(content || '').split(/\r?\n/);
    let inFence = false;
    for (const line of lines) {
      const fence = line.match(/^\s*(```+|~~~+)/);
      if (fence) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = line.match(/^(#{2,6})\s+(.+?)\s*#*\s*$/);
      if (!m) continue;
      const level = m[1].length;
      const text = m[2].replace(/\\([`*_\[\]])/g, '$1').replace(/[*_~`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
      if (!text) continue;
      toc.push({ level, text });
    }
    return toc;
  }

  // 剥离 YAML frontmatter（文件以 --- 开头的元数据块），避免被 marked 误渲染为标题
  // 严格匹配：首行必须是 --- 且存在配对 ---，否则原样返回（不误伤水平线）
  function stripFrontmatter(content) {
    const s = String(content || '');
    const m = s.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    if (!m) return s;
    // frontmatter 内第二行通常是键值对（name:/description:/metadata:），防止把正文首行 --- 误判
    const fmBody = m[0].replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '');
    if (!fmBody || !/^[A-Za-z_][\w.-]*\s*:/.test(fmBody)) return s;
    return s.slice(m[0].length);
  }

  // 递归扫描目录下所有知识库文档（.md / .html / .htm，排除常见无关目录）
  function scanKnowledgeFiles(dir, base, acc, excludedSet) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isExcluded(full, e.name, excludedSet)) continue;
        scanKnowledgeFiles(full, base, acc, excludedSet);
      } else if (e.isFile() && isKnowledgeDoc(e.name)) {
        acc.push({ abs: full, rel: path.relative(base, full).replace(/\\/g, '/') });
      }
    }
  }

  // 文档标题缓存：abs 路径 → { mtime, title }。/api/knowledge 每次请求都会
  // 全量 scanTree，逐文档 readFileSync 提取标题是主要耗时（千级文档 × 同步 IO，
  // Windows 上秒级）；mtime 未变的文档直接复用上次标题，重复请求的 IO 从
  // 「读全文」降到「仅 stat」。
  const titleCache = new Map();

  // 扫描目录构建树：只保留含知识库文档（.md/.html/.htm）的分支（空文件夹自动隐藏）
  // 返回 children 数组，每个节点是 { type:'dir', name, children } 或 { type:'file', name, title, kind, mtime }
  function scanTree(dir, base, excludedSet) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    // 先排序：目录在前，文件在后；各自按名称排
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const children = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (isExcluded(full, e.name, excludedSet)) continue;
        const sub = scanTree(full, base, excludedSet);
        if (sub.length > 0) children.push({ type: 'dir', name: e.name, children: sub });
      } else if (e.isFile() && isKnowledgeDoc(e.name)) {
        // 先 stat 拿 mtime：命中缓存（mtime 未变）则跳过全文读取
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        const cached = titleCache.get(full);
        let title;
        if (cached && cached.mtime === mtime) {
          title = cached.title;
        } else {
          try {
            const content = fs.readFileSync(full, 'utf-8');
            title = isHtmlDoc(e.name)
              ? (titleFromHtml(content) || e.name.replace(/\.html?$/i, ''))
              : (titleFromMarkdown(content) || e.name.replace(/\.md$/i, ''));
          } catch { title = e.name.replace(/\.(md|html?)$/i, ''); }
          titleCache.set(full, { mtime, title });
        }
        children.push({ type: 'file', name: e.name, title, kind: isHtmlDoc(e.name) ? 'html' : 'md', mtime });
      }
    }
    return children;
  }

  // 发现知识库内容：以配置的 root 为顶层，下面是完整目录树
  function discover() {
    const config = readConfig();
    const excludedSet = getExcludedSet();
    const roots = [];
    (config.roots || []).forEach((root, index) => {
      const rootPath = resolveRoot(root);
      if (!fs.existsSync(rootPath)) return;
      const children = scanTree(rootPath, rootPath, excludedSet);
      if (children.length > 0) {
        roots.push({ name: path.basename(rootPath), path: rootPath.replace(/\\/g, '/'), index, children });
      }
    });
    return roots;
  }

  // 解析知识库文件路径（安全检查：必须在某个 root 内）
  function resolvePath(root, relPath) {
    if (!root || !relPath) return null;
    const rootPath = resolveRoot(String(root));
    const config = readConfig();
    const inRoots = (config.roots || []).some(r => resolveRoot(r) === rootPath);
    if (!inRoots) return null;
    const abs = path.resolve(rootPath, String(relPath));
    if (abs !== rootPath && !abs.startsWith(rootPath + path.sep)) return null;
    if (!isKnowledgeDoc(abs)) return null;
    return abs;
  }

  // —— watcher 统一健壮性 ——
  // 1) ignored 规则：目录名黑名单（与扫描一致）+ 瞬态文件模式（锁/临时/Office）
  //    保证 chokidar 不监听 .pi/tasks/*.lock 这类会产生 EPERM 的路径
  // 2) error 兜底：Windows 上文件被占用/删除时 chokidar 可能 emit error，
  //    不处理会 Unhandled error 直接崩溃——记录日志，不终止服务
  function isWatcherIgnored(p, excludedSet) {
    if (typeof p !== 'string' || !p) return false;
    // 路径段级匹配：检查每一段是否命中目录名黑名单（node_modules/.git/.pi 等）。
    // chokidar 回调收到的是完整路径（如 root/node_modules/x/y.js），
    // 只匹配 basename 会漏掉嵌套目录（原 bug），必须逐段检查。
    const segments = p.split(/[\\/]+/).filter(Boolean);
    for (const seg of segments) {
      const name = seg.toLowerCase();
      if (DEFAULT_EXCLUDED.includes(name)) return true;
      if (excludedSet && excludedSet.has(name)) return true;
    }
    // 瞬态文件模式（锁文件、临时文件、Office 锁）——匹配完整路径
    if (WATCHER_TRANSIENT_PATTERNS.some(re => re.test(p))) return true;
    // 绝对路径黑名单
    const norm = path.resolve(p);
    return LOCAL_EXCLUDE_DIRS.some(d => norm === d || norm.startsWith(d + path.sep));
  }

  function onWatcherError(label, err) {
    // EPERM/ENOENT 等瞬时文件错误：记录并继续，不让单文件问题打死整个服务
    console.error(`[watcher:${label}] 监听错误（已忽略，服务继续运行）:`, err?.code || err?.message || err);
  }

  // 监听知识库根目录变化（server.js 注入 onKnowledgeChange 做广播；配置变更后
  // 由路由调 refreshWatcher 按新 roots 重建监听——失效入口收敛在本模块）
  let knowledgeWatcher = null;
  function refreshWatcher() {
    if (knowledgeWatcher) { try { knowledgeWatcher.close(); } catch {} knowledgeWatcher = null; }
    const config = readConfig();
    if (!config.roots.length) return;
    const excluded = getExcludedSet();
    knowledgeWatcher = chokidar.watch(config.roots.map(r => resolveRoot(r)), {
      // 文档级剪枝：非知识文档（.log/.png/.lock 等瞬态产物，.scratch 草稿区尤多）
      // 不进监听 —— 省事件风暴，也避免 awaitWriteFinish poll 独占文件触发 EPERM。
      // stats 为 undefined（初始路径判断）时退回目录名黑名单，行为不弱于旧版。
      ignored: (p, stats) => {
        if (stats && stats.isFile() && !isKnowledgeDoc(p)) return true;
        return isWatcherIgnored(p, excluded);
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    knowledgeWatcher.on('error', (err) => onWatcherError('knowledge', err));
    knowledgeWatcher.on('all', (event, filePath) => {
      if (!isKnowledgeDoc(filePath)) return;
      if (onKnowledgeChange) onKnowledgeChange({ type: 'knowledge-change', event });
    });
  }

  // 关闭监听（server.js 优雅关闭时调用）
  function close() {
    if (knowledgeWatcher) { try { knowledgeWatcher.close(); } catch {} knowledgeWatcher = null; }
  }

  return {
    // 配置（knowledge.config.json 读写）
    readConfig, writeConfig,
    // 排除集合（知识库扫描与课程 workspace 发现共用）
    getExcludedSet, isExcluded,
    // 文档元数据提取（view / file 路由与渲染共用）
    isHtmlDoc, titleFromMarkdown, titleFromHtml, tocFromMarkdown, stripFrontmatter,
    // 扫描 / 树 / 路径解析（树数据的唯一生产入口）
    scanKnowledgeFiles, discover, resolvePath,
    // 监听 / 失效（refreshWatcher 按配置重建监听；close 供优雅关闭）
    refreshWatcher, close, isWatcherIgnored, onWatcherError,
  };
}

module.exports = { createKnowledgeService, KB_STATIC_EXTS };
