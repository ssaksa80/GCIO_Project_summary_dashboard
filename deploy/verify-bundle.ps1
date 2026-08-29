#requires -version 5.1
<#
.SYNOPSIS
  Verify an unpacked GCIO bundle: required files present, every checksum matches.
.DESCRIPTION
  Run before applying anything. A bundle that fails here is corrupt or tampered
  with, and code-update.ps1 refuses to install it.
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
  $fh = Get-Command Get-FileHash -ErrorAction SilentlyContinue
  if ($fh) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLower() }
  $sha = [Security.Cryptography.SHA256]::Create()
  $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    ($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join ''
  } finally { $fs.Dispose(); $sha.Dispose() }
}

if (-not (Test-Path "$Dir/checksums.txt")) { Write-Error "no checksums.txt in $Dir"; exit 1 }

# A bundle is defined by what it can do that a patch cannot: carry dependencies
# and a runtime. Both are required here.
$need = 'app/server/index.js', 'app/package-lock.json', 'app/node_modules',
        'app/client/dist/index.html', 'install.ps1', 'lib/common.ps1',
        'runtime/node/node.exe', 'VERSION', 'versions.json'
foreach ($p in $need) {
  if (-not (Test-Path (Join-Path $Dir $p))) { Write-Error "MISSING: $p"; exit 1 }
}

Push-Location $Dir
try {
  $checked = 0
  foreach ($line in (Get-Content -Encoding utf8 'checksums.txt')) {
    if (-not $line.Trim()) { continue }
    $sum, $path = $line -split '\s+', 2
    if ($path -eq './checksums.txt' -or $path -eq '.\checksums.txt') { continue }
    # -LiteralPath: node_modules ships fixtures whose names contain wildcard
    # metacharacters, which a positional path would glob to something else.
    $rel = $path -replace '^\.[\/]', ''
    if (-not (Test-Path -LiteralPath $rel)) { Write-Error "MISSING (listed in checksums): $path"; exit 1 }
    $got = Get-FileSha256Compat $rel
    if ($got -ne $sum) { Write-Error "CHECKSUM FAIL: $path"; exit 1 }
    $checked++
  }
} finally { Pop-Location }

Write-Host "bundle OK: $Dir ($checked files verified)"
