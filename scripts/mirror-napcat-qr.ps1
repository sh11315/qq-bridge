# Mirror NapCat live login QR to state\napcat-login-qr.png (and a 4x upscale), refresh every 10s.
# 用法：pwsh -File scripts\mirror-napcat-qr.ps1 -Minutes 20 -NapCatShellDir "D:\napcat\shell-4.18.38"
# 不传 -NapCatShellDir 时默认用包根下的 napcat\shell-4.18.38（本包未内置 NapCat，需你自行放置）。
param([int]$Minutes = 20, [string]$NapCatShellDir = '')
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $NapCatShellDir) { $NapCatShellDir = Join-Path $root 'napcat\shell-4.18.38' }
$src = Join-Path $NapCatShellDir 'napcat\cache\qrcode.png'
$stateDir = Join-Path $root 'state'
$dstLive = Join-Path $stateDir 'napcat-login-qr.png'
$dst4x = Join-Path $stateDir 'napcat-login-qr-4x.png'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
$deadline = (Get-Date).AddMinutes($Minutes)
$lastStamp = ''
while ((Get-Date) -lt $deadline) {
  if (Test-Path $src) {
    $stamp = (Get-Item $src).LastWriteTime.ToString('HHmmss') + ':' + (Get-Item $src).Length
    if ($stamp -ne $lastStamp) {
      Copy-Item $src $dstLive -Force
      if ($py) {
        try { & $py -c "from PIL import Image; im=Image.open(r'$src').convert('RGB'); im.resize((im.width*4, im.height*4), Image.NEAREST).save(r'$dst4x')" | Out-Null } catch { }
      }
      $lastStamp = $stamp
    }
  }
  Start-Sleep -Seconds 10
}
