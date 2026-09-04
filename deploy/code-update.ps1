#requires -version 5.1
<#
.SYNOPSIS
  The single command that installs or updates GCIO on a host.

.DESCRIPTION
  Drop a gcio-bundle-*.zip or gcio-patch-*.zip beside this script and run it.
  It works out which tier it is holding, verifies it, and applies it - the same
  command for a first install, an upgrade, or a patch.

  Modelled on DEDB's code-update.ps1, and deliberately step-numbered the same
  way so an operator moving between the two systems reads the same shape:

    0/4  pre-flight      elevation, mark-of-the-web, outer package, artifact choice
    1/4  version gate    already-installed / downgrade guards
    2/4  apply           verify, then install.ps1 (health-gated, auto-rollback)
    3/4  verify          service, version, port, health - read back from the host
    4/4  done

  DEDB's steps for a database backup, an explicit migration runner and cutoff
  settings have no GCIO equivalent: GCIO applies migrations at boot and has no
  settings table. Their absence is deliberate, not an omission - see
  docs/dedb-packaging-gap-analysis.md.

  This script ships OUTSIDE the archive, beside it: it is what expands the
  archive, so it cannot live inside the thing it unzips.

.PARAMETER Force
  Re-apply the same version, or allow a downgrade. Without it, both are refused
  having changed nothing.

.PARAMETER Rollback
  Revert to the most recent backup using the installer ON THE HOST, so it works
  when no artifact is present - which is the situation after a bad deploy.

.EXAMPLE
  .\Update-GCIO.cmd
.EXAMPLE
  .\Update-GCIO.cmd -Rollback
#>
[CmdletBinding()] param(
  [string]$InstallDir = 'C:\gcio',
  [switch]$Rollback,
  [switch]$Force,
  [int]$Port = 0,
  [switch]$SkipHealthGate,
  [switch]$SkipSqlPrecheck
)
# Continue, NOT Stop: sc.exe and nssm write benign noise to stderr during a slow
# boot, and under Stop that aborts a run that is going perfectly well. Real
# signals are exit codes, the health check, and the reported version.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# The decision logic lives in lib/common.ps1 so it can be tested without
# elevation or a service; this script is the shell around it. lib/ sits beside
# this script in a release folder, or inside the artifact once expanded.
$libCandidates = @("$Here\lib\common.ps1", "$Here\..\lib\common.ps1")
$lib = $libCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($lib) { . $lib }

# Extraction must not become the thing that needs lib/. Before this script used
# Expand-GcioArchive it called Expand-Archive, a built-in that is always there;
# making the fast path mandatory would turn a missing lib/ from a degraded run
# into a failed one. If the shared function is absent, fall straight back to the
# built-in - slower, and it works.
if (-not (Get-Command Expand-GcioArchive -ErrorAction SilentlyContinue)) {
  function Expand-GcioArchive {
    param([Parameter(Mandatory)][string]$Zip, [Parameter(Mandatory)][string]$Dest,
          [switch]$Force, [scriptblock]$FastExtractor)
    Expand-Archive -LiteralPath $Zip -DestinationPath $Dest -Force
  }
}

function Step { param([string]$N, [string]$M) Write-Host "`n===== $N  $M =====" -ForegroundColor Cyan }
function Info { param([string]$M) Write-Host "[gcio] $M" }
function Ok   { param([string]$M) Write-Host "[ok] $M" -ForegroundColor Green }
function Warn2{ param([string]$M) Write-Host "[warn] $M" -ForegroundColor Yellow }
function Fail { param([string]$M) Write-Host "[FAIL] $M" -ForegroundColor Red; exit 1 }

