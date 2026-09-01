#requires -version 7
<#
.SYNOPSIS
  Build a GCIO patch overlay: application code and built assets only.

.DESCRIPTION
  The PATCH tier artifact. It carries no node_modules and no runtime, which is
  what makes it small and fast to apply - and also what makes the four
  compatibility gates mandatory. A patch cannot bridge a dependency change, a
  Node major change, or a schema change, so patch-meta.json records the
  fingerprints the host checks before applying anything.

.PARAMETER MinBase
  The oldest installed version this overlay may be applied to. Defaults to
  <major>.<minor>.0 of the app version: a patch assumes everything its own
  MINOR shipped.
#>
[CmdletBinding()] param(
  [ValidateSet('win-x64')][string]$Os = 'win-x64',
  [string]$MinBase = '',
  [string]$Out
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here/lib/common.ps1"
$Repo = (Resolve-Path "$Here/..").Path
if (-not $Out) { $Out = Join-Path $Repo 'dist-bundle' }

$Ver = (Get-Content -Raw "$Repo/package.json" | ConvertFrom-Json).version
if (-not $Ver) { Stop-Gcio 'no version in package.json' }
if (-not $MinBase) { $v = [version]$Ver; $MinBase = "$($v.Major).$($v.Minor).0" }
$Name  = "gcio-patch-$Ver-$Os"
$Stage = Join-Path $Out $Name
Write-GcioLog "building $Name (minBase $MinBase)"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force "$Stage/app/client" | Out-Null

# ---------------------------------------------------------------- build
#
# The SPA build is the only slow step: no staged production install, no runtime
# fetch, no node_modules in the artifact. `npm ci` still runs, because a build
# against whatever happens to be in the developer's node_modules is not a
# reproducible release artifact. The FULL tree, deliberately - vite is a
# devDependency.

Write-GcioLog 'npm ci (full - the build needs devDependencies)'
Push-Location $Repo
try { npm ci; $ec = $LASTEXITCODE } finally { Pop-Location }
if ($ec) { Stop-Gcio "'npm ci' failed (exit $ec). Run 'npm install', commit the lockfile, then rebuild." }

Write-GcioLog 'build client'
Push-Location $Repo
try { npm run build; $ec = $LASTEXITCODE } finally { Pop-Location }
if ($ec) { Stop-Gcio "client build failed (exit $ec). Refusing to ship a stale client dist." }
if (-not (Test-Path "$Repo/client/dist/index.html")) { Stop-Gcio 'client build produced no dist/index.html.' }

# ---------------------------------------------------------------- stage

Write-GcioLog 'staging the app subset'
Copy-Item -Recurse -Force `
  "$Repo/server", "$Repo/shared", "$Repo/scripts", "$Repo/sample-data", `
  "$Repo/package.json", "$Repo/package-lock.json" "$Stage/app/"
Copy-Item -Recurse -Force "$Repo/client/dist" "$Stage/app/client/dist"

<#
  Host-side scripts a patch ships.

  Must stay in step with build-bundle.ps1's $HostScripts and with
  Install-GcioHostTooling in install.ps1, which is what copies them onto the
  host. They drifted once already: uninstall.ps1 was added to the bundle's list
  and to the installer's, but not here - so a patch had nothing to install, the
  deploy reported health=OK, and the host simply never gained the script.

  Missing STOPS the build, for the same reason the bundle's list does.
#>
$HostScripts = 'install.ps1', 'uninstall.ps1', 'code-update.ps1', 'Update-GCIO.cmd'
foreach ($f in $HostScripts) {
  if (-not (Test-Path "$Here/$f")) {
    Stop-Gcio "host script '$f' is on the patch ship list but is not in deploy/. Fix the name or remove it from `$HostScripts - do not let it silently not ship."
  }
  Copy-Item "$Here/$f" "$Stage/"
}
Copy-Item -Recurse -Force "$Here/lib" "$Stage/lib"

# The overlay must never carry node_modules: it would be enormous, and it would
# defeat the deps gate by silently replacing the installed tree.
if (Test-Path "$Stage/app/node_modules") {
  Stop-Gcio 'node_modules ended up in the patch stage - a patch overlay must never carry dependencies.'
}

# ---------------------------------------------------------------- meta

$nodeUrl = Get-GcioJsonValue "$Here/versions.json" "node.$Os.url"
if ($nodeUrl -match 'v(\d+)\.') { $nodeMajor = [int]$Matches[1] }
else { Stop-Gcio "cannot read the node major from versions.json ($nodeUrl)" }

$builtFrom = ''
try { $builtFrom = (& git -C $Repo rev-parse --short HEAD 2>$null) } catch { $builtFrom = '' }

$meta = New-GcioPatchMeta -AppDir "$Stage/app" -Version $Ver -NodeMajor $nodeMajor -MinBase $MinBase -BuiltFrom "$builtFrom"
$meta | ConvertTo-Json -Depth 6 | Out-File -Encoding ascii "$Stage/patch-meta.json"
$Ver | Out-File -Encoding ascii "$Stage/VERSION"
Write-GcioLog "meta: nodeMajor=$nodeMajor minBase=$MinBase builtFrom=$builtFrom"

# ---------------------------------------------------------------- checksums

Write-GcioLog 'writing checksums'
Push-Location $Stage
try {
  Get-ChildItem -Recurse -File | Where-Object { $_.Name -ne 'checksums.txt' } | Sort-Object FullName | ForEach-Object {
    $rel = Resolve-Path -Relative -LiteralPath $_.FullName
    "$(Get-GcioSha256 $_.FullName)  $rel"
  } | Out-File -Encoding utf8 'checksums.txt'
} finally { Pop-Location }

# Self-check before packing: if this artifact would not pass the host's own
# structural test, the build is what should fail, not the deploy.
if (-not (Test-GcioPatchComplete -Root $Stage)) {
  Stop-Gcio 'the staged patch does not satisfy Test-GcioPatchComplete - it would be refused on the host. Fix the staging above.'
}

Write-GcioLog 'packing archive'
Compress-Archive -Path $Stage -DestinationPath "$Out/$Name.zip" -Force

foreach ($f in 'code-update.ps1', 'Update-GCIO.cmd') {
  if (Test-Path "$Here/$f") { Copy-Item "$Here/$f" "$Out/" -Force }
}
Write-GcioLog "done -> $Out/$Name.zip"
