# Sign QQBridgeConsole.exe with the local self-signed code signing certificate.
# The certificate and its trust entries live in the CURRENT USER stores, so no UAC is needed.
# Safe to re-run after launcher.cs is rebuilt: it replaces the signature, never the code.

[CmdletBinding()]
param(
    [string]$ExePath = 'C:\qq-bridge\desktop-app\QQBridgeConsole.exe',
    [string]$Thumbprint = '9479DAD7966D395D6338BBE6933977B9F5B2DD77',
    [string]$TimestampServer = 'http://timestamp.digicert.com',
    [switch]$NoTimestamp
)

$ErrorActionPreference = 'Stop'

function Stop-WithError([string]$Message) {
    Write-Error $Message
    exit 1
}

if (-not (Test-Path -LiteralPath $ExePath)) {
    Stop-WithError "EXE not found: $ExePath"
}

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
    Where-Object { $_.Thumbprint -eq $Thumbprint } |
    Select-Object -First 1
if (-not $cert) {
    Stop-WithError "Code signing certificate not found in Cert:\CurrentUser\My (thumbprint $Thumbprint)."
}
if (-not $cert.HasPrivateKey) {
    Stop-WithError "Certificate $Thumbprint has no private key in the current user profile."
}

$inRoot = Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $Thumbprint }
$inTrustedPublisher = Get-ChildItem Cert:\CurrentUser\TrustedPublisher | Where-Object { $_.Thumbprint -eq $Thumbprint }
if (-not $inRoot -or -not $inTrustedPublisher) {
    Write-Warning "Certificate is not trusted in CurrentUser Root/TrustedPublisher; the signature will not show as trusted. Run Install-Trust.ps1 first."
}

# Refuse to write while the launcher is running: Windows keeps the image open for writing.
try {
    $stream = [System.IO.File]::Open($ExePath, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $stream.Close()
} catch {
    Stop-WithError "EXE is locked (close QQBridgeConsole.exe first): $($_.Exception.Message)"
}

$before = Get-Item -LiteralPath $ExePath
Write-Host ("Signing {0} ({1} bytes, mtime {2:o})" -f $ExePath, $before.Length, $before.LastWriteTime)

$params = @{
    FilePath      = $ExePath
    Certificate   = $cert
    HashAlgorithm = 'SHA256'
}
if (-not $NoTimestamp -and $TimestampServer) {
    $params['TimestampServer'] = $TimestampServer
}

try {
    $setResult = Set-AuthenticodeSignature @params
    Write-Host "Set-AuthenticodeSignature: $($setResult.Status)"
} catch {
    Write-Warning "Signing with timestamp failed: $($_.Exception.Message)"
    if ($NoTimestamp) { throw }
    Write-Warning "Retrying without a timestamp..."
    $setResult = Set-AuthenticodeSignature -FilePath $ExePath -Certificate $cert -HashAlgorithm SHA256
    Write-Host "Set-AuthenticodeSignature (no timestamp): $($setResult.Status)"
}

$verify = Get-AuthenticodeSignature -FilePath $ExePath
Write-Host "Status: $($verify.Status)"
Write-Host "Message: $($verify.StatusMessage)"
if ($verify.SignerCertificate) {
    Write-Host "Signer: $($verify.SignerCertificate.Subject)"
    Write-Host "Thumbprint: $($verify.SignerCertificate.Thumbprint)"
}
if ($verify.TimeStamperCertificate) {
    Write-Host "Timestamp: $($verify.TimeStamperCertificate.Subject)"
}
Write-Host ("SHA256: " + (Get-FileHash -LiteralPath $ExePath -Algorithm SHA256).Hash)

# 重要：本机把 qq-bridge-full 目录整体标成了 Low 完整性，新编译的 exe 会继承该标签。
# Windows 会按文件标签以“低完整性”启动 launcher，Edge 随之变成低完整性、无法创建
# renderer，控制台窗口就只剩白页。因此每次签名后都把 exe 的强制完整性标签改回 Medium。
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
& $icacls $ExePath /setintegritylevel Medium | Out-Null
$labelInfo = (& $icacls $ExePath) | Select-String 'Mandatory Label'
if ($labelInfo) {
    Write-Host "Integrity: $($labelInfo.Line.Trim())"
} else {
    Write-Warning 'Could not read the mandatory integrity label of the EXE.'
}

if ($verify.Status -ne 'Valid') {
    Stop-WithError "Signature verification failed: $($verify.Status)"
}
Write-Host 'OK: Authenticode signature is Valid.'
