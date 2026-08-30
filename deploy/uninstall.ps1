#requires -version 5.1
<#
.SYNOPSIS
  Remove the GCIO Windows service, and optionally the application and its data.

.DESCRIPTION
  Three levels, each opt-in, because they are not comparable losses:

    (default)               stop and remove the service. Nothing on disk is
                            deleted. The application stays installed and can be
                            restarted by re-running install-service.ps1.

    -RemoveApp              also delete app\, runtime\, lib\, the host tooling
                            and the app.bak-* backups. KEEPS .env, the drop
                            folder, the vault, the audit directory and the
                            deploy log.

    -RemoveApp -PurgeData   also delete .env, data\, vault\, audit\ and logs\.

  The split is deliberate and differs from DEDB's single -Purge. app\ and
  runtime\ come back from any release artifact. The VAULT does not: it is the
  audit trail of every workbook ever ingested, and the only copy of those bytes.

  The SQL database is never touched at any level. The portfolio survives, and a
  fresh install pointed at the same database serves it again.

  Always prints the plan first. -PurgeData additionally requires -Force to run
  without a prompt.

.EXAMPLE
  .\uninstall.ps1                                 # service only
.EXAMPLE
  .\uninstall.ps1 -RemoveApp                      # service + application
.EXAMPLE
  .\uninstall.ps1 -RemoveApp -PurgeData -Force    # everything local
#>
[CmdletBinding()] param(
  [string]$InstallDir  = 'C:\gcio',
  [string]$ServiceName = 'GCIOProjectIntelligence',
  [switch]$RemoveApp,
  [switch]$PurgeData,
  [switch]$Force,
  [switch]$WhatIf
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$libCandidates = @("$Here\lib\common.ps1", "$Here\..\lib\common.ps1", "$InstallDir\lib\common.ps1")
$lib = $libCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $lib) { Write-Error "lib/common.ps1 not found (looked beside this script and in $InstallDir)"; exit 1 }
. $lib

<#
  Elevation is checked AFTER the plan is printed, not before.

  -WhatIf changes nothing, so demanding an elevated prompt to see what an
  uninstall would remove is a barrier with no safety value - and the answer is
  exactly what someone wants before deciding whether to elevate at all. The
  check sits below, immediately before the first thing that mutates.
#>
$plan = Get-GcioUninstallPlan -InstallDir $InstallDir -RemoveApp:$RemoveApp -PurgeData:$PurgeData
if (-not $plan.Valid) { Stop-Gcio $plan.Summary }

# ---------------------------------------------------------------- show the plan

Write-Host ''
Write-Host "GCIO uninstall - $InstallDir" -ForegroundColor Cyan
Write-Host "  $($plan.Summary)"
if ($plan.Paths.Count) {
  Write-Host ''
  Write-Host '  will delete:'
  foreach ($p in $plan.Paths) {
    $exists = @(Get-Item -Path $p -ErrorAction SilentlyContinue).Count -gt 0
    Write-Host ("    {0,-52} {1}" -f $p, $(if ($exists) { '' } else { '(not present)' }))
  }
}
if ($plan.Warnings.Count) {
  Write-Host ''
  foreach ($w in $plan.Warnings) { Write-GcioWarn $w }
}
Write-Host ''

if ($WhatIf) { Write-GcioLog '-WhatIf: nothing was changed.'; exit 0 }

# From here on everything mutates. Removing a service needs more than start/stop
# rights, so this one really does want elevation - but say so accurately.
$ctl = Test-GcioCanControlService -ServiceName $ServiceName
if (-not $ctl.Can) {
  Stop-Gcio "cannot control the Windows service ($($ctl.Why)). Run from an ELEVATED prompt. Nothing has been changed."
}

<#
  A state-destroying run must be deliberate. -Force is required rather than a
  prompt alone, so an automated invocation cannot destroy a vault by inheriting
  a default.
#>
if ($plan.DestroysState -and -not $Force) {
  Stop-Gcio 'this would destroy the vault and the drop folder. Re-run with -Force if that is genuinely what you want, or use -WhatIf to see the list again. Nothing has been changed.'
}

# ---------------------------------------------------------------- service

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  Write-GcioLog "stopping $ServiceName"
  try { & sc.exe stop $ServiceName 2>&1 | Out-Null } catch { }
  [void](Wait-GcioServiceState -State 'Stopped' -ServiceName $ServiceName -TimeoutSec 30)

  # Same wait the deploy path uses: a service that has stopped may still hold
  # its port and its process for a moment, and deleting files underneath one is
  # how a "clean" uninstall leaves a locked directory behind.
  $port = 0
  $envFile = Join-Path $InstallDir '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) { if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $port = [int]$Matches[1] } }
  }
  $stop = Wait-GcioCleanStop -InstallDir $InstallDir -Port $port -GraceSec 12 -BindAddr (Get-GcioBindAddress -InstallDir $InstallDir)
  if (-not $stop.Clean) { Write-GcioWarn "the service did not release cleanly: $($stop.Reason)" }
  if ($stop.Killed.Count) { Write-GcioWarn "force-killed leftover process(es): $($stop.Killed -join ', ')" }

  $nssm = Join-Path $InstallDir 'runtime\nssm.exe'
  if (Test-Path $nssm) {
    Write-GcioLog "removing the service with $nssm"
    try { & $nssm remove $ServiceName confirm 2>&1 | Out-Null } catch { }
  } else {
    Write-GcioLog 'removing the service with sc.exe (no bundled nssm found)'
    try { & sc.exe delete $ServiceName 2>&1 | Out-Null } catch { }
  }
  Start-Sleep 2
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-GcioWarn "$ServiceName still present - a reboot may be needed to clear it."
  } else {
    Write-GcioLog "service $ServiceName removed"
  }
} else {
  Write-GcioLog "no service named $ServiceName - nothing to remove"
}

# ---------------------------------------------------------------- files

$failed = @()
foreach ($p in $plan.Paths) {
  foreach ($item in @(Get-Item -Path $p -ErrorAction SilentlyContinue)) {
    try {
      Invoke-GcioFileOp { Remove-Item -LiteralPath $item.FullName -Recurse -Force }
      Write-GcioLog "removed $($item.FullName)"
    } catch {
      $failed += $item.FullName
      Write-GcioWarn "could not remove $($item.FullName): $($_.Exception.Message)"
    }
  }
}

Write-Host ''
if ($failed.Count) {
  Write-GcioWarn "$($failed.Count) path(s) could not be removed - something still holds them. A reboot usually clears it."
  exit 1
}

if ($plan.DestroysState) {
  Write-GcioLog 'uninstalled, and local state destroyed.'
  Write-GcioLog 'The SQL database was NOT touched - a fresh install pointed at it will serve the same portfolio.'
} elseif ($RemoveApp) {
  Write-GcioLog 'uninstalled. .env, the drop folder, the vault and the audit directory were kept.'
  Write-GcioLog 'Deploy a bundle and re-run install-service.ps1 to bring it back.'
} else {
  Write-GcioLog 'service removed. The application is still installed; re-run install-service.ps1 to start it again.'
}
exit 0
