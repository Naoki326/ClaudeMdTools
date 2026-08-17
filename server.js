const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const marked = require('marked');
const markedKatex = require('marked-katex-extension');
const { resolveDataDir, initDataDir } = require('./lib/data-dir');
const { resolveListen } = require('./lib/settings');

// marked 渲染器：mermaid 代码块输出为 <div class="mermaid">，供前端 mermaid.js 渲染；
// 同时重写图片相对路径 → /kbfile/<rootIndex>/<路径>，让 Markdown 里的本地图片能正常显示
const kbRenderer = new marked.Renderer();
{
  const r = kbRenderer;
  r.code = function(token) {
    // marked v12 传对象 { text, lang, escaped }
    const text = typeof token === 'object' ? token.text : token;
    const lang = typeof token === 'object' ? (token.lang || '') : arguments[1];
    if (lang === 'mermaid') {
      return '<div class="mermaid">' + String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>';
    }
    // 非默认 renderer 需要手动输出代码块结构
    const cls = lang ? ' class="language-' + lang + '"' : '';
    return '<pre><code' + cls + '>' + String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</code></pre>';
  };
  // 图片相对路径重写：仅在调用方传入 kbCtx（{ rootIndex, docRelPath }）时生效
  // marked v12：code 回调传 token 对象，但 image 回调是旧式 (href, title, text) 多参数！
  r.image = function(href, title, text) {
    const ctx = r._kbCtx;
    if (ctx && href && !/^(https?:|data:|<)/i.test(href)) {
      const docDir = path.posix.dirname((ctx.docRelPath || '').replace(/\\/g, '/'));
      const joined = path.posix.normalize((docDir === '.' ? '' : docDir + '/') + href);
      const clean = joined.replace(/^\.\//, '');
      href = '/kbfile/' + ctx.rootIndex + '/' + clean.split('/').map(encodeURIComponent).join('/');
    }
    return '<img src="' + href + '"' + (title ? ' title="' + title + '"' : '') + ' alt="' + (text || '') + '">';
  };
  marked.use({ renderer: r });
}
// 数学公式扩展（epic #7 D3）：`$...$` 行内 / `$$...$$` 块级 → KaTeX 静态 HTML。
// 仅挂在本进程的服务端 marked 实例上——其唯一 parse 调用点就是渲染页
// /api/knowledge/view，不影响 index.html 客户端 vendor marked（D4 客户端另有其道）。
// throwOnError:false —— 坏公式降级为原样源码显示，不 throw 阻断整页渲染。
{
  marked.use(markedKatex({ throwOnError: false }));
}

const app = express();

// ============================================================
// 数据目录（ADR-0001，术语见 CONTEXT.md）
// ============================================================
// 服务全部可变状态（知识库配置 / 课程配置 / 对话元数据）存放在数据目录
// ~/.lanbook/（LANBOOK_HOME 可覆盖）；安装目录只读，源码模式与安装模式
// 读写同一数据目录。启动时先完成旧位置（安装目录）三文件迁移，再读写。
const DATA_DIR = resolveDataDir();
const { migrated } = initDataDir(DATA_DIR, __dirname);
for (const label of migrated) {
  console.log(`迁移: ${label} 已迁入数据目录（旧文件改名 *.migrated.bak 留底）`);
}

// 服务配置（ADR-0003 / CONTEXT.md「服务配置」）：数据目录 settings.json 的
// port / host。生效优先级：PORT 环境变量 > settings > 内置默认 8080 / 0.0.0.0；
// 改动重启后生效（PM2 等注入的 PORT env 依然优先生效）。
const { port: PORT, host: HOST } = resolveListen(DATA_DIR);

const DOCS_DIR = path.join(DATA_DIR, 'docs');
const METADATA_FILE = path.join(DOCS_DIR, '.metadata.json');
const TEACH_CONFIG_FILE = path.join(DATA_DIR, 'teach.config.json');

// 从 sourcePath 推导可读标题
// 例: C:\Work\maprefact\openspec\changes\refactor-map-matrix-polymorphism\design.md
//   → "Refactor Map Matrix Polymorphism - Design"
function titleFromSourcePath(sourcePath, fallbackName) {
  const normalized = sourcePath.replace(/\\\\/g, '/').replace(/\\/g, '/');
  const parts = normalized.split('/');
  const fileName = (parts.pop() || fallbackName).replace(/\.md$/, '');
  const dirName = parts.pop() || '';
  if (!dirName || dirName === fileName) {
    return humanize(fileName);
  }
  return `${humanize(dirName)} - ${capitalize(fileName)}`;
}

function humanize(str) {
  return str.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// 将路径开头的 ~ 展开为用户主目录，其余交给 path.resolve
// 支持 '~/Work'、'~'、'~/'；原样保留绝对/相对路径
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// 解析配置中的 root 路径：先展开 ~，再 resolve 为绝对路径
function resolveRoot(p) {
  return path.resolve(expandHome(p));
}

// 从 sourcePath 推导文件所属的“文件夹”（项目名）
// 规则：取 ../X/... 中的第一级目录名 X；没有 ../ 的归为“本仓库”
// 例如 ../maprefact/openspec/specs/x.md -> maprefact
//      ../lanbook/notes/x.md         -> lanbook
//      README.md                      -> 本仓库
function folderFromSourcePath(sourcePath) {
  if (!sourcePath) return null;
  const normalized = sourcePath.replace(/\\/g, '/');
  // 去掉开头的 ./ 或 ../ 前缀
  const stripped = normalized.replace(/^(?:\.\.?\/)+/, '');
  if (!stripped || stripped === normalized) {
    // 没有 ../ 前缀（本仓库内文件）
    return '本仓库';
  }
  const firstSeg = stripped.split('/')[0];
  return firstSeg || '本仓库';
}

// 元数据读写（数据目录 docs/.metadata.json，由 initDataDir 确保目录存在）
function readMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function writeMetadata(data) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/files — 列出所有 .md 文件（含元数据，按对话分组）
app.get('/api/files', (req, res) => {
  try {
    const metadata = readMetadata();
    const files = fs.readdirSync(DOCS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const stat = fs.statSync(path.join(DOCS_DIR, f));
        const meta = metadata[f] || {};
        // 生成显示标题：优先用 # 标题，其次从 sourcePath 推导
        let title = null;
        try {
          const content = fs.readFileSync(path.join(DOCS_DIR, f), 'utf-8');
          const m = content.match(/^#\s+(.+)$/m);
          if (m) title = m[1].trim();
        } catch {}
        if (!title && meta.sourcePath) {
          title = titleFromSourcePath(meta.sourcePath, f);
        }
        return {
          name: f,
          title: title || f.replace(/\.md$/, ''),
          mtime: stat.mtimeMs,
          sessionId: meta.sessionId || null,
          timestamp: meta.timestamp || stat.birthtimeMs,
          sourcePath: meta.sourcePath || null,
        };
      });

    // 按 timestamp 降序排列（新文件在前）
    files.sort((a, b) => b.timestamp - a.timestamp);

    // 按对话分组
    const groups = [];
    const groupMap = new Map();
    for (const f of files) {
      const key = f.sessionId || '__ungrouped__';
      if (!groupMap.has(key)) {
        const group = { sessionId: f.sessionId, files: [] };
        groupMap.set(key, group);
        groups.push(group);
      }
      groupMap.get(key).files.push(f);
    }

    // 按“文件夹”（来源项目）分组 —— 以 sourcePath 的第一级目录为准
    const folderGroups = [];
    const folderMap = new Map();
    for (const f of files) {
      const folder = folderFromSourcePath(f.sourcePath) || '未分类';
      if (!folderMap.has(folder)) {
        folderMap.set(folder, { folder, files: [] });
        folderGroups.push(folderMap.get(folder));
      }
      folderMap.get(folder).files.push(f);
    }

    res.json({ groups, folderGroups, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/:name — 获取指定文件内容
app.get('/api/files/:name', (req, res) => {
  const filePath = path.join(DOCS_DIR, req.params.name);
  if (!filePath.startsWith(DOCS_DIR)) {
    return res.status(400).json({ error: '无效路径' });
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ name: req.params.name, content });
  } catch (err) {
    res.status(404).json({ error: '文件不存在' });
  }
});

// POST /api/files — 创建新文件
app.post('/api/files', (req, res) => {
  const { name, content } = req.body;
  if (!name || !name.endsWith('.md')) {
    return res.status(400).json({ error: '文件名必须以 .md 结尾' });
  }
  const safeName = path.basename(name);
  const filePath = path.join(DOCS_DIR, safeName);
  if (fs.existsSync(filePath)) {
    return res.status(409).json({ error: '文件已存在' });
  }
  try {
    fs.writeFileSync(filePath, content || '', 'utf-8');
    res.status(201).json({ name: safeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/files/:name — 更新文件内容
app.put('/api/files/:name', (req, res) => {
  const filePath = path.join(DOCS_DIR, req.params.name);
  if (!filePath.startsWith(DOCS_DIR)) {
    return res.status(400).json({ error: '无效路径' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  try {
    const content = typeof req.body === 'string' ? req.body : req.body.content;
    fs.writeFileSync(filePath, content, 'utf-8');
    res.json({ name: req.params.name, message: '已保存' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/files/:name — 删除文件
app.delete('/api/files/:name', (req, res) => {
  const filePath = path.join(DOCS_DIR, req.params.name);
  if (!filePath.startsWith(DOCS_DIR)) {
    return res.status(400).json({ error: '无效路径' });
  }
  try {
    fs.unlinkSync(filePath);
    // 清理元数据
    const metadata = readMetadata();
    delete metadata[req.params.name];
    writeMetadata(metadata);
    res.json({ message: '已删除' });
  } catch (err) {
    res.status(404).json({ error: '文件不存在' });
  }
});

// POST /api/metadata — Hook 脚本调用，记录文件的对话元数据
// 已有元数据的文件保留原始 sessionId（保持在创建时的对话分组中）
app.post('/api/metadata', (req, res) => {
  const { fileName, sessionId, timestamp, sourcePath } = req.body;
  if (!fileName) {
    return res.status(400).json({ error: '缺少 fileName' });
  }
  const metadata = readMetadata();
  const existing = metadata[fileName];
  if (existing && existing.sessionId) {
    // 文件已存在：保留原始 sessionId，仅更新 sourcePath
    existing.sourcePath = sourcePath || existing.sourcePath;
  } else {
    // 新文件：记录完整元数据
    metadata[fileName] = {
      sessionId: sessionId || null,
      timestamp: timestamp || Date.now(),
      sourcePath: sourcePath || null,
    };
  }
  writeMetadata(metadata);
  res.json({ message: 'ok' });
});

// ============================================================
// /teach 课程网页 —— 托管外部的教学 workspace
// ============================================================
// 一个"教学 workspace"是含 lessons/ 目录的文件夹，通常由 /teach 生成：
//   workspace/
//   ├── lessons/*.html      课程（相对引用 ../assets、../reference）
//   ├── reference/*.html    速查卡
//   └── assets/*            共享样式/脚本
// 这些 HTML 之间用相对路径互引，因此必须保持目录树整体托管，
// 不能像 .md 那样拍平复制进 docs 目录。

function readTeachConfig() {
  try {
    if (fs.existsSync(TEACH_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(TEACH_CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return { roots: [] };
}

function writeTeachConfig(config) {
  fs.writeFileSync(TEACH_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// 扫描配置的 roots，发现所有教学 workspace（含 lessons/ 目录的子文件夹）
function discoverWorkspaces() {
  const config = readTeachConfig();
  const workspaces = [];
  const usedIds = new Set();
  for (const root of config.roots || []) {
    const rootPath = resolveRoot(root);
    if (!fs.existsSync(rootPath)) continue;
    let entries = [];
    try { entries = fs.readdirSync(rootPath, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsPath = path.join(rootPath, entry.name);
      const lessonsDir = path.join(wsPath, 'lessons');
      if (!fs.existsSync(lessonsDir)) continue;
      // 生成唯一 id（优先用目录名，重名时加序号后缀）
      let id = entry.name;
      let n = 2;
      while (usedIds.has(id)) { id = `${entry.name}-${n++}`; }
      usedIds.add(id);
      // 标题优先取 MISSION.md 的 "# Mission: xxx"，没有则回退文件夹名
      workspaces.push({ id, name: entry.name, title: titleFromMission(wsPath) || entry.name, path: wsPath });
    }
  }
  return workspaces;
}

// 从 HTML 内容提取 <title>
function titleFromHtml(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
}

// 从 workspace 根目录的 MISSION.md 提取标题（# Mission: xxx）
// 课程树侧边栏标题优先用它，而不是文件夹名称
function titleFromMission(wsPath) {
  try {
    const md = fs.readFileSync(path.join(wsPath, 'MISSION.md'), 'utf-8');
    const m = md.match(/^#\s*Mission:?\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

// 列出某个 workspace 下的课程与速查卡
function getWorkspaceContent(wsPath) {
  const result = { lessons: [], reference: [] };
  for (const kind of ['lessons', 'reference']) {
    const dir = path.join(wsPath, kind);
    if (!fs.existsSync(dir)) continue;
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.html')) continue;
      const fp = path.join(dir, f);
      try {
        const stat = fs.statSync(fp);
        const content = fs.readFileSync(fp, 'utf-8');
        result[kind].push({
          file: f,
          title: titleFromHtml(content) || f.replace(/\.html$/, ''),
          mtime: stat.mtimeMs,
        });
      } catch {}
    }
    result[kind].sort((a, b) => a.file.localeCompare(b.file));
  }
  return result;
}

// GET /api/courses — 列出所有教学 workspace 及其课程/速查卡
app.get('/api/courses', (req, res) => {
  try {
    const workspaces = discoverWorkspaces().map(ws => ({
      id: ws.id,
      name: ws.name,
      title: ws.title,
      ...getWorkspaceContent(ws.path),
    }));
    res.json({ workspaces });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET/POST /api/courses/config — 读取/更新教学根目录配置
app.get('/api/courses/config', (req, res) => {
  res.json(readTeachConfig());
});

app.post('/api/courses/config', (req, res) => {
  const { roots } = req.body;
  if (!Array.isArray(roots)) {
    return res.status(400).json({ error: 'roots 必须是字符串数组' });
  }
  writeTeachConfig({ roots: roots.map(r => String(r)) });
  refreshTeachWatcher();
  res.json({ message: 'ok' });
});

// POST /api/courses/preview — 预览给定 roots 各自能发现多少教学 workspace
// 用于配置对话框实时显示每个根目录是否生效、找到了哪些工作区
app.post('/api/courses/preview', (req, res) => {
  const { roots } = req.body;
  if (!Array.isArray(roots)) {
    return res.status(400).json({ error: 'roots 必须是字符串数组' });
  }
  const result = roots.map(root => {
    const rootPath = resolveRoot(String(root));
    if (!fs.existsSync(rootPath)) {
      return { root, exists: false, workspaces: [] };
    }
    let entries = [];
    try { entries = fs.readdirSync(rootPath, { withFileTypes: true }); } catch {}
    const wss = entries
      .filter(e => e.isDirectory() && fs.existsSync(path.join(rootPath, e.name, 'lessons')))
      .map(e => e.name);
    return { root, exists: true, workspaces: wss };
  });
  res.json({ preview: result });
});

// 静态托管教学 workspace —— 保持 lessons/ reference/ assets/ 目录树，
// 使课程 HTML 中的相对路径引用（../assets/style.css 等）正常工作。
// 路径形如 /teach/<workspaceId>/lessons/0001-xxx.html
app.use('/teach', (req, res, next) => {
  const rel = decodeURIComponent(req.path).replace(/^\/+/, '');
  const slashIdx = rel.indexOf('/');
  if (slashIdx === -1) return res.status(404).send('未找到 workspace');
  const wsId = rel.slice(0, slashIdx);
  const fileRel = rel.slice(slashIdx + 1);
  if (!fileRel) return res.status(404).send('未指定文件');
  const ws = discoverWorkspaces().find(w => w.id === wsId);
  if (!ws) return res.status(404).send('未找到 workspace');
  const filePath = path.resolve(ws.path, fileRel);
  // 路径安全：禁止逃逸出 workspace 根目录
  if (filePath !== ws.path && !filePath.startsWith(ws.path + path.sep)) {
    return res.status(400).send('无效路径');
  }
  // dotfiles: 'allow' —— workspace 可能位于 .scratch 等点开头的目录（teach 工作区），
  // send 库默认 dotfiles:'ignore' 会对点目录直接 404（列表接口用 fs 直读不受影响，导致
  // 「列表有课、点开 404」的假象）。
  res.sendFile(filePath, { dotfiles: 'allow' }, err => {
    if (err && !res.headersSent) res.status(404).send('文件不存在');
  });
});

// ============================================================
// 知识库 -- 直接读取外部文件夹的 .md 文档（不复制）
// ============================================================
// 和课程视图对称：配置根目录 -> 递归扫描 .md -> 按项目分组展示
// 文件保持原位读取/编辑，不复制进 docs/

const KNOWLEDGE_CONFIG_FILE = path.join(DATA_DIR, 'knowledge.config.json');

// 内置默认排除的目录名（小写匹配）
// 注意：'docs' 不在默认列表中 -- 大多数项目的 docs/ 里有有价值的文档。
// 如需排除特定目录，通过 knowledge.config.json 的 excludeDirs 配置。
// lanbook 自身的 docs/ 通过 LOCAL_EXCLUDE_DIRS 按绝对路径排除，避免误伤其他项目。
const DEFAULT_EXCLUDED = [
  'node_modules', '.git', '.svn', 'bin', 'obj', 'dist', 'build',
  '.next', 'coverage', '__pycache__', '.venv', 'venv', '.idea',
  'target', 'out', 'logs', '.cache', '.vs', 'packages',
  '.vscode', '.claude', '.husky', '.turbo', '.gradle',
];

// 按绝对路径排除的目录（源码模式下本仓库的 docs/，防止管理文档在知识库视图中重复；
// 与 1.1 行为保持一致）
const LOCAL_EXCLUDE_DIRS = [path.join(__dirname, 'docs')];

// 构建有效排除集合：内置默认 + 配置文件中的 excludeDirs + 可选的额外目录
function getExcludedSet(extraDirs) {
  const config = readKnowledgeConfig();
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

function readKnowledgeConfig() {
  try {
    if (fs.existsSync(KNOWLEDGE_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(KNOWLEDGE_CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return { roots: [] };
}

function writeKnowledgeConfig(config) {
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

// /kbfile 静态托管允许的文件类型（HTML 文档及其相对资源）
const KB_STATIC_EXTS = ['.html', '.htm', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf'];

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
      let title = null;
      try {
        const content = fs.readFileSync(full, 'utf-8');
        if (isHtmlDoc(e.name)) {
          title = titleFromHtml(content) || e.name.replace(/\.html?$/i, '');
        } else {
          title = titleFromMarkdown(content) || e.name.replace(/\.md$/i, '');
        }
      } catch { title = e.name.replace(/\.(md|html?)$/i, ''); }
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      children.push({ type: 'file', name: e.name, title, kind: isHtmlDoc(e.name) ? 'html' : 'md', mtime });
    }
  }
  return children;
}

// 发现知识库内容：以配置的 root 为顶层，下面是完整目录树
function discoverKnowledge() {
  const config = readKnowledgeConfig();
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
function resolveKnowledgePath(root, relPath) {
  if (!root || !relPath) return null;
  const rootPath = resolveRoot(String(root));
  const config = readKnowledgeConfig();
  const inRoots = (config.roots || []).some(r => resolveRoot(r) === rootPath);
  if (!inRoots) return null;
  const abs = path.resolve(rootPath, String(relPath));
  if (abs !== rootPath && !abs.startsWith(rootPath + path.sep)) return null;
  if (!isKnowledgeDoc(abs)) return null;
  return abs;
}

// GET /api/knowledge - 列出知识库文档（树形结构：root 顶层 + 目录树）
app.get('/api/knowledge', (req, res) => {
  try { res.json({ roots: discoverKnowledge() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET/POST /api/knowledge/config - 读取/更新知识库根目录配置
app.get('/api/knowledge/config', (req, res) => {
  res.json(readKnowledgeConfig());
});
app.post('/api/knowledge/config', (req, res) => {
  const { roots, excludeDirs } = req.body;
  if (!Array.isArray(roots)) return res.status(400).json({ error: 'roots 必须是字符串数组' });
  const config = { roots: roots.map(String) };
  if (Array.isArray(excludeDirs)) {
    config.excludeDirs = excludeDirs.map(String).filter(Boolean);
  }
  writeKnowledgeConfig(config);
  refreshKnowledgeWatcher();
  res.json({ message: 'ok' });
});

// POST /api/knowledge/preview - 预览每个 root 发现的文档（.md/.html）数量和项目
app.post('/api/knowledge/preview', (req, res) => {
  const { roots, excludeDirs } = req.body;
  if (!Array.isArray(roots)) return res.status(400).json({ error: 'roots 必须是字符串数组' });
  const excludedSet = getExcludedSet(excludeDirs);
  const result = roots.map(root => {
    const rootPath = resolveRoot(String(root));
    if (!fs.existsSync(rootPath)) return { root, exists: false, docCount: 0, projects: [] };
    const files = [];
    scanKnowledgeFiles(rootPath, rootPath, files, excludedSet);
    const projSet = new Set();
    files.forEach(f => {
      const s = f.rel.split('/');
      projSet.add(s.length === 1 ? path.basename(rootPath) : s[0]);
    });
    return { root, exists: true, docCount: files.length, projects: [...projSet].sort() };
  });
  res.json({ preview: result });
});

// GET /api/knowledge/view - 返回渲染好的 HTML 页面（用于新标签页打开）
// .md 走 Markdown 渲染；.html 直接返回原始文件（保持原样展示）
app.get('/api/knowledge/view', (req, res) => {
  const { root, path: relPath } = req.query;
  const abs = resolveKnowledgePath(root, relPath);
  if (!abs) return res.status(400).send('无效路径');
  try {
    const content = fs.readFileSync(abs, 'utf-8');
    // HTML 文档：原样返回（相对资源请通过 /kbfile/<index>/<path> 访问）
    if (isHtmlDoc(abs)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(content);
      return;
    }
    // Markdown：剥离 YAML frontmatter（避免被 marked 误渲染成标题/正文）
    const mdContent = stripFrontmatter(content);
    // 收集当前 root 下所有文档路径，供前端链接跳转回退查找
    const rootPath = resolveRoot(String(root));
    const allFiles = [];
    scanKnowledgeFiles(rootPath, rootPath, allFiles);
    const fileSet = allFiles.map(f => f.rel);
    const title = titleFromMarkdown(mdContent) || path.basename(relPath);
    // 目录数据（h2~h6）——仅作为服务端标记，实际 TOC 由客户端基于 DOM 构建（slug 规则与 index.html 完全一致）
    const toc = tocFromMarkdown(mdContent);
    // 图片路径重写上下文：渲染前设置，供 renderer.image 把相对路径转成 /kbfile 地址
    const roots = readKnowledgeConfig().roots || [];
    const rootIndex = roots.findIndex(x => resolveRoot(x) === rootPath);
    kbRenderer._kbCtx = { rootIndex: rootIndex === -1 ? 0 : rootIndex, docRelPath: String(relPath) };
    // 目录 nav 占位：客户端 JS 基于渲染后的 DOM 构建嵌套 TOC 并生成锚点 id
    const tocHtml = toc.length ? '<nav class="toc" id="toc-nav"></nav>' : '';
    // 客户端脚本：给 .article 下的标题补锚点 id，构建嵌套目录，点击平滑滚动，滚动高亮
    // slug 规则与 index.html 的 renderToc 完全一致：textContent → [^\w\u4e00-\u9fa5-]+ → '-'，重复加 -2/-3
    const tocJs = toc.length
      ? `;(function(){var art=document.querySelector('.article');if(!art)return;var hs=Array.prototype.slice.call(art.querySelectorAll('h2,h3,h4,h5,h6'));if(!hs.length)return;var counts={};hs.forEach(function(h,i){if(!h.id){var base=(h.textContent||'').trim().replace(/[^\\w\\u4e00-\\u9fa5-]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase()||'section';var n=(counts[base]=(counts[base]||0)+1);h.id=n===1?base:base+'-'+n;}});var nav=document.getElementById('toc-nav');if(!nav)return;var head=document.createElement('div');head.className='toc-header';head.textContent='目录';nav.appendChild(head);var items=hs.map(function(h){var li=document.createElement('li');var a=document.createElement('a');a.href='#'+h.id;a.textContent=h.textContent;a.title=a.textContent;a.addEventListener('click',function(e){e.preventDefault();var id=this.getAttribute('href').slice(1);var th=document.getElementById(id);if(th)th.scrollIntoView({behavior:'smooth',block:'start'})});li.appendChild(a);return{level:parseInt(h.tagName[1],10),li:li}});var root=document.createElement('ul');nav.appendChild(root);var stack=[{level:1,holder:root}];items.forEach(function(it){while(stack.length>1&&it.level<=stack[stack.length-1].level)stack.pop();var top=stack[stack.length-1];if(top.holder.tagName==='UL'){top.holder.appendChild(it.li)}else{var childUl=null;var chs=top.holder.children;for(var ci=0;ci<chs.length;ci++){if(chs[ci].tagName==='UL'){childUl=chs[ci];break}}if(!childUl){childUl=document.createElement('ul');top.holder.appendChild(childUl)}childUl.appendChild(it.li)}stack.push({level:it.level,holder:it.li})});var act=null;function setAct(a){if(act)act.classList.remove('active');act=a;if(act)act.classList.add('active')}if(typeof IntersectionObserver!=='undefined'){var spy=new IntersectionObserver(function(entries){var top=null;entries.forEach(function(en){if(en.isIntersecting&&(!top||en.boundingClientRect.top<top.boundingClientRect.top))top=en});if(top){var a=nav.querySelector('a[href="#'+top.target.id+'"]');if(a)setAct(a)}},{rootMargin:'-80px 0px -70% 0px'});hs.forEach(function(h){spy.observe(h)})}})();`
      : '';
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="stylesheet" href="/vendor/github.min.css" id="hljs-light">
<link rel="stylesheet" href="/vendor/github-dark.min.css" id="hljs-dark" disabled>
<link rel="stylesheet" href="/vendor/katex.min.css">
<script src="/vendor/highlight.min.js"></script>
<script src="/vendor/mermaid.min.js"></script>
<script>try{if(localStorage.getItem('theme')==='dark')document.documentElement.setAttribute('data-theme','dark')}catch(e){}</script>
<style>
body{max-width:1140px;margin:40px auto;padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.6;color:#1f2328}
.layout{display:flex;gap:32px;align-items:flex-start}
.article{flex:1;min-width:0;max-width:860px}
.toc{width:250px;flex-shrink:0;position:sticky;top:16px;max-height:calc(100vh - 32px);overflow-y:auto;font-size:14px}
.toc-header{font-weight:600;margin-bottom:8px}
.toc ul{list-style:none;margin:0;padding:0}
.toc ul ul{padding-left:12px}
.toc li{margin:1px 0}
.toc a{display:block;padding:3px 8px;border-radius:4px;color:#656d76;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toc a:hover{color:#1f2328;background:#f6f8fa}
.toc a.active{color:#0969da;font-weight:600;background:#f6f8fa}
h1,h2,h3,h4,h5,h6{margin-top:24px;margin-bottom:16px;font-weight:600;line-height:1.25;scroll-margin-top:16px}
h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid #d0d7de}
h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid #d0d7de}
h3{font-size:1.25em}
p{margin-bottom:16px}
ul,ol{padding-left:2em;margin-bottom:16px}
li{margin-bottom:4px}
pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:16px;overflow-x:auto}
code{background:#e8ecf0;padding:.2em .4em;border-radius:4px;font-size:85%}
pre code{background:transparent;padding:0}
blockquote{padding:0 16px;color:#656d76;border-left:4px solid #d0d7de;margin:0 0 16px}
table{border-collapse:collapse;width:100%;margin-bottom:16px}
th,td{padding:8px 13px;border:1px solid #d0d7de}
th{background:#f6f8fa;font-weight:600}
img{max-width:100%;border-radius:6px}
a{color:#0969da;text-decoration:none}
a:hover{text-decoration:underline}
hr{border:none;border-top:2px solid #d0d7de;margin:24px 0}
@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}pre{background:#161b22;border-color:#30363d}code{background:#21262d}blockquote{color:#8b949e;border-color:#30363d}th{background:#161b22}}
html[data-theme="light"] body{color:#1f2328;background:#fff}
html[data-theme="light"] pre{background:#f6f8fa;border-color:#d0d7de}
html[data-theme="light"] code{background:#e8ecf0}
html[data-theme="light"] blockquote{color:#656d76;border-color:#d0d7de}
html[data-theme="light"] th{background:#f6f8fa}
html[data-theme="light"] .toc a{color:#656d76}
html[data-theme="light"] .toc a:hover{color:#1f2328;background:#f6f8fa}
html[data-theme="light"] .toc a.active{color:#0969da;background:#f6f8fa}
html[data-theme="light"] h1,html[data-theme="light"] h2{border-bottom-color:#d0d7de}
html[data-theme="light"] hr{border-top-color:#d0d7de}
html[data-theme="light"] a{color:#0969da}
html[data-theme="dark"] body{background:#0d1117;color:#e6edf3}
html[data-theme="dark"] pre{background:#161b22;border-color:#30363d}
html[data-theme="dark"] code{background:#21262d}
html[data-theme="dark"] blockquote{color:#8b949e;border-color:#30363d}
html[data-theme="dark"] th{background:#161b22}
html[data-theme="dark"] .toc a{color:#8b949e}
html[data-theme="dark"] .toc a:hover{color:#e6edf3;background:#161b22}
html[data-theme="dark"] .toc a.active{color:#58a6ff;background:#161b22}
html[data-theme="dark"] h1,html[data-theme="dark"] h2{border-bottom-color:#30363d}
html[data-theme="dark"] hr{border-top-color:#30363d}
html[data-theme="dark"] a{color:#58a6ff}
</style></head><body>
<button id="theme-toggle" onclick="toggleTheme()" title="切换主题" style="position:fixed;top:12px;right:12px;z-index:999;font-size:18px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:4px 10px;cursor:pointer">🌙</button>
<div class="layout">
<div class="article">
${marked.parse(mdContent)}
</div>
${tocHtml}
</div>
<script>var KB_FILES=${JSON.stringify(fileSet)};function norm(s){var p=[];s.split('/').forEach(function(seg){if(seg===''||seg==='.')return;if(seg==='..')p.pop();else p.push(seg)});return p.join('/')}function findTarget(clean,dir){var cands=clean.toLowerCase().indexOf('.md',clean.length-3)!==-1?[clean]:[clean,clean+'.md'];var i,rel,root2;for(i=0;i<cands.length;i++){rel=norm(dir?dir+'/'+cands[i]:cands[i]);if(KB_FILES.indexOf(rel)!==-1)return rel}for(i=0;i<cands.length;i++){root2=norm(cands[i]);if(KB_FILES.indexOf(root2)!==-1)return root2}return null}document.querySelectorAll('pre code').forEach(b=>hljs.highlightElement(b));function kbTheme(){var t;try{t=localStorage.getItem('theme')}catch(e){}return t?t:(window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')}function applyTheme(theme){var dark=theme==='dark';document.documentElement.setAttribute('data-theme',dark?'dark':'light');document.getElementById('theme-toggle').textContent=dark?'☀️':'🌙';var hl=document.getElementById('hljs-light'),hd=document.getElementById('hljs-dark');if(hl&&hd){hl.disabled=dark;hd.disabled=!dark}}function applyMermaid(){if(window.mermaid&&document.querySelector('.mermaid')){mermaid.initialize({startOnLoad:false,theme:kbTheme()==='dark'?'dark':'default',securityLevel:'loose'});try{mermaid.run({nodes:document.querySelectorAll('.mermaid')})}catch(e){}}}function toggleTheme(){var dark=kbTheme()==='dark';var next=dark?'light':'dark';try{localStorage.setItem('theme',next)}catch(e){}applyTheme(next);applyMermaid()}applyTheme(kbTheme());applyMermaid();window.addEventListener('storage',function(e){if(e.key==='theme'){applyTheme(e.newValue==='dark'?'dark':'light');applyMermaid()}});${tocJs}document.body.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(!a)return;var href=a.getAttribute('href');if(!href)return;if(/^(https?:|mailto:|tel:|file:|#)/i.test(href))return;var clean=href.split('#')[0].split('?')[0];if(!clean)return;var params=new URLSearchParams(window.location.search);var rp=params.get('path')||'';var rootEnc=encodeURIComponent(params.get('root')||'');var dir=rp.includes('/')?rp.slice(0,rp.lastIndexOf('/')):'';var finalTarget=findTarget(clean,dir);if(!finalTarget)return;e.preventDefault();window.location.href='/api/knowledge/view?root='+rootEnc+'&path='+encodeURIComponent(finalTarget)})</script>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch { res.status(404).send('文件不存在'); }
});

// GET /api/knowledge/file - 读取单个文档内容
app.get('/api/knowledge/file', (req, res) => {
  const { root, path: relPath } = req.query;
  const abs = resolveKnowledgePath(root, relPath);
  if (!abs) return res.status(400).json({ error: '无效路径' });
  try {
    const content = fs.readFileSync(abs, 'utf-8');
    res.json({ content, title: isHtmlDoc(abs) ? titleFromHtml(content) : titleFromMarkdown(content), relPath, root, kind: isHtmlDoc(abs) ? 'html' : 'md' });
  } catch { res.status(404).json({ error: '文件不存在' }); }
});

// PUT /api/knowledge/file - 写回（编辑）
app.put('/api/knowledge/file', (req, res) => {
  const { root, path: relPath, content } = req.body;
  const abs = resolveKnowledgePath(root, relPath);
  if (!abs) return res.status(400).json({ error: '无效路径' });
  try {
    fs.writeFileSync(abs, content || '', 'utf-8');
    res.json({ message: 'ok' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// /kb/* -- 简洁路径式 API，供 AI 直接 URL 访问知识库
// ============================================================
// 用法：
//   GET /kb                    -> 列出所有文档路径（纯文本，一行一个）
//   GET /kb/<project>          -> 只列出某项目下的文档路径
//   GET /kb/<project>/<path>   -> 返回 .md 原文（text/plain）
// 示例：
//   GET /kb/weldone/README.md
//   GET /kb/weldone/openspec/specs/xxx/spec.md

app.get('/kb', (req, res) => {
  try {
    const roots = discoverKnowledge();
    const lines = [];
    function walkTree(nodes, prefix) {
      for (const n of nodes) {
        const p = prefix ? prefix + '/' + n.name : n.name;
        if (n.type === 'file') lines.push('/kb/' + p);
        else if (n.type === 'dir') walkTree(n.children, p);
      }
    }
    roots.forEach(r => walkTree(r.children, r.name));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(lines.join('\n'));
  } catch (err) { res.status(500).send(err.message); }
});

app.use('/kb/', (req, res, next) => {
  try {
    const rel = decodeURIComponent(req.path).replace(/^\/+/, ''); // 去掉开头斜杠
    if (!rel) { res.status(404).send('需要指定路径: /kb/<project> 或 /kb/<project>/<path>'); return; }
    const slashIdx = rel.indexOf('/');
    if (slashIdx === -1) {
      // /kb/<project> -> 列出该项目下所有文件路径
      const roots = discoverKnowledge();
      const root = roots.find(r => r.name === rel);
      if (!root) { res.status(404).send('项目不存在: ' + rel); return; }
      const lines = [];
      function walk(nodes, prefix) {
        for (const n of nodes) {
          const p = prefix ? prefix + '/' + n.name : n.name;
          if (n.type === 'file') lines.push('/kb/' + root.name + '/' + p);
          else if (n.type === 'dir') walk(n.children, p);
        }
      }
      walk(root.children, '');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(lines.join('\n'));
      return;
    }
    // /kb/<project>/<path...> -> 返回 .md 原文
    const projectName = rel.slice(0, slashIdx);
    const filePath = rel.slice(slashIdx + 1);
    const roots = discoverKnowledge();
    const root = roots.find(r => r.name === projectName);
    if (!root) { res.status(404).send('项目不存在: ' + projectName); return; }
    const abs = resolveKnowledgePath(root.path, filePath);
    if (!abs) { res.status(400).send('无效路径'); return; }
    const content = fs.readFileSync(abs, 'utf-8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch { res.status(404).send('文件不存在'); }
});

// /kbfile/<rootIndex>/<relPath...> - 原样托管知识库文件
// HTML 文档用 iframe 展示时，其内部的相对路径资源（同目录 css/js/图片等）
// 会在浏览器中按 /kbfile/<rootIndex>/<同目录> 解析，保证文档完整可显示。
app.use('/kbfile', (req, res) => {
  // 路径可能含 URL 编码的中文等字符（如 报告.html），必须先解码再解析文件路径
  let rest;
  try { rest = decodeURIComponent(req.path).replace(/^\/+/, ''); } // <rootIndex>/<relPath...>
  catch { return res.status(404).send('文件不存在'); }
  const slashIdx = rest.indexOf('/');
  const rootIdx = parseInt(slashIdx === -1 ? rest : rest.slice(0, slashIdx), 10);
  const relPath = slashIdx === -1 ? '' : rest.slice(slashIdx + 1);
  const config = readKnowledgeConfig();
  const rootCfg = (config.roots || [])[rootIdx];
  if (!rootCfg) return res.status(404).send('未知 root');
  const rootPath = resolveRoot(rootCfg);
  if (!fs.existsSync(rootPath)) return res.status(404).send('root 不存在');
  // 在 root 内解析（不能用 resolveKnowledgePath，它只放行 .md/.html/.htm 文档）
  const abs = path.resolve(rootPath, relPath);
  if (abs !== rootPath && !abs.startsWith(rootPath + path.sep)) return res.status(404).send('路径越界');
  let stat = null;
  try { stat = fs.statSync(abs); } catch {}
  if (!stat || !stat.isFile()) return res.status(404).send('文件不存在');
  const ext = path.extname(abs).toLowerCase();
  if (!KB_STATIC_EXTS.includes(ext)) return res.status(403).send('不允许访问该类型');
  // 注：res.sendFile 在本机 Windows 上对绝对路径解析失败（send 包 Not Found），
  // 直接读文件字节返回，按扩展名设置 Content-Type。
  res.type(ext).send(fs.readFileSync(abs));
});

// HTTP + WebSocket 共享同一端口
const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'connected' }));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

// 使用 chokidar 监听 docs 目录变化
const watcher = chokidar.watch(DOCS_DIR, {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});

watcher.on('all', (event, filePath) => {
  if (!filePath.endsWith('.md')) return;
  const name = path.basename(filePath);
  broadcast({ type: 'file-change', event, name });
});

// 监听教学 workspace 的变化，通过 WebSocket 通知前端刷新课程列表
let teachWatcher = null;
function refreshTeachWatcher() {
  if (teachWatcher) { try { teachWatcher.close(); } catch {} teachWatcher = null; }
  const workspaces = discoverWorkspaces();
  if (workspaces.length === 0) return;
  teachWatcher = chokidar.watch(workspaces.map(ws => ws.path), {
    ignoreInitial: true,
    // 排除构建/依赖目录，避免在大仓库上建立海量监听 handle
    ignored: (p) => {
      if (typeof p !== 'string' || !p) return false;
      return DEFAULT_EXCLUDED.includes(path.basename(p).toLowerCase());
    },
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  teachWatcher.on('all', (event, filePath) => {
    if (!/\.html$|\.css$|\.js$/.test(filePath)) return;
    broadcast({ type: 'course-change', event });
  });
}
refreshTeachWatcher();

// 监听知识库根目录变化
let knowledgeWatcher = null;
function refreshKnowledgeWatcher() {
  if (knowledgeWatcher) { try { knowledgeWatcher.close(); } catch {} knowledgeWatcher = null; }
  const config = readKnowledgeConfig();
  if (!config.roots.length) return;
  const excluded = getExcludedSet();
  knowledgeWatcher = chokidar.watch(config.roots.map(r => resolveRoot(r)), {
    ignored: (p) => {
      if (typeof p !== 'string' || !p) return false;
      const name = path.basename(p).toLowerCase();
      if (excluded.has(name)) return true;
      const norm = path.resolve(p);
      return LOCAL_EXCLUDE_DIRS.some(d => norm === d || norm.startsWith(d + path.sep));
    },
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  knowledgeWatcher.on('all', (event, filePath) => {
    if (!isKnowledgeDoc(filePath)) return;
    broadcast({ type: 'knowledge-change', event });
  });
}
refreshKnowledgeWatcher();

// 端口占用统一处理：HTTP server 与 WebSocketServer 都可能 emit 'error'。
// 关键：new WebSocketServer({ server }) 会让端口冲突错误从 wss 实例 emit，
// 只给 server 注册 error handler 收不到，必须 wss 也注册，否则 Unhandled error 崩溃。
function handleListenError(err) {
  if (err && err.code === 'EADDRINUSE') {
    // 端口未释放（通常是 PM2 超内存重启的竞态）：退出码 1 让 PM2 按 restart_delay 重试
    console.error(`端口 ${PORT} 被占用，PM2 将在 restart_delay 后重试...`);
    process.exit(1);
  }
  throw err;
}
server.on('error', handleListenError);
wss.on('error', handleListenError);

// 局域网 IPv4 地址（排除回环 / 内部网卡）：横幅直接给出手机浏览器可输入的地址
function lanIPv4Addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// 启动横幅（ADR-0003 落地）：打印实际监听地址；非回环监听必须明示局域网读写风险
function printStartupBanner(host, port) {
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  console.log(`Markdown 查看器已启动，监听 ${host}:${port}`);
  const urls = loopback
    ? [host === '::1' ? `http://[::1]:${port}` : `http://127.0.0.1:${port}`]
    : [`http://localhost:${port}`, ...lanIPv4Addresses().map(ip => `http://${ip}:${port}`)];
  for (const u of urls) console.log(`  访问地址: ${u}`);
  if (loopback) {
    console.log(`  host 已收敛到 ${host}，仅本机可访问`);
  } else {
    console.log(`  ⚠ 安全提示: 局域网内设备可读写所配置目录，请勿在不可信网络环境运行`);
    console.log(`  （如需仅本机访问，可在数据目录 settings.json 中设置 host: 127.0.0.1）`);
  }
}

server.listen(PORT, HOST, () => {
  printStartupBanner(HOST, PORT);
  console.log(`数据目录: ${DATA_DIR}`);
});

// 优雅关闭：收到信号时关闭所有监听器与连接，确保 TCP 端口及时释放
// 修复 PM2 超内存重启时旧进程端口未释放 → 新进程 EADDRINUSE → 连续崩溃被放弃的问题
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在优雅关闭...`);
  try { watcher && watcher.close(); } catch {}
  try { teachWatcher && teachWatcher.close(); } catch {}
  try { knowledgeWatcher && knowledgeWatcher.close(); } catch {}
  try { wss.close(); } catch {}
  server.close(() => process.exit(0));
  // 兜底：3 秒后强制退出，避免 server.close 卡住导致端口不释放
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
