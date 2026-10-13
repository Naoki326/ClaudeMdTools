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
const { PORT_CONFLICT_EXIT_CODE, EADDRINUSE_MAX_RETRIES, EADDRINUSE_RETRY_DELAY_MS } = require('./lib/exit-codes');
const { createKnowledgeService, KB_STATIC_EXTS } = require('./lib/knowledge');

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
// CWD 钉到数据目录：服务是常驻进程，会一直持有启动时继承的 CWD——Windows 上
// 那个目录从此无法 rename/delete（2026-10 实测锁死过 pi-web 的安装目录）。服务
// 全部路径本来就是绝对路径（数据目录 + __dirname），chdir 零行为变化，只解除
// 对启动者目录的占用；也是所有拉起路径（守护脚本 cd /d / spawn cwd）之外的最终兜底。
process.chdir(DATA_DIR);

// 服务配置（ADR-0003 / CONTEXT.md「服务配置」）：数据目录 settings.json 的
// port / host。生效优先级：PORT 环境变量 > settings > 内置默认 8080 / 0.0.0.0；
// 改动重启后生效（环境变量注入的 PORT 依然优先生效）。
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

// 递归发现教学 workspace 的最大深度（防止异常深的目录树拖垮扫描）
const WORKSPACE_MAX_DEPTH = 8;

// 递归多层扫描 rootPath，返回所有含 lessons/ 子目录的教学 workspace 目录（绝对路径）。
// 与知识库的递归扫描对称：workspace 可以嵌套在任意深度的子目录中，不能只扫一层。
// 规则：
// - 命中含 lessons/ 的目录即登记为 workspace，且不再深入其内部
//   （workspace 由 /teach 生成、结构固定：lessons/ reference/ assets/，
//   内部不会嵌套独立 workspace；不深入可跳过 lessons 内大量文件的遍历）
// - 未命中则继续逐层深入
// - 排除 node_modules / .git 等常见无关目录（复用知识库排除集合）
function findWorkspaceDirs(rootPath, excludedSet) {
  const found = [];
  const excluded = excludedSet || knowledge.getExcludedSet();
  (function walk(dir, depth) {
    if (depth > WORKSPACE_MAX_DEPTH) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (knowledge.isExcluded(path.join(dir, e.name), e.name, excluded)) continue;
      const full = path.join(dir, e.name);
      if (fs.existsSync(path.join(full, 'lessons'))) {
        found.push(full);
      } else {
        walk(full, depth + 1);
      }
    }
  })(rootPath, 1);
  return found;
}

// 扫描配置的 roots，发现所有教学 workspace（任意深度下含 lessons/ 目录的文件夹）
function discoverWorkspaces() {
  const config = readTeachConfig();
  const workspaces = [];
  const usedIds = new Set();
  for (const root of config.roots || []) {
    const rootPath = resolveRoot(root);
    if (!fs.existsSync(rootPath)) continue;
    for (const wsPath of findWorkspaceDirs(rootPath)) {
      const name = path.basename(wsPath);
      // 生成唯一 id（优先用目录名，重名时加序号后缀）
      let id = name;
      let n = 2;
      while (usedIds.has(id)) { id = `${name}-${n++}`; }
      usedIds.add(id);
      // 标题优先取 MISSION.md 的 "# Mission: xxx"，没有则回退文件夹名
      workspaces.push({ id, name, title: titleFromMission(wsPath) || name, path: wsPath });
    }
  }
  return workspaces;
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

// 递归收集 kind 目录（lessons/ 或 reference/）下的课程 HTML 文件，
// 子目录也要深入（如 lessons/module-1/0002-xxx.html），不能只扫一层。
// file 字段为相对 kind 目录的 POSIX 相对路径（可含子目录），前端据此拼
// /teach/<workspaceId>/<kind>/<file>，静态路由按多层路径解析。
function collectCourseHtml(dir, base, acc) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      collectCourseHtml(full, base, acc);
    } else if (e.isFile() && /\.html$/i.test(e.name)) {
      try {
        const stat = fs.statSync(full);
        const content = fs.readFileSync(full, 'utf-8');
        acc.push({
          file: path.relative(base, full).replace(/\\/g, '/'),
          title: knowledge.titleFromHtml(content) || e.name.replace(/\.html$/i, ''),
          mtime: stat.mtimeMs,
        });
      } catch {}
    }
  }
}

