# 部署运行（PM2 服务化）

本项目通过 [PM2](https://pm2.keymetrics.io/) 作为后台服务常驻运行，崩溃自动重启、登录自动拉起。

## 服务状态

| 项目 | 值 |
|------|-----|
| 进程名 | `claudemd` |
| 端口 | `8080` |
| 入口 | `server.js` |
| 工作目录 | `C:\Work\ClaudeMdTools` |
| 日志目录 | `C:\Work\ClaudeMdTools\logs\` |
| PM2 配置 | `ecosystem.config.cjs` |
| 进程快照 | `C:\Users\Naoki\.pm2\dump.pm2` |
| 开机自启 | 启动文件夹 → `claudemd-autostart.vbs` |

访问：http://localhost:8080

## 常用命令

也可以用 `package.json` 里的脚本：`npm run pm2:start|stop|restart|logs|save`。

```bash
# 查看状态
pm2 list
pm2 logs claudemd              # 实时日志（Ctrl+C 退出）
pm2 logs claudemd --lines 100  # 最近 100 行

# 重启 / 停止 / 启动
pm2 restart claudemd
pm2 stop claudemd
pm2 start claudemd

# 崩溃后若 dump 还在，手动恢复全部进程
pm2 resurrect
```

## 自动运行机制

1. **进程管理（PM2）**：`server.js` 由 PM2 守护，崩溃自动重启（`autorestart: true`，内存超 200MB 也会重启）。
2. **开机/登录自启**：`启动文件夹` 里的 `claudemd-autostart.vbs` 在登录时静默执行 `pm2 resurrect`，从 `dump.pm2` 恢复进程列表。无控制台黑窗口。

> 因为当前是普通用户权限（非管理员），无法注册成「开机即起」的原生 Windows 服务（那需要管理员）。如需「开机即起、无需登录」，以管理员身份改用 `node-windows` 或 `nssm`，见下文「升级为原生 Windows 服务」。

## 修改配置后重新保存快照

每次用 `pm2 start/stop/delete` 改动了进程后，都要重新 save，否则开机自启恢复的是旧状态：

```bash
pm2 save
```

## 卸载

```bash
pm2 delete claudemd
pm2 save
# 删除自启脚本
rm "C:/Users/Naoki/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/claudemd-autostart.vbs"
```

## 升级为原生 Windows 服务（可选，需管理员）

如果希望「开机即起、无需登录、系统级服务」，以管理员身份操作：

```bash
npm install -g node-windows
# 然后用 node-windows 把 server.js 注册成 Windows 服务
# （服务名 ClaudeMdTools，启动类型自动）
```

或用 [NSSM](https://nssm.cc/)：
```bash
nssm install ClaudeMdTools "C:\Program Files\nodejs\node.exe" "C:\Work\ClaudeMdTools\server.js"
nssm set ClaudeMdTools AppDirectory C:\Work\ClaudeMdTools
nssm set ClaudeMdTools AppStdout C:\Work\ClaudeMdTools\logs\out.log
nssm set ClaudeMdTools AppStderr C:\Work\ClaudeMdTools\logs\err.log
nssm start ClaudeMdTools
```

注册成原生服务后，就可以移除上面的 PM2 方案。
