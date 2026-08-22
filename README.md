<div align="center">

# 📚 lanbook

**把散落在硬盘各处的 Markdown 笔记和 HTML 课程，装进局域网里任意一块屏幕。**

文件保持原位 · 实时刷新 · 手机 / 平板随时看 · 在线编辑写回 · AI 可直接 URL 访问

![version](https://img.shields.io/badge/version-1.3.0-blue)
![license](https://img.shields.io/badge/license-ISC-green)
![node](https://img.shields.io/badge/node-%3E%3D18-green)
![zero-build](https://img.shields.io/badge/zero--build-原生%20JS%2C%20无打包-orange)

</div>

---

## 它解决什么问题

你的笔记散落在几十个项目文件夹里：这个仓库一份 `SPEC.md`，那个 workspace 一堆 `/teach` 生成的课程。想集中翻阅？只能一个个开文件，或者复制到一处——然后副本开始过期。更别提想在沙发上用平板翻笔记：文件锁在台式机里。

**lanbook 反着来**：文件一个都不动。你告诉它去哪些目录找，它起一个常驻 Web 服务负责扫描、分类、渲染。原文件改了，浏览器里下一秒就变；服务挂着，同一局域网的电脑、手机、平板打开就是同一份知识库。

```
C:/Work/weldone/openspec/specs/...   ─┐
C:/Work/AI/lessons/*.html            ─┼─►  局域网 Web 服务  ─►  电脑 / 手机 / 平板
C:/Work/notes/*.md                   ─┘    （原地读取 · 实时刷新）
```

> lanbook 前身是 ClaudeMd Tools，1.2.0 起以 npm 包 `lanbook` 发布，旧配置首次启动自动迁移。

## 长这样

**📚 知识库视图** — 左侧目录树，右侧 Markdown 渲染 + 目录导航（TOC）

![知识库视图](https://raw.githubusercontent.com/Naoki326/ClaudeMdTools/master/docs/img/knowledge.png)

**🎓 课程视图** — HTML 教学课程原样呈现

![课程视图](https://raw.githubusercontent.com/Naoki326/ClaudeMdTools/master/docs/img/courses.png)

**📱 跨设备** — 服务常驻，平板 / 手机连同一 Wi-Fi 随时打开

![跨设备示意](https://raw.githubusercontent.com/Naoki326/ClaudeMdTools/master/docs/img/devices.png)

## ✨ 核心特性

### 📱 跨设备随时看（主场景）

- 服务监听所有网卡，常驻后，**手机 / 平板连同一 Wi-Fi，浏览器打开 `http://<电脑IP>:8080` 就是完整知识库**——无需同步、无需 app
- 文件在电脑上改，手机上打开的页面实时刷新（chokidar 监听 + WebSocket 推送）
- 前端三件套（marked / highlight.js / mermaid）随包本地分发，**断网 / CDN 不可达也照常渲染**

### 📚 知识库视图 — Markdown / HTML 文档

- **树形目录浏览** — 按根目录展开项目结构，空文件夹自动隐藏，多层折叠
- **原地渲染** — Markdown 带目录（TOC）、代码高亮、Mermaid 图表；HTML 用 iframe 原样展示（css/js/图片相对路径照常工作）
- **在线编辑** — 浏览器里改，保存直接写回原始文件
- **实时刷新** — 文件一变，页面自动更新（chokidar 监听 + WebSocket 推送）
- **互联** — 文档间 `.md` 链接可点击跳转，浏览器前进/后退正常回溯

### 🎓 课程视图 — /teach 生成的教学课程

- 为 [Matt Pocock 的 /teach 技能](https://www.aihero.dev/skills-teach)生成的教学 workspace 设计：自动识别含 `lessons/` 的目录，整个目录树托管（`lessons/` + `reference/` + `assets/`），课程间相对引用不断链
- 按 workspace 分组，课程 / 速查卡分类，可折叠——在平板上连载学习体验很好

### 🤖 AI 友好

给 AI 一个 URL，它就能自己发现并读取你的全部文档：

```
GET /kb                          # 列出所有文档路径（纯文本）
GET /kb/weldone                  # 列出某项目的文档
GET /kb/weldone/openspec/...md   # 直接拿到 markdown 原文
```

在项目的 `CLAUDE.md` / `AGENTS.md` 里加一行指向 `http://localhost:8080/kb`，Claude Code 等工具即可自行检索知识库——无需 JSON 解析、无需参数。

## 🚀 快速开始

**npm 全局安装（推荐）**——两条命令开始阅读：

```bash
npm i -g lanbook
lanbook
# 打开 http://localhost:8080
```

不想安装？`npx lanbook` 先体验再决定。

首次启动是空的——点右上角 **⚙** 添加根目录（如 `C:/Work`），立即生效。手机 / 平板连同一 Wi-Fi，浏览器打开 `http://<电脑局域网IP>:8080` 即可（电脑 IP 用 `ipconfig` 查）。

### 命令行

```bash
lanbook                    # 启动服务（默认行为）
lanbook open               # 服务未运行时后台启动，并打开浏览器
lanbook add <目录>          # 添加知识库根目录
lanbook add --teach <目录>  # 添加课程根目录
lanbook config             # 打印数据目录与三个配置文件路径（设 $EDITOR 时打开）
lanbook autostart          # 注册开机登录自启（--remove 卸载）
lanbook stop               # 停止正在运行的服务
```

### 端口与监听地址

端口默认 8080。改端口 / 收敛监听地址：编辑数据目录下 `settings.json`（`lanbook config` 可定位），可选字段 `port` / `host`，重启生效；临时改端口也可用环境变量 `PORT=8090 lanbook`。

### 开发者选项（源码模式）

想改代码或从源码运行：

```bash
git clone https://github.com/Naoki326/ClaudeMdTools.git
cd ClaudeMdTools
npm install
npm start
```

源码模式与安装模式读写同一数据目录 `~/.lanbook/`，两种身份一个真相；部署与常驻见 [DEPLOY.md](https://github.com/Naoki326/ClaudeMdTools/blob/master/DEPLOY.md)（仓库文件，npm 包内不含）。

## 🗂 数据目录

配置与元数据存放在用户主目录的**数据目录** `~/.lanbook/`（Windows 为 `%USERPROFILE%\.lanbook\`），不在安装目录——`npm update -g lanbook` 升级后配置原样保留：

```
~/.lanbook/
├── settings.json          # 服务配置（port / host）
├── knowledge.config.json  # 知识库根目录
├── teach.config.json      # 课程根目录
└── docs/                  # 对话元数据
```

- **源码模式与安装模式共用同一数据目录**——git 仓库内 `npm start` 与全局 `lanbook` 看到的是同一份配置
- **自动迁移**：1.1 及以前的源码用户首次以 1.2.0 启动时，安装目录里的旧配置自动拷入数据目录，旧文件原地改名 `*.migrated.bak` 留底，可随时回退
- 开发 / 测试隔离：环境变量 `LANBOOK_HOME` 可覆盖数据目录位置

## 🔐 安全须知：局域网读写

lanbook 默认监听 `0.0.0.0`，且**没有鉴权**。这意味着：

- 同一局域网内的**任何设备**都能打开页面——并且不止「读」：在线编辑会**直接写回**你配置的根目录里的文件，删改等同本机操作
- 适用环境：可信的家庭 / 办公内网。**不要**在咖啡馆、机场、会议公共 Wi-Fi 等不可信网络中运行，也不要通过端口转发、内网穿透等方式暴露到公网
- 每次启动横幅都会明示风险与全部局域网访问地址，请留意确认

如需收敛到仅本机访问，编辑数据目录 `settings.json`（`lanbook config` 定位）：

```jsonc
{ "host": "127.0.0.1" }   // 重启生效；此后手机 / 平板将无法访问
```

## ⚙️ 配置根目录

三种方式，效果相同（配置写回数据目录、立即生效）：

**方式一：网页里点 ⚙** — 配置对话框实时预览每个根目录扫到多少文件，加错路径当场看到（✗ 不存在 / 0 个）。

**方式二：命令行** — `lanbook add C:/Work`（知识库）/ `lanbook add --teach C:/Work/AI`（课程）。

**方式三：直接编辑配置文件** — `lanbook config` 打印路径，按需编辑：

```jsonc
// ~/.lanbook/knowledge.config.json
{
  "roots": ["C:/Work"],
  "excludeDirs": []   // 可选：额外排除的目录名，如 ["docs", "vendor"]
}

// ~/.lanbook/teach.config.json
{ "roots": ["C:/Work/AI"] }
```

> 仓库内的 `knowledge.config.example.json` / `teach.config.example.json` 是同内容的参考模板。

**excludeDirs 说明**：目录名匹配（不区分大小写、不分层级），与内置排除列表（`node_modules`、`.git`、`dist` 等）合并生效。适合隐藏 `docs/`、`vendor/` 这类不想混入知识库的目录。注意它是全局的——对所有根目录生效；lanbook 自身的 `docs/` 按绝对路径单独排除，不受影响。

## 🔁 常驻运行（开机自启）

一条命令注册，之后每次登录自动后台启动服务——**不依赖 PM2 或任何外部守护进程**：

```bash
lanbook autostart         # 注册登录自启（幂等，重复执行覆盖旧任务）
```

原理：注册 Windows 计划任务 `lanbook-autostart`（当前用户登录触发，无需管理员），经 VBS 包装隐藏窗口启动服务；stdout/stderr 追加到 `~/.lanbook/logs/service.log`。端口 / 监听地址由数据目录 `settings.json` 决定。

配套命令：

```bash
lanbook stop              # 停止服务（按端口找进程，验证身份后才杀）
lanbook autostart --remove   # 卸载自启
schtasks /Run /TN lanbook-autostart   # 手动立即启动一次（验证链路）
```

> 计划任务只负责「登录时拉起」，进程崩溃后不会自动重启。需要崩溃自动重启 / 开机即起（无需登录），用 nssm 注册原生 Windows 服务，见 [DEPLOY.md](https://github.com/Naoki326/ClaudeMdTools/blob/master/DEPLOY.md)。

## 📡 API 参考

### 路径式 API（推荐 AI / 程序访问）

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
| GET/POST | `/api/knowledge/config` | 读取 / 更新配置（roots + excludeDirs） |
| POST | `/api/knowledge/preview` | 预览根目录扫描结果 |

### 课程 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/courses` | 列出课程 workspace 及其课程/速查卡 |
| GET/POST | `/api/courses/config` | 读取 / 更新课程根目录配置 |
| POST | `/api/courses/preview` | 预览根目录扫描结果 |
| GET | `/teach/:wsId/*` | 托管课程 workspace 文件（HTML/CSS/JS） |

> 文件变化通过 WebSocket 推送 `knowledge-change` / `course-change` 事件，前端自动刷新。

## 🛠 技术栈

**后端** Express 5 · ws · chokidar · marked　**前端** 原生 HTML/CSS/JS · 本地 vendor（marked / highlight.js / mermaid 随包分发）　**常驻** 内置 autostart 命令 / nssm（可选）

## 📁 项目结构

```
lanbook/
├── bin/lanbook.js                  # CLI 入口（open / add / config / autostart / stop）
├── lib/                            # 数据目录、服务配置
├── server.js                       # Express + WebSocket 服务端
├── public/                         # 单页前端 + vendor 静态资产
├── test/                           # 进程边界测试
├── knowledge.config.example.json   # 知识库配置参考模板
├── teach.config.example.json       # 课程配置参考模板
├── DEPLOY.md                       # 部署运维说明
└── package.json
```

## 链接

- 🐙 [GitHub](https://github.com/Naoki326/ClaudeMdTools) — 仓库主页
- 💬 [LINUX DO](https://linux.do) — 开源社区，本项目在此分享交流

## License

ISC
