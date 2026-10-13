# 自启跨平台：三平台原生服务管理机制映射，一份语义

`lanbook autostart` 1.6 及之前只在 Windows 上可用（计划任务 + VBS/CMD 包装），macOS / Linux 直接拒绝。但 lanbook 的主场景是「手机 / 平板跨设备阅读」，一台常开的 Mac mini 或 Linux 小主机往往比 Windows 台式机更是天然的托管机——autostart 锁死平台等于锁死最常见的部署形态。

跨平台不是「三个平台的代码各写一遍」：三个平台对同一组需求（登录拉起、崩溃自愈、日志落盘、stop 不复活、可卸载）各有原生机制，`lib/autostart.js` 把映射收敛成一份语义：

| 语义 | Windows（沿用 1.3 方案） | macOS | Linux |
|---|---|---|---|
| 注册产物 | 计划任务 + 数据目录 VBS/CMD 包装 | `~/Library/LaunchAgents/<name>.plist` | `$XDG_CONFIG_HOME/systemd/user/<name>.service` |
| 登录拉起 | AtLogOn 触发（+ 工作站解锁触发） | `RunAtLoad`（launchd 加载 LaunchAgents） | `WantedBy=default.target` |
| 崩溃自愈 | CMD `:loop` 3 秒重启（端口冲突按退出码退避）+ 停止标记 | `KeepAlive`（立即保活） | `Restart=on-failure` + `RestartSec=3` |
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

## 工作目录钉在数据目录

守护与服务是常驻进程，会**一直持有**启动时继承的 CWD；继承来的目录（宿主 shell、pi 会话停着的任何项目目录）在 win32 上从此无法 rename/delete。真实事故（2026-10）：守护从某包的安装目录里被拉起，该目录被 cmd/node 钉死，npm 更新那个包报 EBUSY——占用关系在进程命令行里不可见，只有枚举各进程 CWD 才能定位。这与 `set "PORT="` 防环境变量渗透是同一课：**常驻进程不继承宿主环境里任何会「占住不放」的东西**。三平台各自的钉法：

| 产物 | 钉法 |
|---|---|
| Windows 守护脚本 | `cd /d <数据目录>`（进 `:loop` 前执行一次；所有拉起路径都汇到这个脚本，钉一处全覆盖） |
| Windows 计划任务动作 | `New-ScheduledTaskAction -WorkingDirectory <数据目录>`（默认是 System32，不锁用户目录但也属「钉在别人家」；与上者双保险） |
| macOS plist | `WorkingDirectory`（launchd 默认 CWD 是 `/`） |
| Linux unit | `WorkingDirectory=`（systemd user 单元默认 CWD 是 `$HOME`） |

服务端兜底：`server.js` 启动即 `process.chdir(DATA_DIR)`——服务内部路径本就全为绝对路径（数据目录 + `__dirname`），chdir 零行为变化，只解除对启动者目录的占用，也覆盖未来新增的拉起路径。pi 扩展拉起守护（`lanbook-open.ts` startLanbook）与 `lanbook open` 直启服务（`bin/lanbook.js` cmdOpen）的 spawn 同样显式传 `cwd`。

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
- 守护与服务的工作目录固定为数据目录（守护脚本 `cd /d` + 计划任务 `-WorkingDirectory` + 扩展/CLI spawn `cwd` + `server.js` chdir 四层，见上文）；服务内部全用绝对路径，chdir 无行为变化，仅解除 win32 上对启动者目录的 rename 锁

## 修订（2026-10 · 守护风暴护栏）：节流原语、退出码契约、日志归档

端口探测 + 30 秒待命（前次修订）封住了「解锁触发叠开守护」这一已知触发源，但风暴的完整候选成因（任务会话环境下探测工具不可用、多守护竞态……）并未全部复现。本修订不再赌成因，转而给「任何未知触发」建立**有界性护栏**：就算风暴机理复发，冲突行数、日志体积也全部有界，且退避时间线本身就是诊断材料。

### timeout 为何失效，睡眠为何用 ping

守护循环的睡眠发生在 wscript 隐藏窗口拉起的 cmd 里（生产启动路径：计划任务 → vbs `Run "...", 0, False`）。`timeout /t N` 依赖控制台 stdin——它要监听按键才能提供「按任意键跳过」；隐藏窗口没有控制台 stdin，实测 30 秒的 timeout 65ms 即返：30 秒待命变 65ms 空转、3 秒重启变连发，正是守护风暴的放大器。`ping -n N 127.0.0.1` 不碰 stdin，按秒节流（`-n` = 秒数 + 1，首 ping 即发；本机实测 `-n 4` ≈ 3s、`-n 31` ≈ 30s），无控制台环境下行为稳定。凡是依赖控制台环境的 cmd 内建（timeout、pause、choice）在自启链路里都不可信。

### 守护-服务退出码契约（失败退避）

服务对 `EADDRINUSE` 先做有界重试（3 次、间隔 ~1s——给「前一个实例正在优雅关闭、端口即将释放」的竞态一个自愈窗口，重试期间端口释放则直接接管），耗尽后打印既有冲突文案并以约定退出码 **42** 退出。码值定义在 `lib/exit-codes.js`：服务端（`server.js`）、守护脚本生成（`lib/autostart.js`）与测试共用一份真相；42 避开常见小错误码（如 1 = taskkill 强杀的一般失败），与 Windows 强杀退出码不撞车。

守护循环对该码做**精确相等**比较（`if "%EC%"=="42"`）：命中则失败计数 +1，重启间隔 3s → 6s → 12s → … 倍增、封顶 5 分钟后重试；其它退出码一律视为「正常运行过之后的退出」，计数清零、按基线 3s 重启。不能用 `if errorlevel N` 判定——那是 ≥ 语义，会把退出码 ≥ 42 的崩溃误分类成端口冲突（这正是退出码契约要求精确相等的原因）。

失败退避使任何未知触发机理即使复发也有界：冲突行最多以退避节奏出现（风暴形态实测 30+ 行/10s，护栏后 ≤4），`.old` 归档 + service.log 里的退避时间线即诊断材料。macOS 的 `KeepAlive` 与 Linux 的 `Restart=on-failure` 保持原样（零改动）：launchd / systemd 自带重启节流，不存在 cmd 循环这台「无上限放大器」，也无退出码可判——服务进程的退出码被服务管理器吞掉。

### 日志归档

守护循环每次追加日志前检查 `service.log` 体积（cmd 原生 `for %%F` 的 `~z` 修饰符，零依赖），超过 20 MiB 改名为 `service.log.old`（`move /y` 覆盖旧 `.old`），随后从空重新累积。归档放在守护侧、服务退出后的窗口执行：服务运行期间日志句柄被 `>>` 继承独占，只有这时改名才不会 EBUSY。实现上有一个 cmd 语法陷阱：**批处理里未定义变量的 `%VAR%` 展开为空**（不是保持字面量），日志不存在时 `%LOGSZ%` 展开成空会让 `if GTR N` 变成语法错误（"X was unexpected at this time"），整个守护脚本当场中止——所以体积变量必须先置 0 兜底，保证它永远展开为数字。
