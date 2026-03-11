# ClaudeTools - Markdown 文档查看器

配合 Claude Code Hook 的本地 Markdown 文档查看/编辑工具。当 Claude 在任意位置创建或修改 `.md` 文件时，自动同步到网站实时查看。

## 功能

- **自动同步** — Claude Code 写入的 `.md` 文件通过 PostToolUse Hook 自动复制到 `docs/` 目录
- **实时更新** — WebSocket 推送文件变更，无需手动刷新
- **在线编辑** — 左右分栏的 Markdown 编辑器，支持实时预览
- **对话分组** — 按 Claude Code session 自动归类文档
- **智能标题** — 从 `# 标题` 或源文件路径自动推导可读标题
- **暗色模式** — 支持明/暗主题切换，状态自动保存
- **可折叠侧边栏** — 点击收起/展开，状态持久化

## 快速开始

```bash
npm install
npm start
```

浏览器打开 http://localhost:8080

## 配置 Hook

在 Claude Code 的 `settings.json` 中添加：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "bash C:/Work/ClaudeMdTools/scripts/sync-md.sh"
          }
        ]
      }
    ]
  }
}
```

注意这一行： "command": "bash C:/Work/ClaudeMdTools/scripts/sync-md.sh" 路径C:/Work/ClaudeMdTools/需要替换成你的项目地址
配置后，Claude 每次使用 Write 或 Edit 工具操作 `.md` 文件时，Hook 脚本会自动：
1. 将文件复制到 `docs/` 目录
2. 通过 API 记录 session ID、时间戳、源路径等元数据

## 项目结构

```
ClaudeMdTools/
├── server.js              # Express + WebSocket 服务端
├── public/
│   └── index.html         # 单页前端（查看/编辑/管理）
├── scripts/
│   └── sync-md.sh         # PostToolUse Hook 脚本
├── docs/                  # 同步的文档存放目录
│   ├── .metadata.json     # 文件元数据（session、时间戳）
│   └── .sources           # 文件名 → 源路径映射
└── package.json
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/files` | 获取文件列表（含标题、分组） |
| GET | `/api/files/:name` | 获取文件内容 |
| POST | `/api/files` | 创建新文件 |
| PUT | `/api/files/:name` | 更新文件内容 |
| DELETE | `/api/files/:name` | 删除文件 |
| POST | `/api/metadata` | Hook 脚本调用，记录元数据 |

## 技术栈

- **后端**: Express 5 + ws + chokidar
- **前端**: 原生 HTML/CSS/JS + marked + highlight.js
