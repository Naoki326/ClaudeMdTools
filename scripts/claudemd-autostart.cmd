@echo off
:: ClaudeMdTools 开机自启包装脚本
:: 登录后自动从 pm2 dump 恢复 claudemd 服务
:: 静默运行，避免弹出黑窗（通过 pm2 resurrect 自身的后台特性）

:: 定位 pm2.cmd
set "PM2_CMD=C:\Users\Naoki\AppData\Roaming\npm\pm2.cmd"
if not exist "%PM2_CMD%" (
  echo [ClaudeMdTools] pm2.cmd not found, aborting
  exit /b 1
)

:: 从 dump.pm2 恢复进程列表（pm2 自身守护，无需阻塞）
call "%PM2_CMD%" resurrect
