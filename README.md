# ClaudeMd Tools - 知识库 & 课程查看器

一个本地 Web 应用，把散落在各项目文件夹里的 Markdown 文档和 HTML 课程**统一查看、分类、编辑**。直接读取原始文件，不复制、不移动；文件一改，网页实时刷新。

## 它解决什么问题

日常开发中，`.md` 笔记散落在各个项目目录里，HTML 课程（由 `/teach` 等生成）也在各自的 workspace 下。想集中查看它们很麻烦——要么逐个打开文件，要么手动复制到一处。

这个工具的做法：**你告诉它去哪些目录找，它负责扫描、分类、展示**。文件保持原位，改了就实时反映。

## 两个视图

### 📚 知识库（Markdown / HTML 文档）

- 配置若干**根目录**（如 `C:/Work`），可选配置**排除目录名**（如 `docs`、`vendor`）
- server 递归扫描这些目录下的 `.md` / `.html` / `.htm` 文档（默认排除 `node_modules`、`.git`、`bin`、`obj` 等；可在配置中追加自定义排除目录）
- 以配置的根目录为顶层，按**树形目录结构**展示，空文件夹自动隐藏；HTML 文件带 🌐 图标，标题自动取 `<title>` 或首个 `<h1>`
- 多层折叠：根目录 / 子目录 / 文件，每层可独立展开收起，默认折叠
- 点击 `.md` 在右侧渲染 Markdown；点击 `.html` 用 **iframe 原样展示**（同目录 css/js/图片等相对资源正常解析），均支持**在线编辑**（保存写回原始文件）
- 支持**新窗口打开**（Markdown 渲染页 / HTML 原样页）
- **Mermaid 图表**渲染（`graph` / `classDiagram` / `flowchart` 等直接画成 SVG）
- 文档间的 `.md` 链接可直接点击跳转，**浏览器后退/前进**可在文档间回溯
- 侧边栏宽度可**拖拽调整**，状态自动记忆

### 🎓 课程（HTML 教学网页）

- 配置若干**根目录**（如 `C:/Work/AI`）
- server 扫描根目录下含 `lessons/` 目录的子文件夹，识别为教学 workspace
- 托管整个 workspace 目录树（`lessons/` + `reference/` + `assets/`），课程间的相对路径引用全部正常
- 按 workspace 分组，课程 / 速查卡分类，可折叠，默认折叠

## 快速开始

```bash
npm install
npm start
```

浏览器打开 http://localhost:8080

> **端口可配置**：默认 8080，通过环境变量 `PORT` 修改，如 `PORT=8090 npm start`。用 PM2 时改 `ecosystem.config.cjs` 里的 `env.PORT`。

首次使用时知识库和课程可能没有内容——点击右上角 **⚙** 添加根目录即可。

## 在网页里配置根目录

知识库和课程各有独立的根目录配置，都在网页内通过 **⚙** 按钮管理（改完写回配置文件，立即生效）：

| 视图 | 配置文件 | 扫描规则 |
|------|---------|---------|
| 知识库 | `knowledge.config.json` | 递归扫描 `.md` / `.html` / `.htm`，按目录树展示；可用 `excludeDirs` 追加排除目录名 |
| 课程 | `teach.config.json` | 扫描一级子目录，含 `lessons/` 的识别为 workspace |

配置对话框会**实时预览**每个根目录扫到了多少文件、哪些项目，加错路径立刻能看到（✗ 不存在 / 0 个）。

### 配置文件说明

两个配置文件包含本地路径，**不提交到代码仓库**（已在 `.gitignore` 中忽略）。仓库里提供了模板：

```
knowledge.config.example.json   # 知识库根目录模板
teach.config.example.json       # 课程根目录模板
```

克隆后复制为正式文件并填入你的路径：

```bash
cp knowledge.config.example.json knowledge.config.json
cp teach.config.example.json teach.config.json
```

模板示例：
```json
// knowledge.config.json
{
  "roots": ["C:/Work"],
  "excludeDirs": []  // 可选：额外排除的目录名，如 ["docs", "vendor"]
}

// teach.config.json
{ "roots": ["C:/Work/AI", "C:/Work/AnotherFSM"] }
```

