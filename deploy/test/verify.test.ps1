<#
  The artifact verifiers.

  Two jobs: catch corruption or tampering, and catch the WRONG TIER. The second
  matters more than it sounds - applying a full bundle through the patch path
  would overlay code while leaving the old node_modules and runtime behind, so
  the app would run new code against old dependencies.

  Where practical these run against the REAL built artifact rather than a
  fixture. A verifier that only ever sees a hand-made directory has never met
  a node_modules tree with wildcard characters in its filenames.
#>
$ErrorActionPreference = 'Stop'

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

$verifyPatch  = Join-Path $PSScriptRoot '../verify-patch.ps1'
$verifyBundle = Join-Path $PSScriptRoot '../verify-bundle.ps1'
function RunVerify { param([string]$Script, [string]$Dir)
  & pwsh -NoProfile -File $Script -Dir $Dir 2>&1 | Out-Null
  return $LASTEXITCODE }

$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-v-" + [guid]::NewGuid().ToString('N'))

try {
  # ------------------------------------------------ a synthetic, valid patch
  New-Item -ItemType Directory -Force "$root/p/app/server", "$root/p/app/client/dist", "$root/p/lib" | Out-Null
  [IO.File]::WriteAllText("$root/p/app/server/index.js", 'server')
  [IO.File]::WriteAllText("$root/p/app/package-lock.json", '{"packages":{"node_modules/x":{"version":"1"}}}')
  [IO.File]::WriteAllText("$root/p/app/client/dist/index.html", '<html>')
  [IO.File]::WriteAllText("$root/p/install.ps1", '# installer')
  [IO.File]::WriteAllText("$root/p/lib/common.ps1", '# lib')
  [IO.File]::WriteAllText("$root/p/patch-meta.json", '{"kind":"patch","version":"1.5.0"}')
  [IO.File]::WriteAllText("$root/p/VERSION", '1.5.0')
  function Rehash { param([string]$Dir)
    Push-Location $Dir
    try {
      Get-ChildItem -Recurse -File | Where-Object { $_.Name -ne 'checksums.txt' } | Sort-Object FullName | ForEach-Object {
        "$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower())  $(Resolve-Path -Relative -LiteralPath $_.FullName)"
      } | Out-File -Encoding utf8 'checksums.txt'
    } finally { Pop-Location } }
  Rehash "$root/p"

  Check ((RunVerify $verifyPatch "$root/p") -eq 0) 'a well-formed patch verifies'

  # ------------------------------------------------ tampering
  [IO.File]::WriteAllText("$root/p/app/server/index.js", 'TAMPERED')
  Check ((RunVerify $verifyPatch "$root/p") -ne 0) 'an altered file fails verification'
  [IO.File]::WriteAllText("$root/p/app/server/index.js", 'server')
  Check ((RunVerify $verifyPatch "$root/p") -eq 0) 'restoring the original content verifies again'

  # A file listed in checksums but deleted must fail, not be skipped.
  Remove-Item "$root/p/app/client/dist/index.html"
  Check ((RunVerify $verifyPatch "$root/p") -ne 0) 'a file listed in checksums but missing fails verification'
  [IO.File]::WriteAllText("$root/p/app/client/dist/index.html", '<html>')

  # ------------------------------------------------ wrong tier
  New-Item -ItemType Directory -Force "$root/p/runtime/node" | Out-Null
  [IO.File]::WriteAllText("$root/p/runtime/node/node.exe", 'fake')
  Rehash "$root/p"
  Check ((RunVerify $verifyPatch "$root/p") -ne 0) 'an artifact carrying a runtime is REFUSED as a patch (it is a bundle)'
  Remove-Item -Recurse -Force "$root/p/runtime"

  New-Item -ItemType Directory -Force "$root/p/app/node_modules/x" | Out-Null
  [IO.File]::WriteAllText("$root/p/app/node_modules/x/i.js", 'dep')
  Rehash "$root/p"
  Check ((RunVerify $verifyPatch "$root/p") -ne 0) 'a patch carrying node_modules is refused (it would bypass the deps gate)'
  Remove-Item -Recurse -Force "$root/p/app/node_modules"
  Rehash "$root/p"

  # ------------------------------------------------ missing metadata
  Remove-Item "$root/p/patch-meta.json"
  Check ((RunVerify $verifyPatch "$root/p") -ne 0) 'a patch with no patch-meta.json is refused'

  Remove-Item "$root/p/checksums.txt" -ErrorAction SilentlyContinue
  Check ((RunVerify $verifyPatch "$root/p") -ne 0) 'an artifact with no checksums.txt is refused'

  # ------------------------------------------------ against the REAL artifacts
  #
  # Skipped rather than failed when they have not been built: this file must
  # stay runnable on a clean checkout.
  $repo = (Resolve-Path "$PSScriptRoot/../..").Path
  $realPatch  = Join-Path $repo 'dist-bundle/gcio-patch-1.5.0-win-x64'
  $realBundle = Join-Path $repo 'dist-bundle/gcio-bundle-1.5.0-win-x64'

  if (Test-Path $realPatch) {
    Check ((RunVerify $verifyPatch $realPatch) -eq 0) 'the REAL built patch verifies'
    # The tier check on a real bundle, without copying 269 MB: verify-patch
    # must refuse the real bundle directory.
    if (Test-Path $realBundle) {
      Check ((RunVerify $verifyPatch $realBundle) -ne 0) 'verify-patch REFUSES the real full bundle'
    }
    # Tamper with a copy of the real patch - a genuine tree, genuine filenames.
    $copy = Join-Path $root 'realcopy'
    Copy-Item -Recurse -Force $realPatch $copy
    Check ((RunVerify $verifyPatch $copy) -eq 0) 'a copy of the real patch still verifies'
    $victim = Get-ChildItem "$copy/app/server" -Filter '*.js' | Select-Object -First 1
    Add-Content -LiteralPath $victim.FullName -Value "`n// tampered"
    Check ((RunVerify $verifyPatch $copy) -ne 0) 'tampering with one file in the real patch is caught'
  } else {
    Write-Host "[skip] real-artifact checks (build with deploy/build-patch.ps1 first)" -ForegroundColor Yellow
  }

  if (Test-Path $realBundle) {
    Check ((RunVerify $verifyBundle $realBundle) -eq 0) 'the REAL built bundle verifies (all 17k files)'
    Check ((RunVerify $verifyBundle $realPatch) -ne 0) 'verify-bundle REFUSES a patch (no runtime, no node_modules)'
  } else {
    Write-Host "[skip] real-bundle checks (build with deploy/build-bundle.ps1 first)" -ForegroundColor Yellow
  }
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
