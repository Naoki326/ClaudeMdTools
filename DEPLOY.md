# 部署运行

lanbook 是常驻局域网的文档服务。1.3 起内置 `lanbook autostart` 一条命令注册登录自启，**不再依赖 PM2**。

三种运行身份（读写同一数据目录 `~/.lanbook/`）：

- **pi 安装模式**——`pi install npm:lanbook`，用 `/lanbook autostart` 注册自启
- **npm 全局安装模式**——`npm i -g lanbook` 安装，用 `lanbook autostart` 注册自启
- **源码模式（开发者）**——git 仓库内运行，用 `lanbook autostart` 注册自启

三种身份的常驻方式完全相同（见下节），`autostart` 会指向各自身份的 `server.js`——
即注册时用的是哪份包的 CLI，自启脚本就指向那份包里的服务端。

> **别重复安装**：pi 装的包里已含完整的服务端与 CLI，不需要再 `npm i -g lanbook`。
> 两份共存时自启脚本只会指向其中一份，卸载那一份就会让任务静默失效。

## 常驻运行（登录自启）

```bash
lanbook autostart        # 注册登录自启（幂等，重复执行覆盖旧任务）
```

用 pi 装的话用对应的斜杠命令（等价，且不必装全局）：

```
/lanbook autostart       # 注册登录自启
/lanbook status          # 查看服务与自启状态（含自启脚本指向是否有效）
```

原理链路（三平台同一套语义，各自的系统原生机制，详见 ADR-0005）：

```
Windows  计划任务 lanbook-autostart（登录 + 解锁触发，无需管理员）
  → wscript  <数据目录>/autostart.vbs        （隐藏窗口，无黑框）
    → cmd      <数据目录>/autostart-task.cmd （守护循环：崩溃 3 秒重启；stdout/stderr 重定向）
      → node   <包目录>/server.js

macOS    launchd LaunchAgent ~/Library/LaunchAgents/lanbook-autostart.plist
           （RunAtLoad 登录拉起，KeepAlive 崩溃保活，日志直接写 service.log）

Linux    systemd user 单元 ~/.config/systemd/user/lanbook-autostart.service
           （default.target 登录拉起，Restart=on-failure + RestartSec=3 崩溃重启）
```

| 项目 | 值 |
|------|-----|
| 任务名 / Label / 单元 | `lanbook-autostart`（`LANBOOK_AUTOSTART_TASK` 可覆盖） |
| 触发 | 当前用户登录（Windows 额外含工作站解锁触发；macOS KeepAlive 覆盖唤醒场景） |
| 端口 / host | 数据目录 `settings.json`（自启场景没有 `PORT` 环境变量，settings 说了算） |
| 日志 | `~/.lanbook/logs/service.log`（追加写，过大手动清理） |
| 注册产物 | Windows: VBS + CMD 包装脚本；macOS: plist；Linux: unit 文件（注册时生成，`--remove` 时删除） |

配套命令：

```bash
lanbook stop                        # 停止服务（先停自启守护防复活，再按端口找进程，验明身份后才杀）
lanbook autostart --remove          # 卸载自启（同时删除注册产物）
schtasks /Run /TN lanbook-autostart             # Windows：手动立即启动一次
launchctl kickstart gui/$(id -u)/lanbook-autostart   # macOS：手动立即重启
systemctl --user restart lanbook-autostart.service   # Linux：手动立即重启
```

> 需要开机即起（无需登录）或系统级服务：Windows 用 nssm 注册原生服务，Linux 用 `loginctl enable-linger` 配合 systemd user 单元，见下文。

## 从 PM2 迁移（1.2.x → 1.3）

```bash
pm2 delete lanbook        # 停掉并移除 pm2 托管的旧进程；没有可跳过
pm2 save                  # 快照里不再有 lanbook，resurrect 不会复活它
lanbook autostart         # 注册登录自启
```

- 1.2.x 时代的旧计划任务（登录执行 `pm2 resurrect`）与新任务同名 `lanbook-autostart`，注册时 `-Force` 直接覆盖，无需手工清理
- 数据目录 `~/.lanbook/` 与 `settings.json` 端口配置原样保留，服务地址不变

## 升级为原生 Windows 服务（可选，需管理员）

「开机即起、无需登录、崩溃自动重启」用 [NSSM](https://nssm.cc/)：

```bash
nssm install lanbook "C:\Program Files\nodejs\node.exe" "C:\path\to\lanbook\server.js"
nssm set lanbook AppDirectory "C:\path\to\lanbook"
nssm set lanbook AppStdout "C:\path\to\logs\out.log"
nssm set lanbook AppStderr "C:\path\to\logs\err.log"
nssm start lanbook
```

⚠️ nssm 默认用 LocalSystem 账户运行，`os.homedir()` 会指向 systemprofile，数据目录 `~/.lanbook` 会建到别处（roots 配置看起来「丢了」）。二选一：

```bash
nssm set lanbook ObjectName ".\你的用户名" "密码"
# 或
nssm set lanbook AppEnvironmentExtra LANBOOK_HOME=C:\Users\你的用户名\.lanbook
```

注册原生服务后记得 `lanbook autostart --remove`，避免登录自启与系统服务双开抢端口。

## 排错

**登录后服务没起来**：

```
/lanbook status                                     # 用 pi 装的话：先跑这个，会直接指出问题
```

```bash
schtasks /Query /TN lanbook-autostart /V /FO LIST   # 任务是否存在、上次结果
tail -50 ~/.lanbook/logs/service.log                # 服务自己的输出（崩溃原因在这里）
```

先看 `autostart-task.cmd` 里写死的 `server.js` 路径是否还存在——卸载或换装
lanbook 后该路径会失效，而计划任务仍显示「就绪」，故障要等到下次重启才暴露。
`/lanbook status` 会直接报出这种状态；修复只需重跑 `/lanbook autostart`（或 `lanbook autostart`）。

**端口被占**：

```bash
lanbook stop                                        # 先试内置停止
netstat -ano | findstr :8080                        # 看占用者 pid
powershell "Get-CimInstance Win32_Process -Filter \"ProcessId=<pid>\" | Select CommandLine"
```

**历史加固仍在生效**（1.2 时代 PM2 快速重启竞态的教训，对任何常驻方式都有价值）：

- 端口冲突同时挂在 `server.on('error')` 与 `wss.on('error')` 上（`WebSocketServer` 的冲突错误从 wss 实例 emit，漏注册会直接崩进程）
- 收到 `SIGTERM`/`SIGINT` 优雅关闭：先关全部 chokidar watcher 与 WebSocket 连接再退出，端口及时释放
