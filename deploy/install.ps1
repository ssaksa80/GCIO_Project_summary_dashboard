#requires -version 5.1
<#
.SYNOPSIS
  Install, patch, or roll back GCIO Project Intelligence.

.DESCRIPTION
  Run from inside an unpacked artifact (code-update.ps1 does that for you).

    -Bundle    full install or upgrade: app, dependencies and runtime
    -Patch     app-only overlay: gated, health-gated, auto-rollback on failure
    -Rollback  revert to the most recent app.bak-*

  The ORDER inside -Patch is the design, not an accident:

    gates -> copy-backup -> stop -> overlay -> start -> health -> rollback?

  Gates run first so a refusal changes nothing and there is nothing to undo.
  The backup is a COPY taken while the old version is still serving, so it
  costs no downtime. Only then does anything stop.

.PARAMETER SkipHealthGate
  Apply without waiting for health, and without the rollback that depends on
  it. For rehearsal on a host with no service registered; never in production.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Patch
#>
[CmdletBinding(DefaultParameterSetName = 'Bundle')]
param(
  [Parameter(ParameterSetName = 'Bundle')]   [switch]$Bundle,
  [Parameter(ParameterSetName = 'Patch')]    [switch]$Patch,
  [Parameter(ParameterSetName = 'Rollback')] [switch]$Rollback,
  [string]$InstallDir  = 'C:\gcio',
  [string]$ServiceName = 'GCIOProjectIntelligence',
  [int]$Port = 0,
  [switch]$SkipHealthGate
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here/lib/common.ps1"

# The .env's PORT is the real source of truth; -Port overrides for a rehearsal
# install on a scratch directory.
if ($Port -le 0) {
  $Port = 8130
  $envFile = Join-Path $InstallDir '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $Port = [int]$Matches[1] }
    }
  }
}
$HealthUrl = "http://127.0.0.1:$Port/healthz"
$Ts = Get-Date -Format 'yyyyMMdd-HHmmss'

function Get-InstalledVersion {
  $p = Join-Path $InstallDir 'app\package.json'
  if (Test-Path $p) { return "$((Get-Content -Raw $p | ConvertFrom-Json).version)" }
  return 'none'
}

<#
  Put the host-side tooling ON the host, beside the app.

  Without this the install has no install.ps1 and no lib/common.ps1, so
  `Update-GCIO.cmd -Rollback` has nothing to call and a rollback is impossible
  the moment the release folder is gone or a later artifact has replaced it. A
  rollback has to work when no artifact is present, which is exactly the
  situation after a bad deploy.

  Refreshed by a patch as well as a bundle, so the tooling on the host never
  lags the artifact that last touched it.
#>
function Install-GcioHostTooling {
  foreach ($f in 'install.ps1', 'install-service.ps1', 'VERSION', 'versions.json') {
    $src = Join-Path $Here $f
    if (Test-Path $src) { Copy-Item -Force $src (Join-Path $InstallDir $f) }
  }
  $lib = Join-Path $Here 'lib'
  if (Test-Path $lib) {
    $dst = Join-Path $InstallDir 'lib'
    if (Test-Path $dst) { Invoke-GcioFileOp { Remove-Item -Recurse -Force $dst } }
    Copy-Item -Recurse -Force $lib $dst
  }
}

# Service control through sc.exe rather than nssm: the service is NSSM-managed,
# but sc.exe speaks to the SCM directly and needs no path to nssm.exe. Failures
# are tolerated -- a host with no service registered is a valid rehearsal case,
# and the health gate is the real arbiter of success either way.
function Stop-GcioService {
  try { & sc.exe stop $ServiceName 2>&1 | Out-Null } catch { }
  Start-Sleep 3
}
function Start-GcioService {
  try { & sc.exe start $ServiceName 2>&1 | Out-Null } catch { }
}

<#
  Wait for the app to answer healthily.

  Bails early on a service that keeps landing back on Stopped: that is not a
  slow boot, it is a crash loop, and burning the full two minutes to conclude
  the same thing only delays the rollback.
#>
function Wait-GcioHealthy {
  param([int]$Tries = 60, [int]$DelaySec = 2)
  $downStreak = 0
  for ($i = 0; $i -lt $Tries; $i++) {
    if (Test-GcioHealth -Url $HealthUrl) { return $true }
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Stopped') { $downStreak++ } else { $downStreak = 0 }
    if ($downStreak -ge 5) {
      Write-GcioWarn 'the service keeps returning to Stopped - not waiting out the full timeout'
      return $false
    }
    Start-Sleep $DelaySec
  }
  return $false
}

# ---------------------------------------------------------------- rollback

if ($Rollback) {
  $stamps = @(Get-GcioBackups -InstallDir $InstallDir)
  if (-not $stamps.Count) { Stop-Gcio "no backup to roll back to in $InstallDir" }
  $from = Get-InstalledVersion
  Write-GcioLog "rolling back to app.bak-$($stamps[0])"
  Stop-GcioService
  Restore-GcioApp -InstallDir $InstallDir -Ts $stamps[0]
  Start-GcioService
  $to = Get-InstalledVersion
  Write-GcioDeployLog -InstallDir $InstallDir -Kind 'ROLLBACK' -From $from -To $to
  Write-GcioLog "rolled back -> $to"
  exit 0
}

# ---------------------------------------------------------------- patch

