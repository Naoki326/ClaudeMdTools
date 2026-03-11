# Markdown 文档查看器 & Claude Code 自动发布工具

## 简介

一个本地部署的 Markdown 查看/编辑网站，配合 Claude Code Hook 实现：每当 Claude 生成或修改 `.md` 文件时，自动将文档同步到网站，方便实时阅读和编辑。

## 技术栈

- **后端**: Node.js + Express
- **实时通信**: WebSocket (ws) + chokidar 文件监听
- **前端渲染**: marked.js + highlight.js 代码高亮
- **自动同步**: Claude Code PostToolUse Hook

## 功能特性

### 文档查看
- GitHub 风格的 Markdown 渲染，支持代码高亮
- 深色/浅色主题切换，偏好自动保存

### 在线编辑
- 分栏显示：左侧编辑器 + 右侧实时预览
- 支持新建、编辑、删除文档

### 实时更新
- WebSocket 连接，文件变更时自动刷新
- 断线自动重连

### 按对话分组
- 侧边栏文件列表按 Claude Code 对话 session 分组
- 新对话排在最前，组内文件按创建时间降序
- 编辑已有文档时保留原始分组，不会跳到新对话中

### 自动发布 (Hook)
- 全局 `PostToolUse` Hook，匹配 `Write` 和 `Edit` 工具
- 自动检测 `.md` 文件并复制到 `docs/` 目录
- 记录对话 session ID 和时间戳元数据
- 文件名冲突时用路径前缀区分

## 文件结构

```
C:\Work\ClaudeTools\
├── package.json           # 项目配置
├── server.js              # Express + WebSocket 服务器 (端口 8080)
├── public/
│   └── index.html         # 前端单页应用
├── docs/                  # Markdown 文档存放目录
├── scripts/
│   └── sync-md.sh         # Hook 同步脚本
└── .claude/
    └── settings.json      # 项目级配置（已清空，Hook 已移至全局）
```

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files` | 列出所有文档（含元数据，按对话分组） |
| GET | `/api/files/:name` | 获取指定文档内容 |
| POST | `/api/files` | 创建新文档 |
| PUT | `/api/files/:name` | 更新文档内容 |
| DELETE | `/api/files/:name` | 删除文档 |
| POST | `/api/metadata` | Hook 调用，记录文件元数据 |

## 使用方法

```bash
# 启动服务
npm start

# 开发模式（热重载）
npm run dev
```

访问 http://localhost:8080 即可使用。
