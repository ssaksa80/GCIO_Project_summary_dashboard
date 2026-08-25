<#
.SYNOPSIS
    Installs (or reinstalls) GCIO Project Intelligence as a Windows service.

.DESCRIPTION
    Wraps `node server/index.js` with NSSM so Windows owns the lifecycle:
    auto-start at boot, restart on failure, rotated stdout/stderr logs.

    Run from an ELEVATED PowerShell prompt in the repository root:

        .\deploy\install-service.ps1 -EnvFile C:\gcio\.env

    Re-running is safe: an existing service is stopped and removed first, so
    this doubles as the upgrade path.

.PARAMETER EnvFile
    Path to the environment file. Every NAME=VALUE line is passed to the
    service. Keep it outside the repository, ACL'd to the service account —
    it holds the database password.

.PARAMETER ServiceAccount
    Optional domain account to run as, e.g. "EXAMPLE\svc-gcio". Required if you
    want Windows Integrated authentication to SQL Server; read the driver
    caveat in server/db/pool.js first, because the mssql driver's default
    transport does not implement it from `trustedConnection` alone.

.NOTES
    NSSM must be on PATH: https://nssm.cc/download
#>
[CmdletBinding()]
param(
    [string]$ServiceName = "GCIOProjectIntelligence",
    [string]$DisplayName = "GCIO Project Intelligence",
    [string]$EnvFile = "$PSScriptRoot\..\.env",
    [string]$NodeExe,
    [string]$ServiceAccount,
    [securestring]$ServicePassword
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------- checks ---

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    throw "This script must run from an elevated PowerShell prompt (Run as administrator)."
}

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
    throw "nssm was not found on PATH. Download it from https://nssm.cc/download and add it to PATH."
}

if (-not $NodeExe) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw "node was not found on PATH. Pass -NodeExe with the full path." }
    $NodeExe = $node.Source
}

$root = (Resolve-Path "$PSScriptRoot\..").Path
$entry = Join-Path $root "server\index.js"
$logDir = Join-Path $root "logs"

if (-not (Test-Path $entry)) { throw "server\index.js not found under $root." }
if (-not (Test-Path $EnvFile)) { throw "Environment file not found: $EnvFile" }

$clientBundle = Join-Path $root "client\dist\index.html"
if (-not (Test-Path $clientBundle)) {
    throw "The client is not built ($clientBundle is missing). Run: npm ci; npm run build"
}

# Read NAME=VALUE pairs, ignoring comments and blank lines.
$pairs = Get-Content $EnvFile |
    Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' -and $_ -notmatch '^\s*#' } |
    ForEach-Object { $_.Trim() }

if (-not $pairs) { throw "No NAME=VALUE lines found in $EnvFile." }

# Refuse the two configurations that must never reach a server.
$envMap = @{}
foreach ($line in $pairs) {
    $name, $value = $line -split '=', 2
    $envMap[$name.Trim()] = $value
}
if ($envMap['NODE_ENV'] -ne 'production') {
    Write-Warning "NODE_ENV is '$($envMap['NODE_ENV'])'. A server install should set NODE_ENV=production."
}
if ($envMap['AUTH_MODE'] -eq 'dev') {
    throw "AUTH_MODE=dev accepts any password. Refusing to install it as a service."
}
if ($envMap['STORE'] -eq 'memory') {
    Write-Warning "STORE=memory keeps the portfolio in process memory only; it is lost on restart."
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# ------------------------------------------------------------- reinstall ---

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Existing service found — stopping and removing it first."
    if ($existing.Status -ne 'Stopped') {
        Stop-Service -Name $ServiceName -Force
        $existing.WaitForStatus('Stopped', '00:00:30')
    }
    nssm remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 2
}

# --------------------------------------------------------------- install ---

nssm install $ServiceName $NodeExe $entry
nssm set $ServiceName DisplayName $DisplayName
nssm set $ServiceName Description "Executive portfolio dashboard: Excel ingestion, CIO sections, exports."
nssm set $ServiceName AppDirectory $root
nssm set $ServiceName AppStdout (Join-Path $logDir "service-out.log")
nssm set $ServiceName AppStderr (Join-Path $logDir "service-err.log")
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateOnline 1
nssm set $ServiceName AppRotateBytes 10485760
nssm set $ServiceName Start SERVICE_AUTO_START
nssm set $ServiceName AppExit Default Restart
nssm set $ServiceName AppRestartDelay 5000
nssm set $ServiceName AppStopMethodConsole 15000

# NSSM takes the environment as newline-separated NAME=VALUE pairs.
nssm set $ServiceName AppEnvironmentExtra ($pairs -join "`n")

if ($ServiceAccount) {
    if (-not $ServicePassword) { throw "-ServiceAccount also needs -ServicePassword." }
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ServicePassword))
    nssm set $ServiceName ObjectName $ServiceAccount $plain
    $plain = $null
    Write-Host "Service will run as $ServiceAccount."
}

Start-Service -Name $ServiceName
(Get-Service -Name $ServiceName) | Format-List Name, Status, StartType

# ---------------------------------------------------------------- verify ---

$port = if ($envMap['PORT']) { $envMap['PORT'] } else { '8123' }
Write-Host "`nWaiting for readiness on port $port ..."
$ready = $false
foreach ($attempt in 1..15) {
    Start-Sleep -Seconds 2
    try {
        $res = Invoke-WebRequest -Uri "http://127.0.0.1:$port/readyz" -UseBasicParsing -TimeoutSec 5
        if ($res.StatusCode -eq 200) { $ready = $true; break }
    } catch {
        # /readyz answers 503 until data is ingested, which is not a failure yet
        if ($_.Exception.Response.StatusCode.value__ -eq 503) { $ready = $true; break }
    }
}

if ($ready) {
    Write-Host "Service is answering on http://127.0.0.1:$port" -ForegroundColor Green
    Write-Host "Next: put IIS in front for TLS — see deploy\iis-site.md"
} else {
    Write-Warning "The service did not answer within 30 seconds. Check $logDir\service-err.log"
}
