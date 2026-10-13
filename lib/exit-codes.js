'use strict';
// 守护-服务退出码契约（docs/adr/0005 修订）：
//
// 服务对 EADDRINUSE 做有界重试，耗尽后以 PORT_CONFLICT_EXIT_CODE 退出；
// Windows 守护循环（autostart-task.cmd）对该码做**精确相等**比较——失败计数 +1、
// 按 3s → 6s → 12s → … 倍增（封顶 5 分钟）退避后重试；其它退出码视为
// 「正常运行过之后的退出」，计数清零、按基线 3s 重启。
//
// 为什么不能在 cmd 里用 `if errorlevel N` 判定：那是 ≥ 语义，会把退出码 ≥42 的
// 崩溃误分类成端口冲突。42 避开常见小错误码（1 = taskkill 强杀等一般失败），
// 与 Windows 强杀（taskkill /F → 1、控制台关闭 → 3221225786 等）不撞车。
//
// 本模块是 server.js（服务侧退出）与 lib/autostart.js（守护脚本生成、判定常量）
// 的唯一真相，测试也从这里取值断言。
const PORT_CONFLICT_EXIT_CODE = 42;

// EADDRINUSE 的有界重试：首次失败后再试这么多次、间隔 1 秒，然后放弃退出。
// 有界时间 ≈ 3–4 秒——同端口起两个服务时，第二个在该时间内以约定退出码退出，
// 而不是无限重试或无上限刷屏。间隔 1s 同时给「前一个实例正在优雅关闭、端口
// 即将释放」的竞态一个自愈窗口：重试期间端口释放则直接接管，不再退出。
const EADDRINUSE_MAX_RETRIES = 3;
const EADDRINUSE_RETRY_DELAY_MS = 1000;

module.exports = { PORT_CONFLICT_EXIT_CODE, EADDRINUSE_MAX_RETRIES, EADDRINUSE_RETRY_DELAY_MS };