function To-Ver { param([string]$S) try { return [version]($S -replace '[^0-9.]', '') } catch { return [version]'0.0.0' } }
function Get-ArtifactVersion { param([string]$Name)
  if ($Name -match 'gcio-(?:patch|bundle)-(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
  return [version]'0.0.0' }
function Get-InstalledVer {
  $p = Join-Path $InstallDir 'app\package.json'
  if (Test-Path $p) { try { return "$((Get-Content -Raw $p | ConvertFrom-Json).version)" } catch { return '?' } }
  return 'none'
}

# =================================================================== 0/4

Step '0/4' 'Pre-flight'

# Checked HERE rather than discovered three steps in as a confusing service
# failure. The test is the CAPABILITY, not the role: a service descriptor can
# grant start/stop to a named account, and demanding elevation from a session
# that already holds the right refuses work it can perfectly well do.
$ctl = Test-GcioCanControlService -ServiceName 'GCIOProjectIntelligence'
if (-not $ctl.Can) {
  Fail "cannot control the Windows service ($($ctl.Why)). Run from an ELEVATED prompt, or grant this account start/stop on the service. Nothing has been changed."
}
Ok $ctl.Why

<#
  Files copied from another machine carry a mark-of-the-web zone marker, and
  RemoteSigned then refuses to run them. Unblocking the ZIP before extraction
  also stops the marker propagating to every file inside it.

  A blocked copy of THIS script cannot unblock itself - Update-GCIO.cmd ships
  beside it for exactly that bootstrap.
#>
Get-ChildItem $Here -Filter '*.zip' -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

# ---- rollback needs nothing else ----
if ($Rollback) {
  $installed = Join-Path $InstallDir 'install.ps1'
  if (-not (Test-Path $installed)) {
    Fail "no install.ps1 in $InstallDir - cannot roll back. A rollback uses the INSTALLED installer, which a bundle places there."
  }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $installed -Rollback -InstallDir $InstallDir
  exit $LASTEXITCODE
}

<#
  Outer package. One zip per release can carry the artifact plus this updater
  and docs; operators do copy the whole thing across without unzipping it. When
  no loose artifact is present, expand every GCIO-*.zip that is not itself an
  artifact and surface what it contains beside us, so the normal detection just
  works.
#>
function Get-LooseArtifacts { param([string]$Dir)
  @(Get-ChildItem $Dir -Filter 'gcio-patch-*.zip' -ErrorAction SilentlyContinue) +
  @(Get-ChildItem $Dir -Filter 'gcio-bundle-*.zip' -ErrorAction SilentlyContinue) }

if (-not (Get-LooseArtifacts $Here)) {
  $pkgs = @(Get-ChildItem $Here -Filter 'GCIO-*.zip' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch '^gcio-(patch|bundle)-' })
  foreach ($pkg in $pkgs) {
    $ex = Join-Path $Here ('_pkg-' + [IO.Path]::GetFileNameWithoutExtension($pkg.Name))
    Info "auto-extracting package $($pkg.Name)"
    try {
      if (Test-Path $ex) { Remove-Item -Recurse -Force $ex }
      Expand-GcioArchive -Zip $pkg.FullName -Dest $ex -Force
    } catch { Warn2 "could not extract $($pkg.Name): $($_.Exception.Message)"; continue }
    $inner = @(Get-ChildItem $ex -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^gcio-(patch|bundle)-.*\.zip$' })
    foreach ($z in $inner) { Copy-Item -LiteralPath $z.FullName -Destination $Here -Force; Info "  found $($z.Name)" }
    if (-not $inner) { Warn2 "  no gcio-patch/gcio-bundle inside $($pkg.Name)" }
  }
}

# ---- choose the artifact ----
$all = @(Get-LooseArtifacts $Here)
if (-not $all.Count) {
  Fail "no gcio-bundle-*.zip or gcio-patch-*.zip found beside $Here. Copy the release artifact next to this script and run it again."
}

<#
  Arbitration, not refusal. A release folder can legitimately hold both tiers,
  and DEDB's rule is the right one: THE BUNDLE WINS when its version is at
  least the newest patch's. A bundle can do everything a patch can and more, so
  preferring it is never the less-capable choice - and picking the patch
  instead would risk applying an overlay to a base the operator meant to
  replace wholesale.
#>
$decision = Select-GcioArtifact -Names @($all | ForEach-Object { $_.Name })
if (-not $decision) { Fail "found files beside this script but none is a gcio-bundle-*/gcio-patch-* artifact." }
Info "chose: $($decision.Reason)"
$chosen = $all | Where-Object { $_.Name -eq $decision.Name } | Select-Object -First 1

$zip = $chosen
$isPatch = $zip.Name -like 'gcio-patch-*'
$kind = if ($isPatch) { 'patch' } else { 'bundle' }
$artifactVer = Get-ArtifactVersion $zip.Name
Ok "$($zip.Name) -> $($kind.ToUpper()) $artifactVer"

# =================================================================== 1/4

Step '1/4' 'Version gate'

$current = Get-InstalledVer
$cv = To-Ver $current
$tv = $artifactVer
Info "artifact $artifactVer  |  installed $current  |  install dir $InstallDir"

$gate = Test-GcioVersionGate -Installed $current -Artifact "$artifactVer" -Force ([bool]$Force)
if (-not $gate.Proceed) {
  if ($gate.Code -eq 'same-version') { Ok $gate.Message; exit 0 }
  Fail $gate.Message
}
Info $gate.Message

# =================================================================== 2/4

Step '2/4' "Apply the $kind"

$dest = Join-Path $Here $zip.BaseName
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Info "expanding to $dest"
Expand-GcioArchive -Zip $zip.FullName -Dest $Here -Force
if (-not (Test-Path $dest)) { Fail "expected $dest after extraction but it is not there - the archive may be truncated." }

# The verifier may sit beside this script or inside the artifact. Prefer
# whichever exists, and NEVER silently skip: an unverified artifact is exactly
# what checksums.txt exists to prevent.
$verifier = @("$Here\verify-$kind.ps1", "$dest\verify-$kind.ps1") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if ($verifier) {
  Info "verifying with $(Split-Path $verifier -Leaf)"
  & powershell -NoProfile -ExecutionPolicy Bypass -File $verifier -Dir $dest
  if ($LASTEXITCODE -ne 0) { Fail 'the artifact failed verification - refusing to apply it. Re-copy the release and try again.' }
  Ok 'checksums verified'
} else {
  Warn2 "no verify-$kind.ps1 found beside the artifact or inside it - applying UNVERIFIED"
}

$installer = Join-Path $dest 'install.ps1'
if (-not (Test-Path $installer)) { Fail "no install.ps1 inside $dest - this artifact is incomplete." }

# NOT $args: that is an automatic variable in PowerShell. Assigning to it is
# legal but shadows the caller's arguments in ways that bite much later.
$installArgs = @('-InstallDir', $InstallDir)
if ($Port -gt 0)     { $installArgs += @('-Port', "$Port") }
if ($SkipHealthGate)  { $installArgs += '-SkipHealthGate' }
if ($SkipSqlPrecheck) { $installArgs += '-SkipSqlPrecheck' }
if ($isPatch) { $installArgs += '-Patch' } else { $installArgs += '-Bundle' }

Info "install.ps1 $($installArgs -join ' ')"
& powershell -NoProfile -ExecutionPolicy Bypass -File $installer @installArgs
$rc = $LASTEXITCODE

if ($rc -ne 0) {
  Write-Host ''
  Warn2 "the installer exited $rc."
  Info 'A refused patch changed NOTHING - read the reason above and use the full bundle.'
  Info 'A failed health check has already rolled back. To revert by hand:  Update-GCIO.cmd -Rollback'
  exit $rc
}
Ok "$kind applied"

# =================================================================== 3/4

Step '3/4' 'Verify'

<#
  Read the outcome back FROM THE HOST rather than trusting that the installer
  said it worked. An operator should be able to see, in one place, what version
  is installed, what the service is doing, and what the app itself reports.
#>
$after = Get-InstalledVer
$svc = Get-Service -Name 'GCIOProjectIntelligence' -ErrorAction SilentlyContinue
$svcState = if ($svc) { "$($svc.Status)" } else { 'not installed' }

$p = $Port
if ($p -le 0) {
  $p = 8130
  $envFile = Join-Path $InstallDir '.env'
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) { if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $p = [int]$Matches[1] } }
  }
}

