# 自启跨平台：三平台原生服务管理机制映射，一份语义

`lanbook autostart` 1.6 及之前只在 Windows 上可用（计划任务 + VBS/CMD 包装），macOS / Linux 直接拒绝。但 lanbook 的主场景是「手机 / 平板跨设备阅读」，一台常开的 Mac mini 或 Linux 小主机往往比 Windows 台式机更是天然的托管机——autostart 锁死平台等于锁死最常见的部署形态。

跨平台不是「三个平台的代码各写一遍」：三个平台对同一组需求（登录拉起、崩溃自愈、日志落盘、stop 不复活、可卸载）各有原生机制，`lib/autostart.js` 把映射收敛成一份语义：

| 语义 | Windows（沿用 1.3 方案） | macOS | Linux |
|---|---|---|---|
| 注册产物 | 计划任务 + 数据目录 VBS/CMD 包装 | `~/Library/LaunchAgents/<name>.plist` | `$XDG_CONFIG_HOME/systemd/user/<name>.service` |
| 登录拉起 | AtLogOn 触发（+ 工作站解锁触发） | `RunAtLoad`（launchd 加载 LaunchAgents） | `WantedBy=default.target` |
| 崩溃自愈 | CMD `:loop` 3 秒重启 + 停止标记 | `KeepAlive`（立即保活） | `Restart=on-failure` + `RestartSec=3` |
| 日志 | `>> logs/service.log` | `StandardOutPath` / `StandardErrorPath` | `StandardOutput/Error=append:`（systemd ≥ 240） |
| stop 防复活 | 写 `.service-stopped`，守护循环退出 | `launchctl bootout gui/<uid>/<name>` | `systemctl --user stop <name>` |
| 卸载 | `Unregister-ScheduledTask` + 清附属文件 | bootout + 删 plist | `disable --now` + 删 unit + daemon-reload |
| 下次登录 | 任务再触发 | launchd 再加载 plist | default.target 再拉起 |
| 残留清理 | 注册时自动清理孤儿任务（双签名 + 目标失效）| 不适用（单产物）| 不适用（单产物）|

三处刻意的不对称：
- **macOS 不需要「解锁触发」**。Windows 要补解锁触发是因为守护循环只在任务启动时开始跑；launchd 的 `KeepAlive` 是会话级强保活——服务崩了立即拉起，根本不存在「长期不重启机器上的空窗」，解锁场景天然覆盖。
- **Unix 不需要停止标记文件**。Windows 的标记是为让自制 CMD 循环知道「别再拉了」；launchd / systemd 的 stop/bootout 本身就是「停且不复活」的官方语义，再造一个标记文件是第二份真相。`lanbook stop` 在三平台上语义一致：本次停下、下次登录自启恢复。
- **注册即启动**（macOS / Linux）。Windows 注册后需 `schtasks /Run` 手动起一次；launchd bootstrap 与 `enable --now` 没有等价的「只注册不启动」形态，顺势而为——注册即启动更符合「我现在就要它常驻」的意图。

任务名统一：`LANBOOK_AUTOSTART_TASK`（默认 `lanbook-autostart`）在三平台分别用作计划任务名 / launchd Label 与 plist 文件名 / systemd 单元基名——测试隔离只需一个环境变量。

## 孤儿任务清理（Windows 特有）

Windows 的注册产物**分居两处**：系统侧的计划任务、数据目录侧的 `autostart.vbs`。两者一旦不同步，就产生孤儿任务——数据目录先没了（Temp 被清理、`LANBOOK_HOME` 换位置、测试临时目录回收），任务还留着，于是每次登录 / 工作站解锁都弹「无法找到脚本文件 `...\autostart.vbs`」。macOS / Linux 的 plist / unit 与注册动作同一处，不存在这种半截状态，所以清理只针对 Windows。

这个坑真实发生过：调试期用 `LANBOOK_AUTOSTART_TASK=old-check-1` 做隔离测试，测试进程被强杀导致 `t.after` 未执行，任务留在系统里、数据目录在 `%TEMP%` 下被回收，此后每天登录弹框。

清理策略是**双签名 + 目标失效**，两道保险叠加：

| 环节 | 规则 |
|---|---|
| 认领（这是不是我的任务）| 任务描述含 `managed by lanbook`（新注册写入，最可靠），**或**动作是 `wscript` 拉起 `autostart.vbs`（兼容历史无描述任务）|
| 判失效（是不是该清）| 动作里的脚本绝对路径不存在；路径解析不出时按坏任务处理 |
| 永不误伤 | 目标健在的任务一律不动；注册流程额外传入 `currentTaskName` 排除即将重建的任务 |

触发时机：`lanbook autostart` 注册时自动清理（无需用户知情），也可 `lanbook autostart --prune` 单独清理。枚举用 `Get-ScheduledTask` 输出 UTF-8 JSON，而非 `schtasks`——后者本地化列名 + GBK 输出会损坏含中文的路径，可能把「文件存在」误判为不存在，进而误删活任务。清理失败不阻断注册，只在输出里记一条 note。

## Considered Options

- **三平台原生机制映射（选定）**——零运行时依赖，每台机器用其最正统的服务管理；与系统工具（`systemctl --user status lanbook-autostart`）互通
- 跨平台守护库（pm2 / node-windows / launchjs…）——1.3 已因 PM2 的 node_modules 绑定与升级脆弱性否决过同类方案，不再走回头路
- Cron / shell rc（`~/.bashrc`、crontab `@reboot`）——只覆盖登录 shell 场景，无崩溃自愈，GUI 会话外的服务管理黑盒
- 只做 Windows、其他平台文档指引——把「文件不动、原地托管」的工具锁在单一平台上，与跨设备阅读的主场景矛盾

## Consequences

- `bin/lanbook.js` 的 autostart 只剩参数解析与平台化输出；注册 / 卸载 / stop 钩子全在 `lib/autostart.js`，平台、命令执行器、目录、uid 均可注入——Windows CI 上即可覆盖三平台分支（`test/autostart.test.js`），launchctl / systemctl 不在单测中真跑
- `lib/autostart.js` 的 `describeAutostart()` 是「自启是否已注册、指向哪份 server.js、如何拉起」的唯一真相：pi 扩展 `/lanbook status` 与 `startLanbook` 经 createRequire 复用它，不再自己猜平台路径（与 ADR-0004 的 link-host 同一模式）
- `lanbook stop` 先经 stop 钩子停守护、再扫端口兜底杀手动实例——顺序不可颠倒，否则 Unix 上服务管理器会立刻复活刚杀掉的进程
- Windows 行为零变化（等价平移），`test/cli.test.js` 的计划任务集成测试不变即守护
- systemd `append:` 日志需要 systemd ≥ 240（2019）；更老的环境 `enable --now` 会明确报错，不静默丢日志
- 纯 SSH 无图形登录的 macOS 上 `launchctl bootstrap gui/<uid>` 不可用，注册时报错并提示在桌面会话中操作（不静默降级）
- 任务描述被用作清理的认领签名（`TASK_MARKER`），故注册时必须写 `-Description`；描述保持纯 ASCII，避免区域设置差异下的乱码