if ($Patch) {
  # Structure before compatibility: a truncated download or a half-extracted
  # zip should say so plainly rather than surfacing as a confusing verdict
  # about versions.
  if (-not (Test-GcioPatchComplete -Root $Here)) {
    Stop-Gcio 'this does not look like a complete patch artifact (files missing, or it carries a runtime and is actually a bundle). Nothing has been changed. Re-extract it and run verify-patch.ps1 first.'
  }

  # THE GATES. Before any mutation, so a refusal leaves the install untouched.
  $compat = Test-GcioPatchCompatible -PatchRoot $Here -InstallDir $InstallDir
  if (-not $compat.Ok) {
    foreach ($line in (Format-GcioPatchRefusal -Compat $compat)) { Write-GcioWarn $line }
    exit 1
  }

  $oldVer = $compat.Installed
  $newVer = $compat.PatchVersion
  Write-GcioLog "patching GCIO $oldVer -> $newVer (dependencies and schema verified; node_modules and runtime preserved)"

  # Copy-backup while the old version is still serving: off the downtime clock.
  Backup-GcioAppCopy -InstallDir $InstallDir -Ts $Ts

  Stop-GcioService
  Copy-GcioPatchOverlay -PatchApp (Join-Path $Here 'app') -InstallApp (Join-Path $InstallDir 'app')
  Install-GcioHostTooling
  Start-GcioService

  if ($SkipHealthGate) {
    Write-GcioWarn 'health gate skipped (-SkipHealthGate): this patch was applied WITHOUT verification and will NOT auto-roll-back'
    Write-GcioDeployLog -InstallDir $InstallDir -Kind 'PATCH' -From $oldVer -To $newVer -Extra "backup=app.bak-$Ts health=SKIPPED"
    exit 0
  }

  Write-GcioLog 'health check (allowing time for first boot)'
  if (Wait-GcioHealthy) {
    Remove-OldGcioBackups -InstallDir $InstallDir -Keep 3
    Write-GcioDeployLog -InstallDir $InstallDir -Kind 'PATCH' -From $oldVer -To $newVer -Extra "backup=app.bak-$Ts health=OK"
    Write-GcioLog "OK - GCIO healthy at $HealthUrl"
    exit 0
  }

  Write-GcioWarn 'health check FAILED - rolling back to the previous version'
  Stop-GcioService
  Restore-GcioApp -InstallDir $InstallDir -Ts $Ts
  Start-GcioService
  $back = Get-InstalledVersion
  Write-GcioDeployLog -InstallDir $InstallDir -Kind 'PATCH-ROLLBACK' -From $oldVer -To $back -Extra 'health=FAIL'
  Stop-Gcio "the patch failed its health check and was rolled back to $back. Check the service error log before re-running."
}

# ---------------------------------------------------------------- bundle

if ($Bundle) {
  $from = Get-InstalledVersion
  Write-GcioLog "installing the full bundle into $InstallDir (from $from)"

  if ($from -ne 'none') { Backup-GcioAppCopy -InstallDir $InstallDir -Ts $Ts }
  Stop-GcioService

  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  foreach ($d in 'app', 'runtime') {
    $src = Join-Path $Here $d
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $InstallDir $d
    if (Test-Path $dst) { Invoke-GcioFileOp { Remove-Item -Recurse -Force $dst } }
    Copy-Item -Recurse -Force $src $dst
  }

  Install-GcioHostTooling

  # Migrations are applied at BOOT by the app itself (server/index.js); there is
  # deliberately no separate migration step here. What keeps that safe is the
  # patch gate: a schema change cannot arrive on an overlay, only inside a
  # bundle an operator chose to install.
  Start-GcioService

  $to = Get-InstalledVersion
  if ($SkipHealthGate) {
    Write-GcioWarn 'health gate skipped (-SkipHealthGate)'
    Write-GcioDeployLog -InstallDir $InstallDir -Kind 'BUNDLE' -From $from -To $to -Extra 'health=SKIPPED'
    Write-GcioLog "installed $to"
    exit 0
  }

  Write-GcioLog 'health check (allowing time for first boot)'
  if (Wait-GcioHealthy) {
    Remove-OldGcioBackups -InstallDir $InstallDir -Keep 3
    Write-GcioDeployLog -InstallDir $InstallDir -Kind 'BUNDLE' -From $from -To $to -Extra "health=OK"
    Write-GcioLog "OK - GCIO $to healthy at $HealthUrl"
    exit 0
  }

  if ($from -eq 'none') {
    # Nothing to roll back to: a first install that will not start is a
    # configuration problem, and pretending otherwise by deleting the install
    # only destroys the evidence.
    Stop-Gcio "the first install did not become healthy at $HealthUrl. Nothing was rolled back (there is no previous version). Check the service error log and .env."
  }
  Write-GcioWarn 'health check FAILED - rolling back to the previous version'
  Stop-GcioService
  Restore-GcioApp -InstallDir $InstallDir -Ts $Ts
  Start-GcioService
  $back = Get-InstalledVersion
  Write-GcioDeployLog -InstallDir $InstallDir -Kind 'BUNDLE-ROLLBACK' -From $from -To $back -Extra 'health=FAIL'
  Stop-Gcio "the bundle failed its health check and was rolled back to $back. Check the service error log before re-running."
}

Stop-Gcio 'specify one of -Bundle, -Patch or -Rollback'
