#requires -version 5.1
<#
.SYNOPSIS
  Verify an unpacked GCIO patch overlay.
.DESCRIPTION
  Checks the required files, every checksum, and - critically - that this is
  actually a patch. An artifact carrying a runtime is a full bundle, and
  applying a bundle through the patch path would overlay code while leaving the
  old node_modules and runtime in place.
#>
[CmdletBinding()] param([string]$Dir = '.')
$ErrorActionPreference = 'Stop'

<#
  SHA-256 of one file, without depending on Get-FileHash being available.

  This script runs standalone beside an artifact, so it cannot source
  lib/common.ps1 and has to carry its own. Get-FileHash arrived in PowerShell
  4.0 and is normally present -- but it was missing in one real deploy account,
  and the only symptom was "the artifact failed verification", which blames the
  artifact and sends the operator to re-copy a release that was never wrong.

  -LiteralPath / FileShare::ReadWrite so a name containing wildcard
  metacharacters hashes, and a file another process holds open still reads.
#>
function Get-FileSha256Compat {
  param([Parameter(Mandatory)][string]$Path)
  # Resolve to a FULL path before anything else. Push-Location moves PowerShell's
  # location; it does not move [Environment]::CurrentDirectory, and that is what
  # [IO.File]::Open resolves a relative path against - so the .NET fallback below
  # read from the process's start directory instead of the artifact.
  #
  # Invisible on any host that has Get-FileHash, because that cmdlet uses
  # PowerShell's location and the fallback never runs. On a host without it every
  # file in the artifact "does not exist", and the verifier's verdict is "the
  # artifact failed verification - re-copy the release", which blames the release
  # and sends the operator to redo the one thing that was never wrong. Seen on a
  # live deploy account, which is the only place this branch had ever executed.
  $full = (Resolve-Path -LiteralPath $Path).ProviderPath
  # GCIO_FORCE_DOTNET_SHA exists so the fallback is reachable in a test on a host
  # that HAS the cmdlet. Without a seam this branch is only ever exercised by the
  # deploy that it breaks, which is exactly how the bug above shipped.
  $fh = Get-Command Get-FileHash -ErrorAction SilentlyContinue
  if ($fh -and -not $env:GCIO_FORCE_DOTNET_SHA) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $full).Hash.ToLower() }
  $sha = [Security.Cryptography.SHA256]::Create()
  $fs = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    ($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join ''
  } finally { $fs.Dispose(); $sha.Dispose() }
}

if (-not (Test-Path "$Dir/checksums.txt"))   { Write-Error "no checksums.txt in $Dir"; exit 1 }
if (-not (Test-Path "$Dir/patch-meta.json")) { Write-Error "no patch-meta.json in $Dir - this cannot be verified as a patch"; exit 1 }

# The tier check. Somebody handed us the wrong artifact.
if (Test-Path "$Dir/runtime/node/node.exe") {
  Write-Error 'runtime present - this is a full bundle, not a patch. Install it with -Bundle.'
  exit 1
}
# A patch must NOT carry dependencies: shipping them would silently bypass the
# deps gate by replacing the installed tree.
if (Test-Path "$Dir/app/node_modules") {
  Write-Error 'app/node_modules present - a patch overlay must not carry dependencies.'
  exit 1
}

$need = 'app/server/index.js', 'app/package-lock.json', 'app/client/dist/index.html',
        'install.ps1', 'lib/common.ps1', 'patch-meta.json', 'VERSION'
foreach ($p in $need) {
  if (-not (Test-Path (Join-Path $Dir $p))) { Write-Error "MISSING: $p"; exit 1 }
}

<#
  A 0-100% counter on ONE line.

  Long steps here go silent for minutes: verifying a bundle hashes ~2,000 files,
  expanding dependencies takes ~3.5 minutes, clearing an unpack walks 17,000. An
  operator watching a still cursor cannot tell work from a hang, and has not been
  able to - a deploy was reported as "stuck" while it was in fact part way
  through deleting 17,244 files, and a verify pass looks identical to a wedged
  process for its entire run.

  Rewrites in place with a carriage return when a console is attached, and falls
  back to one line per 10% when output is redirected, so a captured log gets 11
  lines rather than 2,000 - or a single line stuffed with control characters.
#>
$script:GcioProgressKey  = ''
$script:GcioProgressLast = -1
function Test-GcioConsole {
  # .NET 4.5. Guarded because this runs on hosts old enough to lack Get-FileHash,
  # where being wrong costs nothing but cosmetics.
  try { return -not [Console]::IsOutputRedirected } catch { return $false }
}
function Write-GcioProgress {
  param(
    [Parameter(Mandatory)][string]$Activity,
    [Parameter(Mandatory)][int]$Done,
    [Parameter(Mandatory)][int]$Total
  )
  if ($Total -le 0) { return }
  if ($Activity -ne $script:GcioProgressKey) {
    $script:GcioProgressKey = $Activity; $script:GcioProgressLast = -1
  }
  $pct = [int](100 * $Done / $Total)
  if ($pct -gt 100) { $pct = 100 }
  # 2077 of 2087 rounds to 100 and printed a second, identical-looking final
  # line. 100% means finished, so hold at 99 until it actually is.
  $final = ($Done -ge $Total)
  if ($pct -ge 100 -and -not $final) { $pct = 99 }
  if ($pct -eq $script:GcioProgressLast -and -not $final) { return }
  $script:GcioProgressLast = $pct
  $bar  = ('#' * [int]($pct / 5)).PadRight(20, '.')
  $line = "[gcio] {0} [{1}] {2,3}%  ({3}/{4})" -f $Activity, $bar, $pct, $Done, $Total
  if (Test-GcioConsole) {
    Write-Host ("`r" + $line) -NoNewline
    if ($final) { Write-Host '' }
  } elseif ($final -or ($pct % 10) -eq 0) {
    Write-Host $line
  }
}

Push-Location $Dir
try {
  $checked = 0
  # Materialised so the total is known before hashing starts. Get-Content streams,
  # and a percentage needs a denominator.
  $lines = @(Get-Content -Encoding utf8 'checksums.txt')
  $seen  = 0
  foreach ($line in $lines) {
    $seen++
    Write-GcioProgress -Activity 'verifying' -Done $seen -Total $lines.Count
    if (-not $line.Trim()) { continue }
    $sum, $path = $line -split '\s+', 2
    if ($path -eq './checksums.txt' -or $path -eq '.\checksums.txt') { continue }
    $rel = $path -replace '^\.[\/]', ''
    if (-not (Test-Path -LiteralPath $rel)) { Write-Error "MISSING (listed in checksums): $path"; exit 1 }
    $got = Get-FileSha256Compat $rel
    if ($got -ne $sum) { Write-Error "CHECKSUM FAIL: $path"; exit 1 }
    $checked++
  }
} finally { Pop-Location }

Write-Host "patch OK: $Dir ($checked files verified)"
