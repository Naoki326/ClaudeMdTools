# 数据目录放用户主目录（~/.lanbook），不用 XDG 分离

npm 化后服务的可变状态（配置、metadata）不能写在安装目录——会被升级覆盖，且全局 node_modules 可能无写权限。我们选择用户主目录下的单一目录 `~/.lanbook/`，而不是 XDG 风格的 config/data 分离（`~/.config` + `~/.local/share`）：Windows 上 XDG 并不原生，等于三平台三套路径，对这个体量的工具是过度设计。路径随包名命名，发布后即是公开契约。两种运行身份（源码模式 / 安装模式）读写同一数据目录；`LANBOOK_HOME` 环境变量可覆盖，用于开发与测试隔离。

## Considered Options

- `~/.lanbook/` 单目录（选定：跨平台一条路径，实现与文档最简）
- XDG config/data 分离（更 Unix 正确，但 Windows 不原生）
- 继续写安装目录（npm 升级覆盖 + 权限问题，不可行）