// 列出某个 workspace 下的课程与速查卡
function getWorkspaceContent(wsPath) {
  const result = { lessons: [], reference: [] };
  for (const kind of ['lessons', 'reference']) {
    const dir = path.join(wsPath, kind);
    if (!fs.existsSync(dir)) continue;
    collectCourseHtml(dir, dir, result[kind]);
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
    // 递归多层发现；元素用相对根目录的路径（含中间层），嵌套/同名工作区可区分
    const wss = findWorkspaceDirs(rootPath)
      .map(p => path.relative(rootPath, p).replace(/\\/g, '/'));
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
//
// 扫描 / 树缓存 / 监听 / 失效的实现收敛在 lib/knowledge.js（树数据的唯一
// 真相），下面的路由 handler 只做委托。

const knowledge = createKnowledgeService({
  dataDir: DATA_DIR,
  baseDir: __dirname,
  resolveRoot,
  onKnowledgeChange: event => broadcast(event),
});

// GET /api/knowledge - 列出知识库文档（树形结构：root 顶层 + 目录树）
// discover 命中树级缓存直接回快照；未命中时 single-flight 异步重建（工单 #6）
app.get('/api/knowledge', async (req, res) => {
  try { res.json({ roots: await knowledge.discover() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET/POST /api/knowledge/config - 读取/更新知识库根目录配置
app.get('/api/knowledge/config', (req, res) => {
  res.json(knowledge.readConfig());
});
app.post('/api/knowledge/config', (req, res) => {
  const { roots, excludeDirs } = req.body;
  if (!Array.isArray(roots)) return res.status(400).json({ error: 'roots 必须是字符串数组' });
  const config = { roots: roots.map(String) };
  if (Array.isArray(excludeDirs)) {
    config.excludeDirs = excludeDirs.map(String).filter(Boolean);
  }
  knowledge.writeConfig(config);
  knowledge.refreshWatcher();
  // 树级缓存跟随配置（工单 #6）：立即失效 + 后台重建，改配置无需重启即生效
  knowledge.refreshTreeCache();
  res.json({ message: 'ok' });
});

// POST /api/knowledge/preview - 预览每个 root 发现的文档（.md/.html）数量和项目
app.post('/api/knowledge/preview', (req, res) => {
  const { roots, excludeDirs } = req.body;
  if (!Array.isArray(roots)) return res.status(400).json({ error: 'roots 必须是字符串数组' });
  const excludedSet = knowledge.getExcludedSet(excludeDirs);
  const result = roots.map(root => {
    const rootPath = resolveRoot(String(root));
    if (!fs.existsSync(rootPath)) return { root, exists: false, docCount: 0, projects: [] };
    const files = [];
    knowledge.scanKnowledgeFiles(rootPath, rootPath, files, excludedSet);
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
  const abs = knowledge.resolvePath(root, relPath);
  if (!abs) return res.status(400).send('无效路径');
  try {
    const content = fs.readFileSync(abs, 'utf-8');
    // HTML 文档：原样返回（相对资源请通过 /kbfile/<index>/<path> 访问）
    if (knowledge.isHtmlDoc(abs)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(content);
      return;
    }
    // Markdown：剥离 YAML frontmatter（避免被 marked 误渲染成标题/正文）
    const mdContent = knowledge.stripFrontmatter(content);
    // 收集当前 root 下所有文档路径，供前端链接跳转回退查找
    const rootPath = resolveRoot(String(root));
    const allFiles = [];
    knowledge.scanKnowledgeFiles(rootPath, rootPath, allFiles);
    const fileSet = allFiles.map(f => f.rel);
    const title = knowledge.titleFromMarkdown(mdContent) || path.basename(relPath);
    // 目录数据（h2~h6）——仅作为服务端标记，实际 TOC 由客户端基于 DOM 构建（slug 规则与 index.html 完全一致）
    const toc = knowledge.tocFromMarkdown(mdContent);
    // 图片路径重写上下文：渲染前设置，供 renderer.image 把相对路径转成 /kbfile 地址
    const roots = knowledge.readConfig().roots || [];
    const rootIndex = roots.findIndex(x => resolveRoot(x) === rootPath);
    kbRenderer._kbCtx = { rootIndex: rootIndex === -1 ? 0 : rootIndex, docRelPath: String(relPath) };
    // 目录 nav 占位：客户端 JS 基于渲染后的 DOM 构建嵌套 TOC 并生成锚点 id
    const tocHtml = toc.length ? '<nav class="toc" id="toc-nav"></nav>' : '';
    // 客户端脚本：给 .article 下的标题补锚点 id，构建嵌套目录，点击平滑滚动，滚动高亮
    // slug 规则与 index.html 的 renderToc 完全一致：textContent → [^\w\u4e00-\u9fa5-]+ → '-'，重复加 -2/-3
    const tocJs = toc.length
      ? `;(function(){var art=document.querySelector('.article');if(!art)return;var hs=Array.prototype.slice.call(art.querySelectorAll('h2,h3,h4,h5,h6'));if(!hs.length)return;var counts={};hs.forEach(function(h,i){if(!h.id){var base=(h.textContent||'').trim().replace(/[^\\w\\u4e00-\\u9fa5-]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase()||'section';var n=(counts[base]=(counts[base]||0)+1);h.id=n===1?base:base+'-'+n;}});var nav=document.getElementById('toc-nav');if(!nav)return;var head=document.createElement('div');head.className='toc-header';head.textContent='目录';nav.appendChild(head);var items=hs.map(function(h){var li=document.createElement('li');var a=document.createElement('a');a.href='#'+h.id;var sp=document.createElement('span');sp.textContent=h.textContent;a.appendChild(sp);a.title=h.textContent;a.addEventListener('click',function(e){e.preventDefault();var id=this.getAttribute('href').slice(1);var th=document.getElementById(id);if(th)th.scrollIntoView({behavior:'smooth',block:'start'});if(window.__tocClose)window.__tocClose()});li.appendChild(a);return{level:parseInt(h.tagName[1],10),li:li}});var root=document.createElement('ul');nav.appendChild(root);var stack=[{level:1,holder:root}];items.forEach(function(it){while(stack.length>1&&it.level<=stack[stack.length-1].level)stack.pop();var top=stack[stack.length-1];if(top.holder.tagName==='UL'){top.holder.appendChild(it.li)}else{var childUl=null;var chs=top.holder.children;for(var ci=0;ci<chs.length;ci++){if(chs[ci].tagName==='UL'){childUl=chs[ci];break}}if(!childUl){childUl=document.createElement('ul');top.holder.appendChild(childUl)}childUl.appendChild(it.li)}stack.push({level:it.level,holder:it.li})});var act=null;function setAct(a){if(act)act.classList.remove('active');act=a;if(act)act.classList.add('active')}if(typeof IntersectionObserver!=='undefined'){var spy=new IntersectionObserver(function(entries){var top=null;entries.forEach(function(en){if(en.isIntersecting&&(!top||en.boundingClientRect.top<top.boundingClientRect.top))top=en});if(top){var a=nav.querySelector('a[href="#'+top.target.id+'"]');if(a)setAct(a)}},{rootMargin:'-80px 0px -70% 0px'});hs.forEach(function(h){spy.observe(h)})}})();`
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
.toc.hidden{display:none}
.toc-toggle{position:fixed;top:12px;right:64px;z-index:999;font-size:14px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:5px 10px;cursor:pointer;color:#1f2328}
.toc-mask{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:1000}
.toc-mask.open{display:block}
@media(max-width:900px){.toc{position:fixed;top:0;left:0;bottom:0;width:min(300px,85vw);max-height:none;margin:0;background:#fff;z-index:1001;padding:16px 12px;box-sizing:border-box;box-shadow:4px 0 24px rgba(0,0,0,.25)}}
.toc-header{font-weight:600;margin-bottom:8px}
.toc ul{list-style:none;margin:0;padding:0}
.toc ul ul{padding-left:12px}
.toc li{margin:1px 0}
.toc a{display:block;padding:3px 8px;border-radius:4px;color:#656d76;text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;container-type:inline-size}
/* 选中项滚动显示全文：文字包 span，溢出时 alternate 往返平移（cqw 相对条目宽度，不溢出时位移为 0） */
.toc a span{display:inline-block}
.toc a.active{text-overflow:clip}
.toc a.active span{animation:toc-marquee 9s ease-in-out infinite alternate}
@keyframes toc-marquee{from{transform:translateX(0)}to{transform:translateX(min(0px,calc(100cqw - 100%)))}}
.toc a:hover{color:#1f2328;background:#f6f8fa}
.toc a.active{color:#0969da;font-weight:600;background:#f6f8fa}
h1,h2,h3,h4,h5,h6{margin-top:24px;margin-bottom:16px;font-weight:600;line-height:1.25;scroll-margin-top:16px}
/* 标题单行：超宽折叠为省略号，行内可横向滑动查看全文（隐藏滚动条） */
h1,h2,h3,h4,h5,h6{white-space:nowrap;overflow-x:auto;text-overflow:ellipsis;scrollbar-width:none}
h1::-webkit-scrollbar,h2::-webkit-scrollbar,h3::-webkit-scrollbar,h4::-webkit-scrollbar,h5::-webkit-scrollbar,h6::-webkit-scrollbar{display:none}
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
@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}pre{background:#161b22;border-color:#30363d}code{background:#21262d}blockquote{color:#8b949e;border-color:#30363d}th{background:#161b22}.toc{background:#0d1117}}
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
html[data-theme="dark"] .toc{background:#0d1117}
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
${toc.length ? '<button id="toc-toggle" class="toc-toggle" onclick="toggleToc()" title="显示/隐藏目录">📑 目录</button><div class="toc-mask" id="toc-mask"></div>' : ''}
<div class="layout">
<div class="article">
${marked.parse(mdContent)}
</div>
${tocHtml}
</div>
<script>var KB_FILES=${JSON.stringify(fileSet)};function norm(s){var p=[];s.split('/').forEach(function(seg){if(seg===''||seg==='.')return;if(seg==='..')p.pop();else p.push(seg)});return p.join('/')}function findTarget(clean,dir){var cands=clean.toLowerCase().indexOf('.md',clean.length-3)!==-1?[clean]:[clean,clean+'.md'];var i,rel,root2;for(i=0;i<cands.length;i++){rel=norm(dir?dir+'/'+cands[i]:cands[i]);if(KB_FILES.indexOf(rel)!==-1)return rel}for(i=0;i<cands.length;i++){root2=norm(cands[i]);if(KB_FILES.indexOf(root2)!==-1)return root2}return null}document.querySelectorAll('pre code').forEach(b=>hljs.highlightElement(b));function kbTheme(){var t;try{t=localStorage.getItem('theme')}catch(e){}return t?t:(window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light')}function applyTheme(theme){var dark=theme==='dark';document.documentElement.setAttribute('data-theme',dark?'dark':'light');document.getElementById('theme-toggle').textContent=dark?'☀️':'🌙';var hl=document.getElementById('hljs-light'),hd=document.getElementById('hljs-dark');if(hl&&hd){hl.disabled=dark;hd.disabled=!dark}}function applyMermaid(){if(window.mermaid&&document.querySelector('.mermaid')){mermaid.initialize({startOnLoad:false,theme:kbTheme()==='dark'?'dark':'default',securityLevel:'loose'});try{mermaid.run({nodes:document.querySelectorAll('.mermaid')})}catch(e){}}}function toggleTheme(){var dark=kbTheme()==='dark';var next=dark?'light':'dark';try{localStorage.setItem('theme',next)}catch(e){}applyTheme(next);applyMermaid()}applyTheme(kbTheme());applyMermaid();window.addEventListener('storage',function(e){if(e.key==='theme'){applyTheme(e.newValue==='dark'?'dark':'light');applyMermaid()}});var tocPane=document.getElementById('toc-nav'),tocMask=document.getElementById('toc-mask');var tocMq=window.matchMedia?window.matchMedia('(min-width:901px)'):null;var tocWide=function(){return !tocMq||tocMq.matches};var tocOpen=false;try{tocOpen=!!tocPane&&localStorage.getItem('toc-visible')==='1'&&tocWide()}catch(e){}function tocApply(){if(!tocPane)return;tocPane.classList.toggle('hidden',!tocOpen);if(tocMask)tocMask.classList.toggle('open',tocOpen&&!tocWide())}function toggleToc(){if(!tocPane)return;tocOpen=!tocOpen;try{localStorage.setItem('toc-visible',tocOpen?'1':'')}catch(e){}tocApply()}window.__tocClose=function(){if(tocOpen&&!tocWide()){tocOpen=false;tocApply()}};tocApply();if(tocMask)tocMask.onclick=window.__tocClose;if(tocMq&&tocMq.addEventListener)tocMq.addEventListener('change',function(){tocApply()});${tocJs}document.body.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a');if(!a)return;var href=a.getAttribute('href');if(!href)return;if(/^(https?:|mailto:|tel:|file:|#)/i.test(href))return;var clean=href.split('#')[0].split('?')[0];if(!clean)return;var params=new URLSearchParams(window.location.search);var rp=params.get('path')||'';var rootEnc=encodeURIComponent(params.get('root')||'');var dir=rp.includes('/')?rp.slice(0,rp.lastIndexOf('/')):'';var finalTarget=findTarget(clean,dir);if(!finalTarget)return;e.preventDefault();window.location.href='/api/knowledge/view?root='+rootEnc+'&path='+encodeURIComponent(finalTarget)})</script>
</body></html>`;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch { res.status(404).send('文件不存在'); }
});

// GET /api/knowledge/file - 读取单个文档内容
app.get('/api/knowledge/file', (req, res) => {
  const { root, path: relPath } = req.query;
  const abs = knowledge.resolvePath(root, relPath);
  if (!abs) return res.status(400).json({ error: '无效路径' });
  try {
    const content = fs.readFileSync(abs, 'utf-8');
    res.json({ content, title: knowledge.isHtmlDoc(abs) ? knowledge.titleFromHtml(content) : knowledge.titleFromMarkdown(content), relPath, root, kind: knowledge.isHtmlDoc(abs) ? 'html' : 'md' });
  } catch { res.status(404).json({ error: '文件不存在' }); }
});

// PUT /api/knowledge/file - 写回（编辑）
app.put('/api/knowledge/file', (req, res) => {
  const { root, path: relPath, content } = req.body;
  const abs = knowledge.resolvePath(root, relPath);
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

app.get('/kb', async (req, res) => {
  try {
    const roots = await knowledge.discover();
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

app.use('/kb/', async (req, res, next) => {
  try {
    const rel = decodeURIComponent(req.path).replace(/^\/+/, ''); // 去掉开头斜杠
    if (!rel) { res.status(404).send('需要指定路径: /kb/<project> 或 /kb/<project>/<path>'); return; }
    const slashIdx = rel.indexOf('/');
    if (slashIdx === -1) {
      // /kb/<project> -> 列出该项目下所有文件路径
      const roots = await knowledge.discover();
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
    const roots = await knowledge.discover();
    const root = roots.find(r => r.name === projectName);
    if (!root) { res.status(404).send('项目不存在: ' + projectName); return; }
    const abs = knowledge.resolvePath(root.path, filePath);
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
  const config = knowledge.readConfig();
  const rootCfg = (config.roots || [])[rootIdx];
  if (!rootCfg) return res.status(404).send('未知 root');
  const rootPath = resolveRoot(rootCfg);
  if (!fs.existsSync(rootPath)) return res.status(404).send('root 不存在');
  // 在 root 内解析（不能用 knowledge.resolvePath，它只放行 .md/.html/.htm 文档）
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

// watcher 统一健壮性（ignored 规则 / error 兜底）实现在 lib/knowledge.js，
// docs / teach / knowledge 三个 watcher 共用同一套策略。
// 使用 chokidar 监听 docs 目录变化
const watcher = chokidar.watch(DOCS_DIR, {
  ignoreInitial: true,
  // docs 目录也要排除瞬态文件
  ignored: (p) => knowledge.isWatcherIgnored(p, null),
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});

watcher.on('error', (err) => knowledge.onWatcherError('docs', err));

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
    // 排除构建/依赖目录与瞬态文件，避免海量监听 handle 和 EPERM
    ignored: (p) => knowledge.isWatcherIgnored(p, null),
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  teachWatcher.on('error', (err) => knowledge.onWatcherError('teach', err));
  teachWatcher.on('all', (event, filePath) => {
    if (!/\.html$|\.css$|\.js$/.test(filePath)) return;
    broadcast({ type: 'course-change', event });
  });
}
refreshTeachWatcher();

// 监听知识库根目录变化（扫描 / 监听 / 失效逻辑在 lib/knowledge.js，此处只接线）
knowledge.refreshWatcher();

// 端口占用统一处理：HTTP server 与 WebSocketServer 都可能 emit 'error'。
// 关键：new WebSocketServer({ server }) 会让端口冲突错误从 wss 实例 emit，
// 只给 server 注册 error handler 收不到，必须 wss 也注册，否则 Unhandled error 崩溃。
//
// EADDRINUSE 容忍（工单 #4，退出码契约见 lib/exit-codes.js 与 ADR-0005 修订）：
// 先做有界重试（3 次、间隔 ~1s）——给「前一个实例正在优雅关闭、端口即将释放」
// 的竞态一个自愈窗口（重试期间端口释放则直接接管，守护不用再介入）；耗尽后
// 打印既有冲突文案并以约定退出码退出，守护据此区分「端口冲突」（失败退避）
// 与「正常运行过之后的退出」（基线重启）。其它错误照旧抛出。
let eaddrinuseRetries = 0;
let eaddrinuseRetryPending = false;
function handleListenError(err) {
  if (err && err.code === 'EADDRINUSE') {
    // server 与 wss 会对同一次 listen 失败各 emit 一次：只让第一处进入重试，
    // 否则一次冲突被两个 handler 放大成两轮重试
    if (eaddrinuseRetryPending) return;
    eaddrinuseRetryPending = true;
    if (eaddrinuseRetries < EADDRINUSE_MAX_RETRIES) {
      eaddrinuseRetries++;
      setTimeout(() => {
        eaddrinuseRetryPending = false;
        startListening();
      }, EADDRINUSE_RETRY_DELAY_MS);
      return;
    }
    // 重试耗尽：既有文案一次 + 约定退出码（守护的失败退避依据）
    console.error(`端口 ${PORT} 被占用，请确认是否已有 lanbook 在运行（lanbook stop 可停止）`);
    process.exit(PORT_CONFLICT_EXIT_CODE);
  }
  throw err;
}
function startListening() {
  server.listen(PORT, HOST, () => {
    eaddrinuseRetries = 0; // 成功监听后重置：后续冲突从全新的一轮重试开始
    printStartupBanner(HOST, PORT);
    console.log(`数据目录: ${DATA_DIR}`);
  });
}
server.on('error', handleListenError);
wss.on('error', handleListenError);
startListening();

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

// listen 启动统一走 startListening()（错误处理一节）：EADDRINUSE 重试时需要
// 用同一组参数与启动回调重新 listen

// 优雅关闭：收到信号时关闭所有监听器与连接，确保 TCP 端口及时释放
// （旧进程退净再退出，避免下次启动 EADDRINUSE）
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在优雅关闭...`);
  try { watcher && watcher.close(); } catch {}
  try { teachWatcher && teachWatcher.close(); } catch {}
  try { knowledge.close(); } catch {}
  try { wss.close(); } catch {}
  server.close(() => process.exit(0));
  // 兜底：3 秒后强制退出，避免 server.close 卡住导致端口不释放
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
