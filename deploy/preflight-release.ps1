#requires -version 5.1
<#
.SYNOPSIS
  Validate a release's version bump against what actually changed, and print
  the artifact that must be built.

.DESCRIPTION
  A fail-loud gate, run as the first step of a release. Re-runnable, and it
  never mutates anything.

  It reuses the SAME helpers the on-host patch gate uses -- Get-GcioLockDepsHash,
  Get-GcioMigrationsFingerprint, Get-GcioBumpType, Test-GcioReleaseBump -- so
  release time and deploy time cannot disagree about what a patch may carry. A
  gate that only exists on the host is one you discover at 2am; a gate that only
  exists at release time is one a hand-built artifact walks straight past.

  The tier is decided by COMPATIBILITY, not by "did code change". See
  RELEASING.md.

.PARAMETER BaseRef
  The previous release's git ref. Auto-detected when omitted, as the most
  recent commit whose SUBJECT is "release X.Y.Z ..." reachable from HEAD~1.

.PARAMETER Json
  Emit one machine-readable object. The exit code still signals pass/fail.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy/preflight-release.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File deploy/preflight-release.ps1 -BaseRef v1.5.0 -Json
#>
[CmdletBinding()] param(
  [string]$BaseRef = '',
  [switch]$Json
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here/lib/common.ps1"
$RepoPath = (Resolve-Path "$Here/..").Path

$PkgRel   = 'package.json'
$LockRel  = 'package-lock.json'
$MigRel   = 'server/db/migrations.js'
$VerRel   = 'deploy/versions.json'
$NotesRel = 'deploy/RELEASE-NOTES.md'

# What a patch overlay actually ships, per build-patch.ps1's staging step.
$PayloadPaths = @('server', 'shared', 'scripts', 'sample-data', 'client/src')

<#
  What build-patch.ps1 stages BESIDE the payload, plus what it places next to
  the archive. Deliberately not all of deploy/: the build scripts, deploy/test/
  and the docs never reach a host through a patch, so a feat touching only
  those must not force a MINOR.

  KEEP THIS IN STEP WITH build-patch.ps1. If that script starts shipping a
  different path, a feature touching it stops being detected here.
#>
$DeployScriptPaths = @('deploy/install.ps1', 'deploy/lib', 'deploy/code-update.ps1', 'deploy/Update-GCIO.cmd')

<#
  Write a path AS IT WAS at a ref to a temp file, byte for byte. Returns the
  temp path, or '' when the path did not exist at that ref. Caller deletes it.

  cmd redirection, NOT `$out = & git show ...`. Routing git's stdout through
  the PowerShell pipeline decodes it with the console output encoding, and on a
  non-UTF-8 codepage every multi-byte character comes back as several. That is
  not theoretical here: server/db/migrations.js contains four em dashes, three
  UTF-8 bytes each, and the pipeline version came back 7 characters longer than
  the identical file on disk. The result was migrationsChanged=True and
  depsChanged=True against a ref where `git diff` reports NO CHANGE and the
  blob hashes are identical - a preflight that would have demanded a bundle for
  every release forever, for a reason nothing on screen would explain.
#>
function Save-GcioBlobAtRef {
  param([string]$Ref, [string]$Path)
  & git -C $RepoPath cat-file -e "${Ref}:$Path" 2>$null
  if ($LASTEXITCODE -ne 0) { return '' }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('gcio-pf-' + [guid]::NewGuid().ToString('N') + '.tmp')
  & cmd /c "git -C ""$RepoPath"" show ""${Ref}:$Path"" > ""$tmp""" 2>$null
  if (-not (Test-Path $tmp)) { return '' }
  return $tmp
}

# Text of a path at a ref, decoded as UTF-8, or $null when absent. Used for the
# small JSON reads where only a version string is wanted.
function Get-GcioGitText {
  param([string]$Ref, [string]$Path)
  $tmp = Save-GcioBlobAtRef -Ref $Ref -Path $Path
  if (-not $tmp) { return $null }
  try { return [IO.File]::ReadAllText($tmp) } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

# Fingerprint a path AS IT WAS at a ref. Comparing fingerprints rather than
# `git diff --name-only` is what makes this agree with the host gate exactly -
# the host has no git, only two files to hash.
function Get-GcioFingerprintAtRef {
  param([string]$Ref, [string]$Path, [scriptblock]$Fingerprint)
  $tmp = Save-GcioBlobAtRef -Ref $Ref -Path $Path
  if (-not $tmp) { return '' }
  try { return (& $Fingerprint $tmp) } finally { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- base ref

if ([string]::IsNullOrWhiteSpace($BaseRef)) {
  $logLines = & git -C $RepoPath log --format='%H%x09%s' HEAD~1 2>$null
  $auto = Get-GcioReleaseCommitSha -LogLines $logLines
  if ([string]::IsNullOrWhiteSpace($auto)) {
    Stop-Gcio 'could not auto-detect the previous release commit - no subject matching "release X.Y.Z ..." is reachable from HEAD~1. Re-run with -BaseRef <ref>. On a first release, pass the commit the last deploy was cut from.'
  }
  $BaseRef = "$auto".Trim()
  Write-GcioLog "auto-detected previous-release base ref: $BaseRef"
}
& git -C $RepoPath rev-parse --verify --quiet "$BaseRef^{commit}" 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { Stop-Gcio "base ref '$BaseRef' is not a valid git commit." }

# ---------------------------------------------------------------- what changed

$headVer = "$((Get-Content -Raw (Join-Path $RepoPath $PkgRel) | ConvertFrom-Json).version)"
$baseVer = ''
$baseePkg = Get-GcioGitText -Ref $BaseRef -Path $PkgRel
if ($null -ne $baseePkg) { try { $baseVer = "$(($baseePkg | ConvertFrom-Json).version)" } catch { $baseVer = '' } }
$bump = Get-GcioBumpType -BaseVersion $baseVer -HeadVersion $headVer

$headMig = Get-GcioMigrationsFingerprint (Join-Path $RepoPath $MigRel)
$baseMig = Get-GcioFingerprintAtRef -Ref $BaseRef -Path $MigRel -Fingerprint { param($p) Get-GcioMigrationsFingerprint $p }
$migrationsChanged = ($headMig -ne $baseMig)

$headDeps = Get-GcioLockDepsHash (Join-Path $RepoPath $LockRel)
$baseDeps = Get-GcioFingerprintAtRef -Ref $BaseRef -Path $LockRel -Fingerprint { param($p) Get-GcioLockDepsHash $p }
$depsChanged = ($headDeps -ne $baseDeps)

$headNode = ''
try { $headNode = "$((Get-Content -Raw (Join-Path $RepoPath $VerRel) | ConvertFrom-Json).node.version)" } catch { $headNode = '' }
$baseNode = ''
$baseVersions = Get-GcioGitText -Ref $BaseRef -Path $VerRel
if ($baseVersions) { try { $baseNode = "$(($baseVersions | ConvertFrom-Json).node.version)" } catch { $baseNode = '' } }
# A versions.json absent at the base ref yields -1, so introducing the pinned
# runtime reads as a Node change and forces a bundle. That is correct rather
# than incidental: before versions.json there was no bundled runtime at all, so
# the first release that adds one cannot be a patch overlay - an overlay ships
# no runtime and there would be nothing on the host to overlay onto.
$nodeChanged = ((ConvertTo-GcioNodeMajor $headNode) -ne (ConvertTo-GcioNodeMajor $baseNode))

$breaking = Test-GcioBreakingMarker (((& git -C $RepoPath log --format=%B "$BaseRef..HEAD" 2>$null) -join "`n"))

$scanPaths = $PayloadPaths + $DeployScriptPaths
$subjects = & git -C $RepoPath log --format=%s "$BaseRef..HEAD" -- $scanPaths 2>$null
$featureAdded = Test-GcioFeatureMarker (($subjects -join "`n"))

# ---------------------------------------------------------------- decide

$decision = Test-GcioReleaseBump -Bump $bump -MigrationsChanged $migrationsChanged -DepsChanged $depsChanged `
                                 -NodeChanged $nodeChanged -Breaking $breaking -FeatureAdded $featureAdded

# Only demanded when this commit actually bumps the version, so re-running
# preflight on an ordinary commit stays clean.
$notesBody = ''
if (Test-Path (Join-Path $RepoPath $NotesRel)) { $notesBody = Get-Content -Raw (Join-Path $RepoPath $NotesRel) }
if ($bump -eq 'patch' -or $bump -eq 'minor' -or $bump -eq 'major') {
  $notes = Test-GcioReleaseNotes -Notes $notesBody -Version $headVer
} else {
  $notes = @{ Ok = $true; Reason = 'no version bump - release notes not required' }
}

# `ok` is the OVERALL verdict, not just the tier: release.ps1 gates the whole
# release on this one field, so a gate not folded in here is a gate that
# silently does nothing.
$overallOk = ($decision.Ok -and $notes.Ok)
$overallReason = $decision.Reason
if (-not $decision.Ok)   { $overallReason = $decision.Reason }
elseif (-not $notes.Ok)  { $overallReason = $notes.Reason }

if ($Json) {
  [pscustomobject]@{
    baseRef           = $BaseRef
    baseVersion       = $baseVer
    headVersion       = $headVer
    bump              = $bump
    migrationsChanged = $migrationsChanged
    depsChanged       = $depsChanged
    nodeChanged       = $nodeChanged
    breaking          = $breaking
    featureAdded      = $featureAdded
    bumpOk            = $decision.Ok
    notesOk           = $notes.Ok
    ok                = $overallOk
    reason            = $overallReason
    artifact          = $decision.Artifact
  } | ConvertTo-Json -Compress
} else {
  Write-GcioLog "base $BaseRef ($baseVer) -> HEAD ($headVer): bump = $bump"
  Write-GcioLog ("changed: migrations={0} deps={1} node={2} breaking={3} featureAdded={4}" -f `
    $migrationsChanged, $depsChanged, $nodeChanged, $breaking, $featureAdded)
  if ($decision.Ok) {
    Write-GcioLog "PASS - $($decision.Reason)"
    Write-GcioLog "required deploy artifact: $($decision.Artifact)"
    if ($notes.Ok) { Write-GcioLog "PASS - $($notes.Reason)" }
  }
}

if (-not $decision.Ok) { Stop-Gcio "release preflight FAILED ($bump bump): $($decision.Reason)" }
if (-not $notes.Ok)    { Stop-Gcio "release preflight FAILED ($bump bump): $($notes.Reason)" }
