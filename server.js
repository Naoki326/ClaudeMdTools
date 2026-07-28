const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const marked = require('marked');

// marked 渲染器：mermaid 代码块输出为 <div class="mermaid">，供前端 mermaid.js 渲染
{
  const r = new marked.Renderer();
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
  marked.use({ renderer: r });
}

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8080;
const DOCS_DIR = path.join(__dirname, 'docs');
const METADATA_FILE = path.join(DOCS_DIR, '.metadata.json');
const TEACH_CONFIG_FILE = path.join(__dirname, 'teach.config.json');

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
//      ../ClaudeMdTools/notes/x.md   -> ClaudeMdTools
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

// 启动时自动创建 docs 目录
if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// 元数据读写
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
      workspaces.push({ id, name: entry.name, path: wsPath });
    }
  }
  return workspaces;
}

// 从 HTML 内容提取 <title>
function titleFromHtml(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? m[1].trim() : null;
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
  res.sendFile(filePath, err => {
    if (err && !res.headersSent) res.status(404).send('文件不存在');
  });
});

// ============================================================
// 知识库 -- 直接读取外部文件夹的 .md 文档（不复制）
// ============================================================
// 和课程视图对称：配置根目录 -> 递归扫描 .md -> 按项目分组展示
// 文件保持原位读取/编辑，不复制进 docs/

const KNOWLEDGE_CONFIG_FILE = path.join(__dirname, 'knowledge.config.json');

// 内置默认排除的目录名（小写匹配）
// 注意：'docs' 不在默认列表中 -- 大多数项目的 docs/ 里有有价值的文档。
// 如需排除特定目录，通过 knowledge.config.json 的 excludeDirs 配置。
// ClaudeMdTools 自身的 docs/ 通过 LOCAL_EXCLUDE_DIRS 按绝对路径排除，避免误伤其他项目。
const DEFAULT_EXCLUDED = [
  'node_modules', '.git', '.svn', 'bin', 'obj', 'dist', 'build',
  '.next', 'coverage', '__pycache__', '.venv', 'venv', '.idea',
  'target', 'out', 'logs', '.cache', '.vs', 'packages',
  '.vscode', '.claude', '.husky', '.turbo', '.gradle',
];

// 按绝对路径排除的目录（只针对本工具自身的 docs/，防止管理文档在知识库视图中重复）
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

// 递归扫描目录下所有 .md 文件（排除常见无关目录）
function scanMarkdownFiles(dir, base, acc, excludedSet) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (isExcluded(full, e.name, excludedSet)) continue;
      scanMarkdownFiles(full, base, acc, excludedSet);
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      acc.push({ abs: full, rel: path.relative(base, full).replace(/\\/g, '/') });
    }
  }
}

// 扫描目录构建树：只保留含 .md 的分支（空文件夹自动隐藏）
// 返回 children 数组，每个节点是 { type:'dir', name, children } 或 { type:'file', name, title, mtime }
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
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      let title = null;
      try {
        const content = fs.readFileSync(full, 'utf-8');
        title = titleFromMarkdown(content) || e.name.replace(/\.md$/i, '');
      } catch { title = e.name.replace(/\.md$/i, ''); }
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch {}
      children.push({ type: 'file', name: e.name, title, mtime });
    }
  }
  return children;
}

