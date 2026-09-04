<#
  Everything the composition root builds must actually reach the application.

  server/index.js assembles a `backends` object and hands it to createApp. It
  used to enumerate the keys, and a backend added to `backends` but not to that
  list was simply absent at runtime: no error, no warning, the feature just did
  not exist. That cost a live 403 - per-user role grants were wired end to end,
  tested, deployed, and never reached resolveAccess, so a user whose grant sat
  visibly in the database was refused.

  The unit tests cannot see this. Every one of them calls createApp directly
  with the deps it wants, which is exactly the step index.js was getting wrong.
  This gate sits outside that blind spot.

  It checks the SHIPPED artifact rather than the working tree, because the
  question is what runs on the host.
#>
$ErrorActionPreference = 'Stop'
$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

$repoRoot = Resolve-Path "$PSScriptRoot/../.."
$ver = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
$art = Get-ChildItem (Join-Path $repoRoot 'dist-bundle') -Directory -EA SilentlyContinue |
       Where-Object { $_.Name -like "gcio-patch-$ver-*" -or $_.Name -like "gcio-bundle-$ver-*" } |
       Sort-Object Name -Descending | Select-Object -First 1

$index = if ($art) { Join-Path $art.FullName 'app/server/index.js' } else { Join-Path $repoRoot 'server/index.js' }
$where = if ($art) { $art.Name } else { 'the working tree (no artifact for this version yet)' }
Check (Test-Path $index) "found server/index.js in $where"
if (-not (Test-Path $index)) { Write-Host "`n1 failed" -ForegroundColor Red; exit 1 }

$src = [IO.File]::ReadAllText($index)

# The structural guarantee: spreading cannot omit a key. Enumerating can, and did.
Check ($src -match '\.\.\.backends') 'index.js SPREADS backends into createApp rather than listing keys'

# And the failure this exists to prevent, named concretely so a reader knows why.
$names = @('userRoleMapping', 'searchDirectory', 'roleMapping', 'sessions', 'audit')
foreach ($n in $names) {
  Check ($src -match [Regex]::Escape($n)) "index.js still builds '$n'"
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
