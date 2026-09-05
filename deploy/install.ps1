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
  [switch]$SkipHealthGate,
  [switch]$SkipSqlPrecheck
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

  code-update.ps1 and Update-GCIO.cmd are on this list because the sentence
  above was aspirational until they were. They also ship BESIDE the archive,
  which is how a host with nothing bootstraps - but a host that had only ever
  been patched ended up with no updater at all, so `Update-GCIO.cmd -Rollback`,
  the command every refusal message names, did not exist where those messages
  tell operators to run it. Found on the live host after deploying 1.5.1.

  The copy below is guarded by Test-Path, which is what kept the gap silent: a
  file the artifact does not carry is skipped, the deploy still reports
  health=OK, and the host quietly never gains the script.
  deploy/test/host-tooling.test.ps1 drives a real installer run end to end so
  this list and the builders' $HostScripts cannot drift apart unnoticed again.
#>
function Install-GcioHostTooling {
  foreach ($f in 'install.ps1', 'install-service.ps1', 'uninstall.ps1',
                 'code-update.ps1', 'Update-GCIO.cmd', 'seal-secret.ps1', 'Grant-Role.cmd',
                 'VERSION', 'versions.json') {
    $src = Join-Path $Here $f
    if (Test-Path $src) { Copy-Item -Force $src (Join-Path $InstallDir $f) }
  }
  $lib = Join-Path $Here 'lib'
  if (Test-Path $lib) {
    $dst = Join-Path $InstallDir 'lib'
    if (Test-Path $dst) { Invoke-GcioFileOp { Remove-GcioTree $dst } }
    Copy-GcioTree -Source $lib -Destination $dst
  }
}

# NSSM, when this install has one. Needed to suppress AppExit=Restart across the
# overlay; absent on a rehearsal install, where the suppression is a no-op.
$NssmExe = Join-Path $InstallDir 'runtime\nssm.exe'
if (-not (Test-Path $NssmExe)) { $NssmExe = '' }

<#
  Stop the service and WAIT FOR IT TO ACTUALLY LET GO.

  `sc.exe stop` returns when the SCM accepts the request, not when the process
  has exited and released its socket. The previous version of this function was
  `sc.exe stop` plus `Start-Sleep 3`, and three seconds is a guess: if the app
  takes longer, the overlay writes new files underneath a process still serving
  from memory, and the health check that follows can be answered by the very
  process the patch was meant to replace - reporting health=OK having verified
  nothing.

  Two waits, in order. First the SCM must settle on Stopped rather than
  STOP_PENDING, because a stale STOP_PENDING can strand the later start. Then
  the port and any node process under this install must actually be gone.

  Returns the Wait-GcioCleanStop verdict. Clean=$false means something outside
  this install still holds the port, and the caller MUST NOT overlay.

  Service-control failures stay tolerated: a host with no service registered is
  a valid rehearsal case, and the health gate is the real arbiter either way.
