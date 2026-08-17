# 前端三件套 vendor 进包，不走 CDN

marked / highlight.js / mermaid 原本走 cdnjs CDN。工具的生命线是「局域网自足」——断网或 CDN 不可达（cdnjs 在国内不稳定）时前端直接白屏，而服务器明明就在本机。因此三件套打进 npm 包（体积约 +3~4MB），换取无条件离线可用。

## Consequences

- 升级前端库 = 手动替换包内 vendor 文件，不随 `npm update` 自动走
- 包体积增大，换取零外网依赖
