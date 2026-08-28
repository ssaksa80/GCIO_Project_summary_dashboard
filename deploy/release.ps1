#requires -version 7
<#
.SYNOPSIS
  Bump, validate, commit and build a GCIO release in one command.

.DESCRIPTION
  Wraps the common case. It ADDS NO POLICY: it bumps the version, runs
  preflight-release.ps1 as the gate, commits the release marker on success, and
  builds whatever artifact the preflight named. You still choose the bump; the
  preflight only validates it, and REVERTS the bump if it refuses.

  It does not push, does not tag by default, and does not open the PR. Releases
  land through a PR like anything else.

.PARAMETER Bump
  patch, minor or major. See RELEASING.md - the tier is decided by
  compatibility, not by how big the change feels.

.PARAMETER DryRun
  Bump, validate, then revert. Changes nothing and commits nothing.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy/release.ps1 -Bump minor -Summary "document import"
#>
[CmdletBinding()] param(
  [Parameter(Mandatory)][ValidateSet('patch', 'minor', 'major')][string]$Bump,
  [Parameter(Mandatory)][string]$Summary,
  [switch]$DryRun,
  [switch]$NoBuild,
  [switch]$Tag
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here/lib/common.ps1"
$Repo = (Resolve-Path "$Here/..").Path

# Refuse to start on a dirty tree. A release commit must contain the version
# bump and nothing else, or the "release X.Y.Z" marker stops being a reliable
# base ref for the next preflight - and that ref decides what the next release
# is compared against.
$dirty = & git -C $Repo status --porcelain
if ($dirty) {
  Write-GcioWarn 'the working tree is not clean:'
  foreach ($l in $dirty) { Write-GcioWarn "  $l" }
  Stop-Gcio 'commit or stash first - a release commit must carry the version bump alone.'
}

$before = "$((Get-Content -Raw "$Repo/package.json" | ConvertFrom-Json).version)"
Write-GcioLog "bumping $Bump from $before"

Push-Location $Repo
try {
  npm version $Bump --no-git-tag-version | Out-Null
  if ($LASTEXITCODE) { Stop-Gcio "npm version failed (exit $LASTEXITCODE)" }
  $after = "$((Get-Content -Raw "$Repo/package.json" | ConvertFrom-Json).version)"
  Write-GcioLog "version is now $after"

  # Restore the tree exactly as found. Called on every failure path so a
  # refused release leaves nothing behind to explain.
  $revert = {
    Write-GcioWarn "reverting the bump $after -> $before"
    & git -C $Repo checkout -- package.json package-lock.json
  }

  $pfJson = & powershell -NoProfile -ExecutionPolicy Bypass -File "$Here/preflight-release.ps1" -Json 2>$null
  $verdict = $null
  try { $verdict = ($pfJson | Where-Object { $_ -match '^\{' } | Select-Object -First 1) | ConvertFrom-Json } catch { }
  if ($null -eq $verdict) {
    & $revert
    Stop-Gcio 'the preflight produced no verdict - run deploy/preflight-release.ps1 directly to see why. Nothing was committed.'
  }

  Write-GcioLog ("preflight: bump={0} migrations={1} deps={2} node={3} breaking={4} feat={5}" -f `
    $verdict.bump, $verdict.migrationsChanged, $verdict.depsChanged, $verdict.nodeChanged, $verdict.breaking, $verdict.featureAdded)

  if (-not $verdict.ok) {
    Write-GcioWarn "preflight REFUSED: $($verdict.reason)"
    & $revert
    Stop-Gcio 'release aborted by preflight. Nothing was committed and the version is unchanged.'
  }

  Write-GcioLog "preflight PASS - required artifact: $($verdict.artifact)"

  if ($DryRun) {
    & $revert
    Write-GcioLog 'dry run: the bump was reverted and nothing was committed.'
    exit 0
  }

  & git -C $Repo add package.json package-lock.json
  & git -C $Repo commit -m "release $after - $Summary" | Out-Null
  if ($LASTEXITCODE) { Stop-Gcio 'the release commit failed' }
  Write-GcioLog "committed: release $after - $Summary"

  if ($Tag) {
    & git -C $Repo tag "v$after"
    Write-GcioLog "tagged v$after (local only - this script does not push)"
  }

  if ($NoBuild) { Write-GcioLog 'stopping before the build (-NoBuild)'; exit 0 }

  $script = if ($verdict.artifact -eq 'patch') { 'build-patch.ps1' } else { 'build-bundle.ps1' }
  Write-GcioLog "building with $script"
  & pwsh -NoProfile -File "$Here/$script"
  if ($LASTEXITCODE) {
    # The commit stands: reverting it would leave the version and the release
    # marker disagreeing, which is worse than a missing artifact you can rebuild.
    Stop-Gcio "the build failed (exit $LASTEXITCODE). The release commit is made - fix the build and re-run deploy/$script."
  }
} finally { Pop-Location }

Write-GcioLog 'done. Verify the artifact, then open the release PR - this script does not push.'
