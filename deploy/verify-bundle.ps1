#requires -version 7
<#
.SYNOPSIS
  Verify an unpacked GCIO bundle: required files present, every checksum matches.
.DESCRIPTION
  Run before applying anything. A bundle that fails here is corrupt or tampered
  with, and code-update.ps1 refuses to install it.
#>
[CmdletBinding()] param([string]$Dir = '.')
$ErrorActionPreference = 'Stop'

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
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $rel).Hash.ToLower()
    if ($got -ne $sum) { Write-Error "CHECKSUM FAIL: $path"; exit 1 }
    $checked++
  }
} finally { Pop-Location }

Write-Host "bundle OK: $Dir ($checked files verified)"
