#requires -version 7
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

Push-Location $Dir
try {
  $checked = 0
  foreach ($line in (Get-Content -Encoding utf8 'checksums.txt')) {
    if (-not $line.Trim()) { continue }
    $sum, $path = $line -split '\s+', 2
    if ($path -eq './checksums.txt' -or $path -eq '.\checksums.txt') { continue }
    $rel = $path -replace '^\.[\/]', ''
    if (-not (Test-Path -LiteralPath $rel)) { Write-Error "MISSING (listed in checksums): $path"; exit 1 }
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $rel).Hash.ToLower()
    if ($got -ne $sum) { Write-Error "CHECKSUM FAIL: $path"; exit 1 }
    $checked++
  }
} finally { Pop-Location }

Write-Host "patch OK: $Dir ($checked files verified)"
