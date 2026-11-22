# 撤销管理员模式：删掉登录任务，恢复普通权限启动控制台。
# 同样需要右键「以管理员身份运行」。

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '需要管理员权限：请右键这个脚本 →「以管理员身份运行」。' -ForegroundColor Yellow
  exit 1
}

$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo 'desktop-app\QQBridgeConsole.exe'
$stateDir = Join-Path $repo 'state'

schtasks /Delete /TN 'QQBridge-ConsoleAdmin' /F 2>$null | Out-Null
Write-Host '已删除计划任务 QQBridge-ConsoleAdmin'

$conn = Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) {
  Write-Host "停止管理员控制台 PID $($conn.OwningProcess)…"
  Stop-Process -Id $conn.OwningProcess -Force
  Start-Sleep -Seconds 4
}

# 从当前（管理员）脚本里启动的子进程仍是管理员；这里显式用 explorer 交给普通用户会话。
Start-Process explorer.exe -ArgumentList "`"$exe`""
Write-Host '已用普通权限重新启动控制台（若没弹出，双击桌面快捷方式即可）。'
Write-Host '桥接 / DSH 会在控制台里按普通权限重新拉起。'

$marker = Join-Path $stateDir 'admin-mode.json'
if (Test-Path $marker) { Remove-Item $marker -Force }