#>
function Stop-GcioService {
  try { & sc.exe stop $ServiceName 2>&1 | Out-Null } catch { }
  [void](Wait-GcioServiceState -State 'Stopped' -ServiceName $ServiceName -TimeoutSec 30)
  # Scope the port probe to the address this install actually binds. Without
  # this the probe is unscoped and a neighbour's listener on the same port looks
  # like our own service failing to let go.
  return Wait-GcioCleanStop -InstallDir $InstallDir -Port $Port -GraceSec 12 -BindAddr (Get-GcioBindAddress -InstallDir $InstallDir)
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
  # Restoring files under a live process is the same race as overlaying under
  # one, so the same wait applies. A non-clean stop only warns here: this path
  # exists to recover a broken install, and refusing to recover because the
  # broken thing will not let go helps nobody.
  $stop = Stop-GcioService
  if (-not $stop.Clean) { Write-GcioWarn "stop was not clean ($($stop.Reason)) - restoring anyway, this is the recovery path" }
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

  <#
    SQL pre-check, BEFORE the first mutation.

    A bare health gate cannot catch this. /healthz reports process liveness and
    never consults the store, so a dead database looks identical to broken code:
    no answer, roll back, and an operator sent to read the service error log
    about a patch that was never the problem. This host has already had it - SQL
    crashed mid-deploy on 2026-08-28.

    Only a DEFINITIVE failure aborts. Anything the probe could not establish
    warns and proceeds, because a pre-check that blocks a deploy for being
    unable to run gets switched off permanently and then protects nobody.
  #>
  if (-not $SkipSqlPrecheck) {
    $sql = Test-GcioSqlReady -InstallDir $InstallDir
    if (-not $sql.Ok) {
      Stop-Gcio "PRE-CHECK FAILED: $($sql.Reason)`n`nNOTHING has been changed - this ran before the backup and before the service was stopped. Fix SQL, then re-run. Use -SkipSqlPrecheck to override."
    }
    if ($sql.Inconclusive) { Write-GcioWarn "SQL pre-check inconclusive (proceeding): $($sql.Reason)" }
    else { Write-GcioLog "SQL pre-check OK: $($sql.Reason)" }
  }

  <#
    Log length markers, taken BEFORE anything is touched. A service log
    accumulates across deploys, so on a failure only what THIS deploy wrote is
    worth showing - the rest sends an operator chasing a fault that stopped
    existing hours ago.
  #>
  $logDirPath = Join-Path $InstallDir 'logs'
  $sinceOut = Get-GcioLogLength (Join-Path $logDirPath 'service-out.log')
  $sinceErr = Get-GcioLogLength (Join-Path $logDirPath 'service-err.log')

  # Copy-backup while the old version is still serving: off the downtime clock.
  Backup-GcioAppCopy -InstallDir $InstallDir -Ts $Ts

  <#
    Suppress NSSM's auto-restart for the whole stop -> overlay -> start window.

    AppExit=Restart is armed at install so NSSM can self-heal a crash of the
    running app. Left armed here it does the opposite: it RESURRECTS the old
    application while its files are being replaced underneath it. The finally
    GUARANTEES restoration on every exit path - success, rollback, or a thrown
    overlay error - so a future crash is still self-healed.
  #>
  if ($NssmExe) { Set-GcioNssmAutoRestart -Nssm $NssmExe -Enabled:$false -ServiceName $ServiceName }
  try {
    $stop = Stop-GcioService
    if (-not $stop.Clean) {
      # Overlaying now is precisely how a health check ends up answered by the
      # process this patch was supposed to replace. Refuse instead - the backup
      # is a copy, so the install is still exactly as it was.
      Stop-Gcio "the service did not release port $Port cleanly: $($stop.Reason). NOTHING was overlaid - the install is unchanged. Find what is holding the port, then re-run."
    }
    if ($stop.Killed.Count) { Write-GcioWarn "force-killed leftover process(es): $($stop.Killed -join ', ')" }

    Copy-GcioPatchOverlay -PatchApp (Join-Path $Here 'app') -InstallApp (Join-Path $InstallDir 'app')
    Install-GcioHostTooling
  } finally {
    if ($NssmExe) { Set-GcioNssmAutoRestart -Nssm $NssmExe -Enabled:$true -ServiceName $ServiceName }
  }
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
  foreach ($l in (Show-GcioFailureLog -InstallDir $InstallDir -SinceOut $sinceOut -SinceErr $sinceErr -ProbeUrl $HealthUrl)) { Write-Host $l }
  $stop = Stop-GcioService
  if (-not $stop.Clean) { Write-GcioWarn "stop was not clean ($($stop.Reason)) - restoring anyway" }
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

  $logDirPath = Join-Path $InstallDir 'logs'
  $sinceOut = Get-GcioLogLength (Join-Path $logDirPath 'service-out.log')
  $sinceErr = Get-GcioLogLength (Join-Path $logDirPath 'service-err.log')

  if ($from -ne 'none') { Backup-GcioAppCopy -InstallDir $InstallDir -Ts $Ts }
  if ($NssmExe) { Set-GcioNssmAutoRestart -Nssm $NssmExe -Enabled:$false -ServiceName $ServiceName }
  $stop = Stop-GcioService
  if (-not $stop.Clean -and $from -ne 'none') {
    if ($NssmExe) { Set-GcioNssmAutoRestart -Nssm $NssmExe -Enabled:$true -ServiceName $ServiceName }
    Stop-Gcio "the service did not release port $Port cleanly: $($stop.Reason). NOTHING was replaced - the install is unchanged."
  }
  if ($stop.Killed.Count) { Write-GcioWarn "force-killed leftover process(es): $($stop.Killed -join ', ')" }

  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  foreach ($d in 'app', 'runtime') {
    $src = Join-Path $Here $d
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $InstallDir $d
      if (Test-Path $dst) { Invoke-GcioFileOp { Remove-GcioTree $dst -Activity "clearing $d" } }
    # robocopy, not Copy-Item: this is the second full pass over the same
    # ~17,000 files and Copy-Item pays the same per-file pipeline cost that
    # made the delete look like a hang. Falls back inside Copy-GcioTree.
    Copy-GcioTree -Source $src -Destination $dst -Activity "installing $d"
  }

  # Dependencies ship as ONE archive rather than 15,312 loose files, and are
  # expanded here on the host - a single sequential read instead of thousands of
  # scattered ones. A bundle carrying neither the archive nor a loose tree
  # cannot run, so that is a refusal rather than a warning: the alternative is a
  # service that starts, fails to resolve its first import, and rolls back with
  # a stack trace about a missing module instead of the actual cause.
  $nmZip = Join-Path $InstallDir 'app/node_modules.zip'
  $nmDir = Join-Path $InstallDir 'app/node_modules'
  if (Test-Path $nmZip) {
    Write-GcioLog 'expanding dependencies'
    if (Test-Path $nmDir) { Invoke-GcioFileOp { Remove-GcioTree $nmDir } }
    Expand-GcioArchive -Zip $nmZip -Dest $nmDir -Force -ProgressActivity 'expanding dependencies'
    # Removed once expanded: keeping it doubles the install's size on disk for
    # no purpose, and a stale copy would be re-expanded by the next install even
    # after the tree had been repaired by hand.
    Remove-Item -LiteralPath $nmZip -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $nmDir 'express'))) {
      Stop-Gcio 'dependencies did not expand - node_modules is incomplete and the service would not start.'
    }
  } elseif (-not (Test-Path $nmDir)) {
    Stop-Gcio 'the bundle carries neither node_modules.zip nor a node_modules tree - it cannot run.'
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
    foreach ($l in (Show-GcioFailureLog -InstallDir $InstallDir -SinceOut $sinceOut -SinceErr $sinceErr -ProbeUrl $HealthUrl)) { Write-Host $l }
    Stop-Gcio "the first install did not become healthy at $HealthUrl. Nothing was rolled back (there is no previous version)."
  }
  Write-GcioWarn 'health check FAILED - rolling back to the previous version'
  foreach ($l in (Show-GcioFailureLog -InstallDir $InstallDir -SinceOut $sinceOut -SinceErr $sinceErr -ProbeUrl $HealthUrl)) { Write-Host $l }
  $stop = Stop-GcioService
  if (-not $stop.Clean) { Write-GcioWarn "stop was not clean ($($stop.Reason)) - restoring anyway" }
  Restore-GcioApp -InstallDir $InstallDir -Ts $Ts
  Start-GcioService
  $back = Get-InstalledVersion
  Write-GcioDeployLog -InstallDir $InstallDir -Kind 'BUNDLE-ROLLBACK' -From $from -To $back -Extra 'health=FAIL'
  Stop-Gcio "the bundle failed its health check and was rolled back to $back. Check the service error log before re-running."
}

Stop-Gcio 'specify one of -Bundle, -Patch or -Rollback'
