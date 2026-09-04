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
  # Most cases here hand the verifier a payload it is SUPPOSED to reject, and it
  # reports that with Write-Error. Windows PowerShell 5.1 turns a child
  # process's stderr into a TERMINATING NativeCommandError while
  # $ErrorActionPreference is 'Stop', and neither 2>&1 nor 2>$null prevents it.
  # Without this the suite died at its first negative case: it has only ever run
  # one of its checks, and reported exit 1 with no verdict - a shape that reads
  # as an ordinary failure, which is why it went unnoticed.
  $prevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & pwsh -NoProfile -File $Script -Dir $Dir 2>&1 | Out-Null
  } finally { $ErrorActionPreference = $prevEap }
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

  # ------------------------------------- a bundle's dependencies, both shapes
  #
  # 1.11.0 collapsed node_modules into a single archive. The verifier must accept
  # BOTH that and the loose tree older bundles carry, because the verifier and the
  # bundle are separate artifacts and can be any two versions. That is not
  # hypothetical: a pre-1.11.0 verifier left at the staging root rejected a good
  # 1.11.0 bundle with "MISSING: app/node_modules".
  #
  # Synthetic on purpose. These run on a clean checkout, unlike the real-artifact
  # checks below, which skip when nothing has been built - and which had been
  # skipping for several releases without anyone noticing.
  function NewBundle { param([string]$At, [ValidateSet('zip','tree','neither')][string]$Deps)
    New-Item -ItemType Directory -Force `
      "$At/app/server", "$At/app/client/dist", "$At/lib", "$At/runtime/node" | Out-Null
    [IO.File]::WriteAllText("$At/app/server/index.js", 'server')
    [IO.File]::WriteAllText("$At/app/package-lock.json", '{"packages":{"node_modules/x":{"version":"1"}}}')
    [IO.File]::WriteAllText("$At/app/client/dist/index.html", '<html>')
    [IO.File]::WriteAllText("$At/install.ps1", '# installer')
    [IO.File]::WriteAllText("$At/lib/common.ps1", '# lib')
    [IO.File]::WriteAllText("$At/runtime/node/node.exe", 'MZ')
    [IO.File]::WriteAllText("$At/VERSION", '9.9.9')
    [IO.File]::WriteAllText("$At/versions.json", '{}')
    if ($Deps -eq 'tree') {
      New-Item -ItemType Directory -Force "$At/app/node_modules/express" | Out-Null
      [IO.File]::WriteAllText("$At/app/node_modules/express/index.js", 'dep')
    } elseif ($Deps -eq 'zip') {
      [IO.File]::WriteAllText("$At/app/node_modules.zip", 'stand-in for the dependency archive')
    }
    Rehash $At }

  NewBundle "$root/b-zip"     'zip'
  NewBundle "$root/b-tree"    'tree'
  NewBundle "$root/b-neither" 'neither'
  Check ((RunVerify $verifyBundle "$root/b-zip")     -eq 0) 'a bundle whose dependencies are ONE archive verifies'
  Check ((RunVerify $verifyBundle "$root/b-tree")    -eq 0) 'a bundle with a loose node_modules tree still verifies'
  Check ((RunVerify $verifyBundle "$root/b-neither") -ne 0) 'a bundle carrying neither shape is refused'

  # ------------------------------------------------ against the REAL artifacts
  #
  # Skipped rather than failed when they have not been built: this file must
  # stay runnable on a clean checkout.
  # Whatever is actually built, newest by VERSION - not a pinned name. These were
  # pinned to 1.5.0, which stopped being built several releases ago, so every
  # check in this section had been printing [skip] and asserting nothing.
  # Sorted as [version], not as a string: lexically, 1.9.0 beats 1.11.0.
  $repo = (Resolve-Path "$PSScriptRoot/../..").Path
  function Newest { param([string]$Kind)
    # checksums.txt is what makes a directory an ARTIFACT rather than debris.
    # dist-bundle accumulates the wreckage of aborted builds - one of them is an
    # app/client directory and nothing else - and picking the newest NAME walks
    # straight into one, which is how reviving these checks first failed.
    Get-ChildItem (Join-Path $repo 'dist-bundle') -Directory -Filter "gcio-$Kind-*-win-x64" -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName 'checksums.txt') } |
      Sort-Object { try { [version]($_.Name -replace "^gcio-$Kind-", '' -replace '-win-x64$', '') } catch { [version]'0.0.0' } } |
      Select-Object -Last 1 -ExpandProperty FullName }
  $realPatch  = Newest 'patch'
  $realBundle = Newest 'bundle'
  if ($realPatch)  { Write-Host "[info] real patch:  $(Split-Path $realPatch -Leaf)"  -ForegroundColor Cyan }
  if ($realBundle) { Write-Host "[info] real bundle: $(Split-Path $realBundle -Leaf)" -ForegroundColor Cyan }

  if ($realPatch) {
    Check ((RunVerify $verifyPatch $realPatch) -eq 0) 'the REAL built patch verifies'
    # The tier check on a real bundle, without copying 269 MB: verify-patch
    # must refuse the real bundle directory.
    if ($realBundle) {
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

  if ($realBundle) {
    Check ((RunVerify $verifyBundle $realBundle) -eq 0) "the REAL built bundle verifies ($(Split-Path $realBundle -Leaf))"
    if ($realPatch) {
      Check ((RunVerify $verifyBundle $realPatch) -ne 0) 'verify-bundle REFUSES a patch (no runtime, no dependencies)'
    }
  } else {
    Write-Host "[skip] real-bundle checks (build with deploy/build-bundle.ps1 first)" -ForegroundColor Yellow
  }
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