// 发现知识库内容：以配置的 root 为顶层，下面是完整目录树
function discoverKnowledge() {
  const config = readKnowledgeConfig();
  const excludedSet = getExcludedSet();
  const roots = [];
  for (const root of config.roots || []) {
    const rootPath = resolveRoot(root);
    if (!fs.existsSync(rootPath)) continue;
    const children = scanTree(rootPath, rootPath, excludedSet);
    if (children.length > 0) {
      roots.push({ name: path.basename(rootPath), path: rootPath.replace(/\\/g, '/'), children });
    }
  }
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
  if (!abs.toLowerCase().endsWith('.md')) return null;
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

// POST /api/knowledge/preview - 预览每个 root 发现的 .md 数量和项目
app.post('/api/knowledge/preview', (req, res) => {
  const { roots, excludeDirs } = req.body;
  if (!Array.isArray(roots)) return res.status(400).json({ error: 'roots 必须是字符串数组' });
  const excludedSet = getExcludedSet(excludeDirs);
  const result = roots.map(root => {
    const rootPath = resolveRoot(String(root));
    if (!fs.existsSync(rootPath)) return { root, exists: false, mdCount: 0, projects: [] };
    const files = [];
    scanMarkdownFiles(rootPath, rootPath, files, excludedSet);
    const projSet = new Set();
    files.forEach(f => {
      const s = f.rel.split('/');
      projSet.add(s.length === 1 ? path.basename(rootPath) : s[0]);
    });
    return { root, exists: true, mdCount: files.length, projects: [...projSet].sort() };
  });
  res.json({ preview: result });
});

// GET /api/knowledge/view - 返回渲染好的 HTML 页面（用于新标签页打开）
app.get('/api/knowledge/view', (req, res) => {
  const { root, path: relPath } = req.query;
  const abs = resolveKnowledgePath(root, relPath);
  if (!abs) return res.status(400).send('无效路径');
  try {
    const content = fs.readFileSync(abs, 'utf-8');
    // 收集当前 root 下所有 .md 文件路径，供前端链接跳转回退查找
    const rootPath = resolveRoot(String(root));
    const allFiles = [];
    scanMarkdownFiles(rootPath, rootPath, allFiles);
    const fileSet = allFiles.map(f => f.rel);
    const title = titleFromMarkdown(content) || path.basename(relPath);
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.12.0/mermaid.min.js"></script>
<style>
body{max-width:860px;margin:40px auto;padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.6;color:#1f2328}
pre{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:16px;overflow-x:auto}
code{background:#e8ecf0;padding:.2em .4em;border-radius:4px;font-size:85%}
pre code{background:transparent;padding:0}
blockquote{padding:0 16px;color:#656d76;border-left:4px solid #d0d7de;margin:0 0 16px}
table{border-collapse:collapse;width:100%}
th,td{padding:8px 13px;border:1px solid #d0d7de}
th{background:#f6f8fa;font-weight:600}
img{max-width:100%}
@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}pre{background:#161b22;border-color:#30363d}code{background:#21262d}blockquote{color:#8b949e;border-color:#30363d}th{background:#161b22}}
</style></head><body>
${marked.parse(content)}
<script>var KB_FILES=${JSON.stringify(fileSet)};function norm(s){var p=[];s.split('/').forEach(function(seg){if(seg===''||seg==='.')return;if(seg==='..')p.pop();else p.push(seg)});return p.join('/')}function findTarget(clean,dir){var cands=clean.toLowerCase().indexOf('.md',clean.length-3)!==-1?[clean]:[clean,clean+'.md'];var i,rel,root2;for(i=0;i<cands.length;i++){rel=norm(dir?dir+'/'+cands[i]:cands[i]);if(KB_FILES.indexOf(rel)!==-1)return rel}for(i=0;i<cands.length;i++){root2=norm(cands[i]);if(KB_FILES.indexOf(root2)!==-1)return root2}return null}document.querySelectorAll('pre code').forEach(b=>hljs.highlightElement(b));if(window.mermaid&&document.querySelector('.mermaid')){mermaid.initialize({startOnLoad:false,theme:window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'default',securityLevel:'loose'});try{mermaid.run({nodes:document.querySelectorAll('.mermaid')})}catch(e){}}document.body.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(!a)return;var href=a.getAttribute('href');if(!href)return;if(/^(https?:|mailto:|tel:|file:|#)/i.test(href))return;var clean=href.split('#')[0].split('?')[0];if(!clean)return;var params=new URLSearchParams(window.location.search);var rp=params.get('path')||'';var rootEnc=encodeURIComponent(params.get('root')||'');var dir=rp.includes('/')?rp.slice(0,rp.lastIndexOf('/')):'';var finalTarget=findTarget(clean,dir);if(!finalTarget)return;e.preventDefault();window.location.href='/api/knowledge/view?root='+rootEnc+'&path='+encodeURIComponent(finalTarget)})</script>
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
    res.json({ content, title: titleFromMarkdown(content), relPath, root });
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
    if (!filePath.toLowerCase().endsWith('.md')) return;
    broadcast({ type: 'knowledge-change', event });
  });
}
refreshKnowledgeWatcher();

server.listen(PORT, () => {
  console.log(`Markdown 查看器已启动: http://localhost:${PORT}`);
  console.log(`文档目录: ${DOCS_DIR}`);
});
