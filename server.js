const express = require('express');
const path = require('path');
const fs = require('fs');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');

const app = express();
const PORT = 8080;
const DOCS_DIR = path.join(__dirname, 'docs');
const METADATA_FILE = path.join(DOCS_DIR, '.metadata.json');

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

    res.json({ groups, files });
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

server.listen(PORT, () => {
  console.log(`Markdown 查看器已启动: http://localhost:${PORT}`);
  console.log(`文档目录: ${DOCS_DIR}`);
});
