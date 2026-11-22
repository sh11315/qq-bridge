<#
.SYNOPSIS
  安装 WSL2 + Docker Desktop —— NapCat Docker 方案的前置条件。

.DESCRIPTION
  只启用 WSL 与 VirtualMachinePlatform（Docker Desktop 的 WSL2 后端够用，不启用完整 Hyper-V，
  少改系统、少冲突）。所有 DISM 都带 /norestart：**脚本自己绝不重启电脑**，何时重启由用户决定。

  执行顺序（2026-10-25 本机实测后定型）：
    1) DISM 启用 Microsoft-Windows-Subsystem-Linux + VirtualMachinePlatform（退出码 3010 = 需重启）
    2) 装 Docker Desktop：**curl 直连官方安装包 → SHA256 校验 → 静默安装**
       （实测本机：winget 会卡在 0 字节不下载；Invoke-WebRequest 走系统代理只有 0.16MB/s 且 EOF；
        curl 直连 11.5MB/s。所以直连优先，winget/IWR 只作回退）
    3) WSL 运行时**不在重启前装**：功能没生效时 `wsl --install` 会挂住不返回（实测 70s+，只能杀掉）。
       重启后由 scripts\napcat-docker-start.ps1 自动执行 `wsl --update` 补齐。

  日志：<项目根>\state\napcat-docker-install.log

  需要管理员权限。未提权时脚本会自动弹 UAC 重新拉起自己（请用户在弹窗点“是”）。
  装完必须重启电脑。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\napcat-docker-install.ps1
