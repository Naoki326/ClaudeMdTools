# 为 ClaudeMdTools (pm2 claudemd) 创建开机自启计划任务
# 原理：登录时执行 pm2 resurrect，从 dump.pm2 恢复进程列表
$ErrorActionPreference = 'Stop'

$taskName = 'ClaudeMdTools-AutoStart'

# 定位 pm2 可执行文件（全局安装位置）
$pm2Cmd = "C:\Users\Naoki\AppData\Roaming\npm\pm2.cmd"
if (-not (Test-Path $pm2Cmd)) {
    # 尝试通用路径
    $pm2Cmd = "${env:APPDATA}\npm\pm2.cmd"
}
if (-not (Test-Path $pm2Cmd)) {
    Write-Error "找不到 pm2.cmd，请确认已全局安装 pm2"
    exit 1
}

# 若已存在同名任务，先删除
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "已删除旧任务：$taskName"
}

# 触发器：用户登录时
$trigger = New-ScheduledTaskTrigger -AtLogOn

# 操作：pm2 resurrect（从 dump.pm2 恢复全部进程）
$action = New-ScheduledTaskAction -Execute $pm2Cmd -Argument 'resurrect'

# 主体：当前用户，以最高权限运行
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

# 设置：允许后台运行、失败重启、不超时
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $taskName `
    -Trigger $trigger `
    -Action $action `
    -Principal $principal `
    -Settings $settings `
    -Description '开机登录后自动恢复 ClaudeMdTools (pm2 claudemd) 服务' | Out-Null

Write-Host "✓ 计划任务 '$taskName' 已创建" -ForegroundColor Green
Write-Host ""
Write-Host "当前用户: $env:USERNAME"
Write-Host "pm2 路径: $pm2Cmd"
Write-Host "恢复命令: pm2 resurrect"
Write-Host ""
Write-Host "下次开机登录后，pm2 会自动从 dump.pm2 恢复 claudemd 进程。"
