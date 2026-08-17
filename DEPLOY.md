# 部署运行（PM2 服务化）

本项目通过 [PM2](https://pm2.keymetrics.io/) 作为后台服务常驻运行，崩溃自动重启。

两种运行身份（读写同一数据目录 `~/.lanbook/`）：

- **安装模式（推荐）**——`npm i -g lanbook` 安装，PM2 托管包内 `server.js`
- **源码模式（开发者）**——git 仓库内运行，使用仓库内 `ecosystem.config.cjs`（**源码模式专用**，npm 用户不需要）

## 安装模式常驻（推荐）

老用户两行迁移换代（先删旧 `claudemd` 进程再启动）：

```bash
pm2 delete claudemd   # 1.1 时代的旧进程名；没有可跳过
pm2 start "$(npm root -g)\lanbook\server.js" --name lanbook
pm2 save
```

> **Windows 注意**：不要写 `pm2 start lanbook`——PM2 会经 PATHEXT 解析到 npm 生成的
> `lanbook.cmd` 批处理 shim，并把它当 node 脚本执行，直接 SyntaxError 崩溃循环
> （pm2 7.x 实测：8 秒内重启 15 次转 errored）。让 PM2 直接托管包内的 `server.js`
> 即可；`npm root -g` 输出全局包目录（Windows 默认 `%APPDATA%\npm\node_modules`）。

| 项目 | 值 |
|------|-----|
| 进程名 | `lanbook` |
| 端口 | `8080`（数据目录 `settings.json` 的 `port` 可改，重启生效；`PORT` 环境变量临时覆盖） |
| 入口 | `<全局包目录>\lanbook\server.js`（`npm root -g` 定位） |
| 数据目录 | `~/.lanbook/`（配置升级不丢） |
| 日志 | `pm2 logs lanbook` |

常用命令：

```bash
pm2 logs lanbook              # 实时日志（Ctrl+C 退出）
pm2 logs lanbook --lines 100  # 最近 100 行
pm2 restart lanbook
pm2 stop lanbook
pm2 save                      # 改动进程后重新保存快照
pm2 resurrect                 # 从 dump.pm2 恢复进程列表
```

升级：`npm update -g lanbook && pm2 restart lanbook`（配置与元数据在数据目录，原样保留）。

## 源码模式（开发者，`ecosystem.config.cjs` 专用）

> `ecosystem.config.cjs` 与 `scripts/` 下的开机自启脚本均为**源码模式专用**，保留在仓库内；安装模式用上节的命令（PM2 托管全局安装目录内的 `server.js`）。

### 服务状态

| 项目 | 值 |
|------|-----|
| 进程名 | `lanbook` |
| 端口 | `30142` |
| 入口 | `server.js` |
| 工作目录 | `C:\Work\ClaudeMdTools` |
| 日志目录 | `C:\Work\ClaudeMdTools\logs\` |
| PM2 配置 | `ecosystem.config.cjs` |
| 进程快照 | `C:\Users\Naoki\.pm2\dump.pm2` |
| 开机自启 | 登录计划任务 → `pm2 resurrect`（`scripts/setup-autostart.ps1`） |

也可以用 `package.json` 里的脚本：`npm run pm2:start|stop|restart|logs|save`。

```bash
# 查看状态
pm2 list
pm2 logs lanbook              # 实时日志（Ctrl+C 退出）
pm2 logs lanbook --lines 100  # 最近 100 行

# 重启 / 停止 / 启动
pm2 restart lanbook
pm2 stop lanbook
pm2 start ecosystem.config.cjs

# 崩溃后若 dump 还在，手动恢复全部进程
pm2 resurrect
```

### 自动运行机制

1. **进程管理（PM2）**：`server.js` 由 PM2 守护，崩溃自动重启（`autorestart: true`，内存超 1G 也会重启，重启间隔 5 秒避免端口竞态）。
2. **开机/登录自启**：`scripts/setup-autostart.ps1` 创建登录计划任务，登录时执行 `pm2 resurrect`，从 `dump.pm2` 恢复进程列表（含 errored 进程也能拉起）。无控制台黑窗口。

> 因为当前是普通用户权限（非管理员），无法注册成「开机即起」的原生 Windows 服务（那需要管理员）。如需「开机即起、无需登录」，以管理员身份改用 `node-windows` 或 `nssm`，见下文「升级为原生 Windows 服务」。

### 修改配置后重新保存快照

每次用 `pm2 start/stop/delete` 改动了进程后，都要重新 save，否则开机自启恢复的是旧状态：

```bash
pm2 save
```

### 卸载（源码模式）

```bash
pm2 delete lanbook
pm2 save
# 删除登录自启计划任务
Unregister-ScheduledTask -TaskName 'lanbook-autostart' -Confirm:$false
```

### 排错：开机后服务没起来（源码模式）

历史上出现过“自启后崩溃被放弃”的问题，根因链：

1. `server.js` 监听大型知识库目录（如 `RobimSrc` 29k+ 文件）占用较高内存 → 触发 `max_memory_restart` 重启
2. PM2 超内存重启时旧进程端口未释放 → 新进程 `EADDRINUSE` 崩溃 → 连续重试 → 被判为 errored 放弃

已做的加固（见 `server.js` / `ecosystem.config.cjs`）：

- **`wss.on('error')` + `server.on('error')`**：端口冲突从 `WebSocketServer` 实例 emit，必须两者都注册，否则进程崩溃（已修复）
- **优雅关闭**：收到 `SIGTERM`/`SIGINT` 时关闭所有 `chokidar` watcher、`WebSocketServer`、`http.Server` 再退出，确保端口及时释放
- **`restart_delay: 5000`**：重启间隔 5 秒，给 TCP 端口留出释放时间
- **`max_memory_restart: 1G`**：监听大目录内存开销高，放宽阈值

若仍遇到问题，排查步骤：

```bash
pm2 logs lanbook --lines 50     # 看崩溃原因（安装模式同理，进程同名）
tail -20 logs/err.log           # 看是否 EADDRINUSE
netstat -ano | grep 30142       # 看端口占用者
# 若有脱管孤儿进程占着端口：
powershell "Get-CimInstance Win32_Process | Where-Object { \$_.CommandLine -like '*ProcessContainerFork*' } | Select ProcessId,CommandLine"
```

### 升级为原生 Windows 服务（源码模式，可选，需管理员）

如果希望「开机即起、无需登录、系统级服务」，以管理员身份操作：

```bash
npm install -g node-windows
# 然后用 node-windows 把服务注册成 Windows 服务
# （服务名 lanbook，启动类型自动）
```

或用 [NSSM](https://nssm.cc/)：
```bash
nssm install lanbook "C:\Program Files\nodejs\node.exe" "C:\Work\ClaudeMdTools\server.js"
nssm set lanbook AppDirectory C:\Work\ClaudeMdTools
nssm set lanbook AppStdout C:\Work\ClaudeMdTools\logs\out.log
nssm set lanbook AppStderr C:\Work\ClaudeMdTools\logs\err.log
nssm start lanbook
```

注册成原生服务后，就可以移除上面的 PM2 方案。
