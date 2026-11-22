# Trust the local QQ Bridge code signing certificate for the CURRENT USER.
# This needs no administrator rights and is enough for the current Windows account.
# For all users, run the equivalent commands from an elevated shell against Cert:\LocalMachine.

[CmdletBinding()]
param(
    [string]$CerPath = (Join-Path $PSScriptRoot 'QQBridgeConsole-Local.cer')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $CerPath)) {
    throw "Certificate file not found: $CerPath"
}

$publicCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CerPath)
Write-Host "Certificate: $($publicCert.Subject)"
Write-Host "Thumbprint:  $($publicCert.Thumbprint)"

foreach ($storeName in @('Root', 'TrustedPublisher')) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $already = $store.Certificates | Where-Object { $_.Thumbprint -eq $publicCert.Thumbprint }
    if ($already) {
        Write-Host "Already present: Cert:\CurrentUser\$storeName"
    } else {
        $store.Add($publicCert)
        Write-Host "Added: Cert:\CurrentUser\$storeName"
    }
    $store.Close()
}

Write-Host 'Trust entries installed for the current user.'