Write-Host ("  installed version : {0}" -f $after)
Write-Host ("  service           : {0}" -f $svcState)
Write-Host ("  port              : {0}" -f $p)

$body = ''
try { $body = (Invoke-WebRequest -Uri "http://127.0.0.1:$p/healthz" -TimeoutSec 5 -UseBasicParsing).Content } catch { $body = '' }
Write-Host ("  /healthz          : {0}" -f $(if ($body) { ($body -replace "`0", '') } else { '(no answer)' }))
try { $r = (Invoke-WebRequest -Uri "http://127.0.0.1:$p/readyz" -TimeoutSec 5 -UseBasicParsing).Content } catch { $r = '(no answer)' }
Write-Host ("  /readyz           : {0}" -f ($r -replace "`0", ''))

$listener = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host ("  listener          : {0}" -f $(if ($listener) { "PID $($listener.OwningProcess) on $($listener.LocalAddress)" } else { 'none' }))

# The version the artifact claimed must be the version the host now reports.
# Anything else means the overlay did not land where it was supposed to.
if ($after -ne "$artifactVer") {
  Warn2 "the host reports $after but the artifact was $artifactVer - the overlay may not have landed. Check $InstallDir\logs\deploy.log."
}

# =================================================================== 4/4

Step '4/4' 'Done'
if ($body -match '"status"\s*:\s*"ok"') {
  Ok "GCIO $after is serving on http://127.0.0.1:$p"
  Info "deploy log: $InstallDir\logs\deploy.log"
} else {
  Warn2 "GCIO $after is installed but did not answer /healthz."
  Info "Check $InstallDir\logs\service-err.log - and note it can hold OLD traces from a previous failed deploy, so check timestamps."
  Info "To revert:  Update-GCIO.cmd -Rollback"
  exit 1
}
exit 0
