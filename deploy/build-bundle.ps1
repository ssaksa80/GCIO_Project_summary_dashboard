#requires -version 7
<#
.SYNOPSIS
  Build a full GCIO bundle: application, production dependencies, pinned Node
  runtime, NSSM, and the host-side installers.

.DESCRIPTION
  The MINOR/MAJOR tier artifact. Unlike a patch overlay it carries node_modules
  and a runtime, so it can bridge a dependency change, a Node major change, or
  a schema change that an overlay must refuse.

.PARAMETER SkipRuntimeFetch
  Build without downloading Node/NSSM. Testing only - the result is not
  installable, and verify-bundle.ps1 will still check everything else.
#>
[CmdletBinding()] param(
  [ValidateSet('win-x64')][string]$Os = 'win-x64',
  [switch]$SkipRuntimeFetch,
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
$Name  = "gcio-bundle-$Ver-$Os"
$Stage = Join-Path $Out $Name
Write-GcioLog "building $Name"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path "$Stage/app", "$Stage/runtime" | Out-Null

# ---------------------------------------------------------------- build
#
# ORDER MATTERS. vite is a devDependency, so `npm ci --omit=dev` before the
# build leaves `npm run build` with no vite: the build fails, or worse, an
# earlier dist survives and the bundle ships a stale client. Build with the
# full tree first, install production dependencies into the STAGE afterwards.

Write-GcioLog 'npm ci (full - the build needs devDependencies)'
Push-Location $Repo
try { npm ci; $ec = $LASTEXITCODE } finally { Pop-Location }
if ($ec) { Stop-Gcio "'npm ci' failed (exit $ec). package-lock.json is likely out of sync with package.json - run 'npm install', commit the lockfile, then rebuild. Refusing to ship a stale bundle." }

Write-GcioLog 'build client'
Push-Location $Repo
try { npm run build; $ec = $LASTEXITCODE } finally { Pop-Location }
if ($ec) { Stop-Gcio "client build failed (exit $ec). Refusing to ship a stale client dist." }
if (-not (Test-Path "$Repo/client/dist/index.html")) { Stop-Gcio 'client build produced no dist/index.html - refusing to ship a bundle with no UI.' }

# ---------------------------------------------------------------- stage
#
# Code and data that BELONG to the application. Note what is absent: data/ and
# vault/ are runtime state and deliberately live outside <install>/app, so the
# operator's drop folder and audit trail are not orphaned by an upgrade. See
# server/config.js resolveStateDir and test/domain/paths.test.js.

Write-GcioLog 'staging the app'
Copy-Item -Recurse -Force `
  "$Repo/server", "$Repo/shared", "$Repo/scripts", "$Repo/sample-data", `
  "$Repo/package.json", "$Repo/package-lock.json" "$Stage/app/"
New-Item -ItemType Directory -Force "$Stage/app/client" | Out-Null
Copy-Item -Recurse -Force "$Repo/client/dist" "$Stage/app/client/dist"

# Production dependencies installed INTO THE STAGE rather than by pruning the
# repo's tree: a release build must not leave the developer's checkout needing
# an `npm install` before it works again.
Write-GcioLog 'npm ci --omit=dev (into the staged app)'
Push-Location "$Stage/app"
try { npm ci --omit=dev; $ec = $LASTEXITCODE } finally { Pop-Location }
if ($ec) { Stop-Gcio "staged 'npm ci --omit=dev' failed (exit $ec) - the bundle would ship without its dependencies." }
if (-not (Test-Path "$Stage/app/node_modules")) { Stop-Gcio 'staged node_modules is missing - refusing to ship a bundle that cannot run.' }

# ------------------------------------------------- dependencies as ONE file
#
# node_modules is 15,312 of the bundle's 17,398 files - the application itself
# is 62. Every stage of a deploy paid for that per-file count four times over:
# deleting the previous unpack, extracting, checksumming, and copying into
# place. Measured on a live host the delete alone ran at 0.1 MB/s and looked
# exactly like a hung installer.
#
# Collapsing the tree into one archive takes all four passes down to ~2,000
# files. install.ps1 expands it on the host, where it is a single sequential
# read rather than 15,312 scattered ones.
#
# Compressed rather than stored: the outer archive would otherwise have to
# deflate 200 MB of already-laid-out files, and this way the expensive part
# happens once at build time instead of on every operator's machine.
Write-GcioLog 'collapsing node_modules into a single archive'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$nmDir = Join-Path $Stage 'app/node_modules'
$nmZip = Join-Path $Stage 'app/node_modules.zip'
$nmFiles = (Get-ChildItem -LiteralPath $nmDir -Recurse -File).Count
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $nmDir, $nmZip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
if (-not (Test-Path $nmZip)) { Stop-Gcio 'failed to archive node_modules - refusing to ship a bundle without dependencies.' }
Remove-GcioTree $nmDir
Write-GcioLog ("node_modules: {0:N0} files -> one archive of {1:N1} MB" -f $nmFiles, ((Get-Item $nmZip).Length / 1MB))
if (Test-Path $nmDir) { Stop-Gcio 'the loose node_modules tree survived - the bundle would ship dependencies twice.' }

# ---------------------------------------------------------------- runtime

if (-not $SkipRuntimeFetch) {
  $nodeUrl = Get-GcioJsonValue "$Here/versions.json" "node.$Os.url"
  $nodeSha = Get-GcioJsonValue "$Here/versions.json" "node.$Os.sha256"
  if (-not $nodeUrl) { Stop-Gcio "versions.json has no node.$Os.url" }
  $pkg = Join-Path "$Stage/runtime" (Split-Path $nodeUrl -Leaf)
  Write-GcioLog "fetch node: $nodeUrl"
  Invoke-GcioDownload $nodeUrl $pkg
  Test-GcioSha256 $pkg $nodeSha
  Expand-Archive -Path $pkg -DestinationPath "$Stage/runtime" -Force
  Remove-Item $pkg
  Get-ChildItem "$Stage/runtime" -Directory -Filter 'node-*' | Select-Object -First 1 |
    ForEach-Object { Rename-Item $_.FullName (Join-Path "$Stage/runtime" 'node') }
  if (-not (Test-Path "$Stage/runtime/node/node.exe")) { Stop-Gcio 'node.exe missing after extraction' }

  # nssm.cc is flaky; a local cache means an outage cannot block a rebuild.
  $nssmCache = Join-Path $Here '.cache/nssm.exe'
  if (Test-Path $nssmCache) {
    Write-GcioLog 'using cached nssm.exe (deploy/.cache/nssm.exe)'
    Copy-Item $nssmCache "$Stage/runtime/nssm.exe"
  } else {
    $nssmUrl = Get-GcioJsonValue "$Here/versions.json" 'nssm.url'
    $nssmSha = Get-GcioJsonValue "$Here/versions.json" 'nssm.sha256'
    Write-GcioLog 'fetch nssm'
    Invoke-GcioDownload $nssmUrl "$Stage/runtime/nssm.zip"
    Test-GcioSha256 "$Stage/runtime/nssm.zip" $nssmSha
    Expand-Archive "$Stage/runtime/nssm.zip" "$Stage/runtime/nssm-tmp" -Force
    $found = Get-ChildItem "$Stage/runtime/nssm-tmp" -Recurse -Filter 'nssm.exe' |
      Where-Object { $_.FullName -like '*win64*' } | Select-Object -First 1
    if (-not $found) { Stop-Gcio 'no win64 nssm.exe inside the downloaded archive' }
    Copy-Item $found.FullName "$Stage/runtime/nssm.exe"
    Remove-Item -Recurse -Force "$Stage/runtime/nssm-tmp", "$Stage/runtime/nssm.zip"
    New-Item -ItemType Directory -Force (Split-Path $nssmCache) | Out-Null
    Copy-Item "$Stage/runtime/nssm.exe" $nssmCache
  }
} else {
  Write-GcioWarn 'SkipRuntimeFetch: this bundle has no Node or NSSM and is NOT installable (testing only)'
}

# ---------------------------------------------------------------- host scripts
#
# ALLOW-LIST. A host-side script not named here does NOT ship, and the operator
# finds out only when it is missing on the server. In DEDB that is exactly how
# Set-DedbBindHost.ps1 reached zero hosts across many releases.
#
# Deliberately NOT wrapped in `if (Test-Path)`: DEDB's version is, and that
# silent skip is the same failure wearing a different hat -- a typo or a rename
# drops a script from every future release with nothing to say so. Missing here
# stops the build.

$HostScripts = 'install.ps1', 'install-service.ps1', 'uninstall.ps1', 'code-update.ps1', 'Update-GCIO.cmd', 'seal-secret.ps1', 'Grant-Role.cmd'
foreach ($f in $HostScripts) {
  if (-not (Test-Path "$Here/$f")) {
    Stop-Gcio "host script '$f' is on the ship list but is not in deploy/. Fix the name or remove it from `$HostScripts - do not let it silently not ship."
  }
  Copy-Item "$Here/$f" "$Stage/"
}
# install.ps1 sources lib/common.ps1 at runtime: bundle it, or the host fails
# with "common.ps1 not found" after the archive is already unpacked.
Copy-Item -Recurse -Force "$Here/lib" "$Stage/lib"
Copy-Item "$Here/versions.json" "$Stage/versions.json"
$Ver | Out-File -Encoding ascii "$Stage/VERSION"

# ---------------------------------------------------------------- checksums

Write-GcioLog 'writing checksums'
Push-Location $Stage
try {
  # -LiteralPath so a node_modules fixture whose name contains wildcard
  # metacharacters ([ ]) hashes rather than globbing to something else.
  # UTF-8 so a non-ASCII filename round-trips into checksums.txt intact.
  Get-ChildItem -Recurse -File | Where-Object { $_.Name -ne 'checksums.txt' } | Sort-Object FullName | ForEach-Object {
    $rel = Resolve-Path -Relative -LiteralPath $_.FullName
    "$(Get-GcioSha256 $_.FullName)  $rel"
  } | Out-File -Encoding utf8 'checksums.txt'
} finally { Pop-Location }

# ---------------------------------------------------------------- pack

Write-GcioLog 'packing archive'
Compress-Archive -Path $Stage -DestinationPath "$Out/$Name.zip" -Force

# These ship OUTSIDE the archive, beside it.
#
# code-update.ps1 and Update-GCIO.cmd bootstrap the deploy by expanding the
# bundle zip, so they cannot live inside the thing they unzip.
#
# verify-bundle.ps1 is here for a different reason, learned when 1.11.0 changed
# the bundle's shape. The verifier lived ONLY at the operator's staging root, as
# version-independent tooling sitting beside versioned bundles - so a change of
# format silently invalidated it, and the stale copy rejected a perfectly good
# 1.11.0 bundle with "MISSING: app/node_modules". A verifier has to travel with
# the format it understands. Now that it ships beside the archive, copying
# dist-bundle/* to the staging root refreshes it as a side effect.
#
# Not guarded by `if (Test-Path)`, for the reason spelled out above $HostScripts:
# a silent skip turns a typo or a rename into a file that quietly stops shipping,
# and this list had exactly that guard when the problem above went unnoticed.
foreach ($f in 'code-update.ps1', 'Update-GCIO.cmd', 'verify-bundle.ps1') {
  if (-not (Test-Path "$Here/$f")) {
    Stop-Gcio "'$f' is on the beside-the-archive ship list but is not in deploy/. Fix the name or remove it from the list - do not let it silently not ship."
  }
  Copy-Item "$Here/$f" "$Out/" -Force
  Write-GcioLog "placed $f beside the archive"
}

Write-GcioLog "done -> $Out/$Name.zip"