#>
[CmdletBinding()]
param(
  [switch]$Elevated,     # 内部用：已提权后的标志
  [switch]$SkipDocker,   # 只装 WSL2（排障用）
  [switch]$SkipWsl       # 只装 Docker
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $root 'state\napcat-docker-install.log'
New-Item -ItemType Directory -Path (Split-Path -Parent $logFile) -Force | Out-Null
$rebootReasons = New-Object System.Collections.Generic.List[string]

$DockerInstallerUrl = 'https://desktop.docker.com/win/main/amd64/244472/Docker%20Desktop%20Installer.exe'
$DockerInstallerSha = '3d8adad4f6c86583e0b00ea19a76197c51ccf5c83437c9ed775b739756452507'
$DockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$DownloadDir = Join-Path $root 'backups'

function Write-Log {
  param([string]$Message, [ValidateSet('INFO', 'WARN', 'ERROR', 'OK')][string]$Level = 'INFO')
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  $line = "[$stamp][$Level] $Message"
  switch ($Level) {
    'WARN'  { Write-Host $line -ForegroundColor Yellow }
    'ERROR' { Write-Host $line -ForegroundColor Red }
    'OK'    { Write-Host $line -ForegroundColor Green }
    default { Write-Host $line }
  }
  try { Add-Content -Path $logFile -Value $line -Encoding UTF8 } catch { }
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 未提权 → 用 UAC 重新拉起自己（请用户在弹出的窗口点“是”）
if (-not (Test-Admin) -and -not $Elevated) {
  Write-Host '[i] 需要管理员权限：正在请求 UAC 提权，请在弹出的窗口点“是”…' -ForegroundColor Cyan
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-Elevated')
  if ($SkipDocker) { $argList += '-SkipDocker' }
  if ($SkipWsl) { $argList += '-SkipWsl' }
  try {
    $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argList -Wait -PassThru
    exit $p.ExitCode
  } catch {
    Write-Host ('[x] 提权失败或被取消：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '    请右键“用 PowerShell 运行”本脚本并选择“以管理员身份运行”。'
    exit 1
  }
}

Write-Log '===== NapCat Docker 前置安装开始 ====='
$os = Get-CimInstance Win32_OperatingSystem
Write-Log ("用户：$env:USERNAME；管理员：$(Test-Admin)；系统：$($os.Caption) $($os.BuildNumber)")

# ---------------------------------------------------------------- 0. 环境探测
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Write-Log ("CPU：$($cpu.Name)；固件虚拟化：$($cpu.VirtualizationFirmwareEnabled)")
if (-not $cpu.VirtualizationFirmwareEnabled) {
  Write-Log 'CPU 固件虚拟化未开启：请先重启进 BIOS 打开 VT-x/AMD-V（Intel VT-x / SVM），否则 WSL2/Docker 无法运行。' 'ERROR'
  exit 2
}
$freeC = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
Write-Log "C 盘剩余 ${freeC}GB（Docker Desktop + WSL 发行版建议 ≥ 8GB）"
if ($freeC -lt 8) { Write-Log '磁盘偏紧，安装可能失败。' 'WARN' }

function Get-FeatureState([string]$Name) {
  try { (Get-WindowsOptionalFeature -Online -FeatureName $Name -ErrorAction Stop).State } catch { 'Unknown' }
}
$wslState = Get-FeatureState 'Microsoft-Windows-Subsystem-Linux'
$vmpState = Get-FeatureState 'VirtualMachinePlatform'
Write-Log "功能状态：WSL=$wslState，VirtualMachinePlatform=$vmpState"

# ---------------------------------------------------------------- 1. 启用功能
function Enable-Feature([string]$Name) {
  Write-Log "启用 Windows 功能 $Name（/norestart）…"
  $out = & dism.exe /online /enable-feature /featurename:$Name /all /norestart 2>&1
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    Write-Log "  $Name 已启用" 'OK'
  } elseif ($code -eq 3010) {
    Write-Log "  $Name 已启用，需重启生效" 'OK'
    $reason = "启用 $Name（dism 3010）"
    if (-not $rebootReasons.Contains($reason)) { $rebootReasons.Add($reason) }
  } else {
    $tail = (($out | Out-String).Trim() -split "`r?`n" | Select-Object -Last 6) -join ' | '
    Write-Log ("  启用 $Name 失败（dism 退出码 $code）：$tail") 'ERROR'
    throw "启用功能 $Name 失败"
  }
}

if (-not $SkipWsl) {
  if ($wslState -ne 'Enabled') { Enable-Feature 'Microsoft-Windows-Subsystem-Linux' } else { Write-Log 'WSL 功能已启用，跳过' }
  if ($vmpState -ne 'Enabled') { Enable-Feature 'VirtualMachinePlatform' } else { Write-Log 'VirtualMachinePlatform 已启用，跳过' }
  $rebootReasons.Add('WSL2 功能已启用，需重启才生效')
} else {
  Write-Log '按参数跳过 WSL 功能' 'WARN'
}

# ---------------------------------------------------------------- 2. WSL 运行时（重启后交给 start 脚本）
if (-not $SkipWsl) {
  Write-Log 'WSL 运行时不在重启前安装：功能未生效时 `wsl --install` / `wsl --update` 会挂住（实测 70s+ 无响应）。'
  Write-Log '  重启后 scripts\napcat-docker-start.ps1 会自动执行 `wsl --update` 补齐。'
}

# ---------------------------------------------------------------- 3. 装 Docker Desktop
if (-not $SkipDocker) {
  if (Test-Path $DockerExe) {
    Write-Log 'Docker Desktop 已安装（找到 docker.exe），跳过安装' 'OK'
  } else {
    New-Item -ItemType Directory -Path $DownloadDir -Force | Out-Null
    $installer = Join-Path $DownloadDir 'DockerDesktopInstaller-4.96.3.exe'
    $downloaded = $false

    # 3.1 curl 直连（本机实测最快；curl 不走系统代理，避免 0.16MB/s 的代理链路）
    if (Test-Path $installer) { Remove-Item $installer -Force -ErrorAction SilentlyContinue }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
      Write-Log '下载 Docker Desktop 安装包（curl 直连，约 612MB）…'
      & $curl.Source -L --fail -C - --retry 5 --retry-all-errors --retry-delay 2 -o $installer $DockerInstallerUrl
      if ($LASTEXITCODE -eq 0 -and (Test-Path $installer)) { $downloaded = $true }
      else { Write-Log ("curl 下载失败（退出码 $LASTEXITCODE），回退 winget") 'WARN' }
    }

    # 3.2 回退 winget（带 180s 超时；本机实测会卡在 0 字节）
    if (-not $downloaded) {
      $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
      if ($winget) {
        Write-Log '回退 winget 安装 Docker Desktop（最多等 180 秒）…' 'WARN'
        $p = Start-Process -FilePath $winget.Source -ArgumentList @(
          'install', '--id', 'Docker.DockerDesktop', '-e', '--silent',
          '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
        ) -PassThru -NoNewWindow
        try { $p | Wait-Process -Timeout 180 -ErrorAction Stop } catch { try { $p | Stop-Process -Force } catch { } }
        if (Test-Path $DockerExe) { $downloaded = $true; Write-Log 'winget 安装成功' 'OK' }
        else { Write-Log 'winget 未在 180 秒内装好，回退官网安装包' 'WARN' }
      }
    }

    # 3.3 最后回退 Invoke-WebRequest（慢但兼容）
    if (-not $downloaded -and -not (Test-Path $DockerExe)) {
      Write-Log '回退 Invoke-WebRequest 下载（可能较慢）…' 'WARN'
      try {
        Invoke-WebRequest -Uri $DockerInstallerUrl -OutFile $installer -TimeoutSec 900
        if (Test-Path $installer) { $downloaded = $true }
      } catch { Write-Log ('Invoke-WebRequest 失败：' + $_.Exception.Message) 'ERROR' }
    }

    # 3.4 校验 SHA256（内容必须是官方那份）
    if ($downloaded -and (Test-Path $installer)) {
      $hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
      if ($hash -eq $DockerInstallerSha) {
        Write-Log ("安装包 SHA256 校验通过（" + [math]::Round((Get-Item $installer).Length / 1MB, 1) + 'MB）') 'OK'
      } else {
        Write-Log "安装包 SHA256 不匹配（实际 $hash），拒绝执行；请检查下载源" 'ERROR'
        $downloaded = $false
      }
    }

    if ($downloaded) {
      Write-Log '静默安装 Docker Desktop（install --quiet --accept-license --backend=wsl-2）…'
      try {
        $p = Start-Process -FilePath $installer -ArgumentList @(
          'install', '--quiet', '--accept-license', '--backend=wsl-2'
        ) -Wait -PassThru -NoNewWindow
        Write-Log ("Docker 安装器退出码 " + $p.ExitCode + "（0=成功；3010=成功但需重启）")
        if ($p.ExitCode -eq 3010) {
          $reason = 'Docker Desktop 安装完成（3010，需重启）'
          if (-not $rebootReasons.Contains($reason)) { $rebootReasons.Add($reason) }
        }
      } catch {
        Write-Log ('运行安装器失败：' + $_.Exception.Message) 'ERROR'
      }
    }
  }

  if (Test-Path $DockerExe) { Write-Log 'Docker Desktop 已安装' 'OK' } else { Write-Log 'Docker Desktop 仍未安装成功' 'ERROR' }

  # 把当前用户加入 docker-users（已存在会报“已经是成员”，忽略）
  try {
    $g = Get-LocalGroup -Name 'docker-users' -ErrorAction SilentlyContinue
    if ($g) {
      & net.exe localgroup docker-users $env:USERNAME /add 2>&1 | Out-Null
      Write-Log "已确保 $env:USERNAME 在 docker-users 组"
    }
  } catch { Write-Log ('加入 docker-users 组失败（可忽略）：' + $_.Exception.Message) 'WARN' }
}

# ---------------------------------------------------------------- 4. 结论
Write-Log '===== 安装结果 ====='
Write-Log ("WSL 功能：" + (Get-FeatureState 'Microsoft-Windows-Subsystem-Linux') + "；VirtualMachinePlatform：" + (Get-FeatureState 'VirtualMachinePlatform'))
Write-Log ("docker.exe：" + $(if (Test-Path $DockerExe) { '已安装' } else { '缺失' }))
if ($rebootReasons.Count -gt 0) {
  Write-Log '需要重启电脑（关键步骤：不重启 WSL2 不可用、Docker 起不来）：' 'WARN'
  foreach ($r in $rebootReasons) { Write-Log ("  · " + $r) 'WARN' }
  Write-Log '请用户：保存工作 → 重启电脑 → 重启后运行 scripts\napcat-docker-start.ps1（会拉起 Docker Desktop、补 wsl --update、起容器、出登录二维码 PNG）。' 'WARN'
} else {
  Write-Log '本次没有产生新的“必须重启”项；仍建议重启一次让 Docker Desktop 完整初始化。' 'OK'
}
Write-Log '回滚：dism /online /disable-feature /featurename:Microsoft-Windows-Subsystem-Linux /featurename:VirtualMachinePlatform /norestart（再重启）；卸载 Docker 用“设置→应用”或 winget uninstall Docker.DockerDesktop。' 'INFO'
Write-Log ("日志：$logFile")
exit 0
