# vendor 前端三件套（ADR-0002）

本目录存放前端静态依赖，随包分发、离线无条件可用。**升级 = 手动替换本目录文件**，不随 `npm update` 自动走。

| 文件 | 库 / 主题 | 版本 | 来源 |
| --- | --- | --- | --- |
| `marked.min.js` | marked | 12.0.0 | https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.0/marked.min.js |
| `highlight.min.js` | highlight.js（common 语言包） | 11.9.0 | https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js |
| `github.min.css` | highlight.js GitHub 主题（明色） | 11.9.0 | https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css |
| `github-dark.min.css` | highlight.js GitHub Dark 主题（暗色） | 11.9.0 | https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css |
| `mermaid.min.js` | mermaid | 11.12.0 | https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.12.0/mermaid.min.js |

引用方（改文件名 / 路径时需同步）：

- `public/index.html`（首页）
- `server.js` 知识库渲染页模板（`/api/knowledge/view`）

注意：页面引用一律用绝对路径 `/vendor/...`——渲染页 URL 在 `/api/knowledge/view` 深层，相对路径会解析错位。

服务端依赖因此收敛为实际 require 的模块（express / ws / chokidar / marked）；highlight.js 不再是 npm 依赖，仅以本目录资产入包。