> 也可以不手动编辑文件——直接在网页里点 **⚙** 添加/删除根目录、配置排除目录，会自动写入配置文件。

### 排除目录（excludeDirs）

`excludeDirs` 是一个字符串数组，列出扫描时要跳过的**目录名**（不区分大小写，不区分层级——任何层级的同名目录都会被排除）。它和内置默认排除列表（`node_modules`、`.git`、`dist` 等）合并生效。

常见用途：
- 某些项目根目录有大量与文档无关的 `.md`（如 `node_modules` 里的说明文件、生成文档目录），想从知识库视图里隐藏
- 项目自带不想混入知识库的 `docs/`、`vendor/` 等目录

> 注意：`excludeDirs` 是全局生效的——配置后对所有根目录下的同名目录都排除。ClaudeMdTools 自身的 `docs/` 目录按绝对路径单独排除，不会误伤其他项目的 `docs/`。

## 让 AI 通过 URL 访问知识库

服务提供了一套简洁的路径式 API，供 AI 直接用 URL 读取知识库文档（无需 JSON 解析、无需带参数）：

```
GET /kb                         # 列出所有文档路径（纯文本，一行一个）
GET /kb/<project>               # 列出某项目的文档路径
GET /kb/<project>/<path>.md     # 读取文档原文（text/plain）
```

示例：
```
GET /kb/weldone                                          # 看有哪些文档
GET /kb/weldone/openspec/specs/auth/spec.md              # 直接拿到 markdown 原文
```

在项目的 `CLAUDE.md` / `AGENTS.md` 里加一行指向 `http://localhost:8080/kb`，AI 就能自行发现并读取文档。

## 自动运行（PM2）

本项目用 PM2 作为后台服务常驻运行，崩溃自动重启、登录自动拉起。

```bash
npm run pm2:start    # 启动
npm run pm2:stop     # 停止
npm run pm2:restart  # 重启
npm run pm2:logs     # 查看日志
npm run pm2:save     # 保存进程快照（开机恢复用）
```

详见 [DEPLOY.md](./DEPLOY.md)。

## 项目结构

```
ClaudeMdTools/
├── server.js                       # Express + WebSocket 服务端
├── public/
│   └── index.html                  # 单页前端（知识库 / 课程 / 编辑 / 配置）
├── ecosystem.config.cjs            # PM2 进程配置
├── knowledge.config.example.json   # 知识库根目录配置模板
├── teach.config.example.json       # 课程根目录配置模板
├── knowledge.config.json           # 知识库根目录配置（本地，gitignore）
├── teach.config.json               # 课程根目录配置（本地，gitignore）
├── DEPLOY.md                       # 部署运维说明
└── package.json
```

## API

### 知识库路径式 API（推荐 AI / 程序访问）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/kb` | 列出所有文档路径（纯文本） |
| GET | `/kb/<project>` | 列出某项目的文档路径 |
| GET | `/kb/<project>/<path>` | 返回 `.md` 原文（text/plain） |

### 知识库 JSON API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/knowledge` | 列出知识库文档（树形结构） |
| GET | `/api/knowledge/file` | 读取单个 .md 文件内容 |
| PUT | `/api/knowledge/file` | 保存编辑（写回原始文件） |
| GET | `/api/knowledge/view` | 渲染好的 HTML 页面（新窗口打开用） |
| GET | `/api/knowledge/config` | 读取知识库配置（roots + excludeDirs） |
| POST | `/api/knowledge/config` | 更新知识库配置（roots + excludeDirs） |
| POST | `/api/knowledge/preview` | 预览根目录扫描结果 |

### 课程 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/courses` | 列出课程 workspace 及其课程/速查卡 |
| GET | `/api/courses/config` | 读取课程根目录配置 |
| POST | `/api/courses/config` | 更新课程根目录配置 |
| POST | `/api/courses/preview` | 预览根目录扫描结果 |
| GET | `/teach/:wsId/*` | 托管课程 workspace 文件（HTML/CSS/JS） |

WebSocket 推送 `knowledge-change` / `course-change` 事件，前端自动刷新。

## 技术栈

- **后端**：Express 5 + ws + chokidar + marked
- **前端**：原生 HTML/CSS/JS + marked + highlight.js + mermaid.js
- **部署**：PM2
