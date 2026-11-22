<#
.SYNOPSIS
  取 NapCat（Framework/Shell 通用）当前登录二维码，生成可直接用手机 QQ 扫的 PNG。

.DESCRIPTION
  流程：
    1) 调控制台 7788 的 `POST /api/napcat/qrcode`（可选 refresh=true 让 NapCat 重新出码）；
    2) 拿到二维码内容（https://txz.qq.com/p?k=...）；
    3) 调二维码渲染服务生成 PNG，存到 state\napcat-framework-qr.png；
    4) 在控制台打印 URL 与图片路径。

  说明：控制台本身只返回二维码“内容”（URL），不返回图片；NapCat 的 WebUI 是网页里画码，
  所以这里用公开的 QR 渲染接口出图。渲染失败时会退回只打印 URL（可粘到浏览器/二维码工具）。

.PARAMETER Refresh
  先让 NapCat 刷新一次二维码（旧码过期时用）。

.PARAMETER Size
  图片边长（像素），默认 520。

.PARAMETER OutFile
  输出 PNG 路径，默认 <项目根>\state\napcat-framework-qr.png。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-show-qr.ps1 -Refresh
#>
[CmdletBinding()]
param(
  [switch]$Refresh,
  [int]$Size = 520,
  [string]$OutFile = ''
)

if (-not $OutFile) { $OutFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'state\napcat-framework-qr.png' }
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tokenFile = Join-Path $root 'state\console-token'
if (-not (Test-Path $tokenFile)) { Write-Host "[x] 找不到 $tokenFile" -ForegroundColor Red; exit 2 }
$token = (Get-Content $tokenFile -Raw).Trim()

$body = if ($Refresh) { '{"refresh":true}' } else { '{}' }
try {
  $r = Invoke-RestMethod -Uri 'http://127.0.0.1:7788/api/napcat/qrcode' -Method Post `
    -Headers @{ 'x-console-token' = $token } -ContentType 'application/json' -Body $body -TimeoutSec 30
} catch {
  Write-Host ("[x] 控制台/ NapCat 不可达：" + $_.Exception.Message) -ForegroundColor Red
  exit 3
}

if (-not $r.ok -or -not $r.qrcode) {
  Write-Host ("[x] 取二维码失败：" + ($r.message | Out-String)) -ForegroundColor Red
  exit 4
}

$url = [string]$r.qrcode
Write-Host ("[i] 二维码内容：" + $url)
Write-Host ("[i] 提示：" + $r.message)

$encoded = [uri]::EscapeDataString($url)
$render = "https://api.qrserver.com/v1/create-qr-code/?size=${Size}x${Size}&margin=12&data=$encoded"
try {
  Invoke-WebRequest -Uri $render -OutFile $OutFile -TimeoutSec 30 | Out-Null
  $len = (Get-Item $OutFile).Length
  Write-Host ("[ok] 已生成图片：" + $OutFile + "（" + $len + " B）") -ForegroundColor Green
} catch {
  Write-Host ("[!] 出图失败（" + $_.Exception.Message + "）：把上面的 URL 粘到浏览器或二维码工具里即可") -ForegroundColor Yellow
  exit 5
}
Write-Host '[i] 用手机 QQ 扫码登录机器人账号；二维码约 2 分钟过期，过期重新跑一次（加 -Refresh）。'
exit 0
