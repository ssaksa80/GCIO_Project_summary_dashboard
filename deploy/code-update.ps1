#requires -version 5.1
<#
.SYNOPSIS
  Expand whichever GCIO artifact sits beside this script, verify it, and apply it.

.DESCRIPTION
  The operator-facing entry point. Drop a gcio-bundle-*.zip or gcio-patch-*.zip
  next to this file and run it; it works out which tier it is holding and hands
  off to that artifact's own install.ps1.

  This script ships OUTSIDE the archive, beside it. It is what expands the
  archive, so it cannot live inside the thing it unzips.

.PARAMETER InstallDir
  Where GCIO is installed. Defaults to C:\gcio.

.PARAMETER Rollback
  Revert to the most recent backup, using the INSTALLED install.ps1 rather than
  anything in an artifact - a rollback must work even when no artifact is
  present, which is exactly the situation after a bad deploy.

.EXAMPLE
  .\Update-GCIO.cmd
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File code-update.ps1 -Rollback
#>
[CmdletBinding()] param(
  [string]$InstallDir = 'C:\gcio',
  [switch]$Rollback,
  [int]$Port = 0,
  [switch]$SkipHealthGate
)
# Continue, NOT Stop: sc.exe and nssm write benign noise to stderr during a
# slow boot, and under Stop that aborts a run that is going perfectly well. Real
# signals are exit codes, the health check, and the reported version.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Info { param([string]$M) Write-Host "[gcio] $M" }
function Fail { param([string]$M) Write-Host "[FAIL] $M" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- rollback

if ($Rollback) {
  $installed = Join-Path $InstallDir 'install.ps1'
  if (-not (Test-Path $installed)) {
    Fail "no install.ps1 in $InstallDir - cannot roll back. A rollback uses the INSTALLED installer, which a bundle places there."
  }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $installed -Rollback -InstallDir $InstallDir
  exit $LASTEXITCODE
}

# ---------------------------------------------------------------- find it

<#
  Files copied from another machine carry a mark-of-the-web zone marker, and
  RemoteSigned then refuses to run them ("not digitally signed"). Unblocking
  the ZIP before extraction also stops the marker propagating to every file
  inside it.

  NOTE: a blocked copy of THIS script cannot unblock itself. Update-GCIO.cmd
  ships beside it for exactly that bootstrap.
#>
Get-ChildItem $Here -Filter '*.zip' -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

$zips = @(Get-ChildItem $Here -Filter 'gcio-*-win-x64.zip' -ErrorAction SilentlyContinue)
if (-not $zips.Count) {
  Fail "no gcio-bundle-*.zip or gcio-patch-*.zip found beside $Here. Copy the release artifact next to this script and run it again."
}
if ($zips.Count -gt 1) {
  # Refuse rather than guess. "Newest by name" would happily pick a patch over
  # the bundle an operator meant to install, and they would not find out until
  # the gates refused it - or worse, until they did not.
  Info 'more than one artifact is present:'
  foreach ($z in $zips) { Info "  $($z.Name)" }
  Fail 'leave exactly one gcio-*.zip beside this script so there is nothing to guess.'
}

$zip = $zips[0]
$isPatch = $zip.Name -like 'gcio-patch-*'
$kind = if ($isPatch) { 'patch' } else { 'bundle' }
Info "found $($zip.Name) -> $($kind.ToUpper())"

# ---------------------------------------------------------------- expand

$dest = Join-Path $Here $zip.BaseName
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Info "expanding to $dest"
Expand-Archive -Path $zip.FullName -DestinationPath $Here -Force
if (-not (Test-Path $dest)) { Fail "expected $dest after extraction but it is not there - the archive may be truncated." }

# ---------------------------------------------------------------- verify

# The verifier may sit beside this script or inside the artifact. Prefer
# whichever exists, and NEVER silently skip: an unverified artifact is exactly
# what checksums.txt exists to prevent.
$verifier = @("$Here\verify-$kind.ps1", "$dest\verify-$kind.ps1") |
  Where-Object { Test-Path $_ } | Select-Object -First 1

if ($verifier) {
  Info "verifying with $(Split-Path $verifier -Leaf)"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $verifier -Dir $dest
  if ($LASTEXITCODE -ne 0) {
    Fail 'the artifact failed verification - refusing to apply it. Re-copy the release and try again.'
  }
} else {
  Write-Warning "[gcio] no verify-$kind.ps1 found beside the artifact or inside it - applying UNVERIFIED"
}

# ---------------------------------------------------------------- apply

$installer = Join-Path $dest 'install.ps1'
if (-not (Test-Path $installer)) { Fail "no install.ps1 inside $dest - this artifact is incomplete." }

# NOT $args: that is an automatic variable in PowerShell. Assigning to it is
# legal but shadows the caller's arguments in ways that bite much later.
$installArgs = @('-InstallDir', $InstallDir)
if ($Port -gt 0)      { $installArgs += @('-Port', "$Port") }
if ($SkipHealthGate)  { $installArgs += '-SkipHealthGate' }
if ($isPatch) { $installArgs += '-Patch' } else { $installArgs += '-Bundle' }

Info "applying: install.ps1 $($installArgs -join ' ')"
& powershell -NoProfile -ExecutionPolicy Bypass -File $installer @installArgs
$rc = $LASTEXITCODE

if ($rc -ne 0) {
  Write-Host ''
  Info "the installer exited $rc."
  Info 'A refused patch changed NOTHING - read the reason above and use the full bundle.'
  Info 'A failed health check has already rolled back. To revert by hand:  Update-GCIO.cmd -Rollback'
}
exit $rc
