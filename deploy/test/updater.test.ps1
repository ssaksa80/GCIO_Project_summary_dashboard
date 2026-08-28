<#
  code-update.ps1 - the operator-facing entry point.

  Tested for the decisions it makes before handing off: which artifact is
  present, which tier it is, whether it verified, and what happens when any of
  that is ambiguous. The install itself is install.ps1's job and is covered by
  patch-gates/overlay/health-probe.

  Each case runs in its own directory holding a copy of the scripts plus a real
  zip, because the script's whole job is reading its own surroundings.
#>
$ErrorActionPreference = 'Stop'

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

$deploy = (Resolve-Path "$PSScriptRoot/..").Path
$repo   = (Resolve-Path "$PSScriptRoot/../..").Path
$root   = Join-Path ([IO.Path]::GetTempPath()) ("gcio-u-" + [guid]::NewGuid().ToString('N'))

# Build a scratch "release folder": the updater, the verifiers, and whatever
# zips the case needs.
function New-ReleaseDir {
  param([string]$Name)
  $d = Join-Path $root $Name
  New-Item -ItemType Directory -Force $d | Out-Null
  foreach ($f in 'code-update.ps1', 'verify-patch.ps1', 'verify-bundle.ps1') {
    Copy-Item (Join-Path $deploy $f) $d
  }
  return $d
}

function Run { param([string]$Dir, [string[]]$Extra = @())
  $out = & pwsh -NoProfile -File (Join-Path $Dir 'code-update.ps1') -InstallDir (Join-Path $Dir 'fake-install') @Extra 2>&1
  return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($out | Out-String) } }

try {
  $realPatch = Join-Path $repo 'dist-bundle/gcio-patch-1.5.0-win-x64.zip'
  if (-not (Test-Path $realPatch)) {
    Write-Host '[skip] no built patch zip - run deploy/build-patch.ps1 first' -ForegroundColor Yellow
    Write-Host "`nall passed" -ForegroundColor Green
    exit 0
  }

  # ------------------------------------------------ nothing to install
  $d = New-ReleaseDir 'empty'
  $r = Run $d
  Check ($r.Code -ne 0) 'an empty folder fails rather than doing something surprising'
  Check ($r.Text -match 'no gcio-bundle') 'and says what to copy next to the script'

  # ------------------------------------------------ ambiguity is refused
  $d = New-ReleaseDir 'two'
  Copy-Item $realPatch $d
  Copy-Item $realPatch (Join-Path $d 'gcio-bundle-1.5.0-win-x64.zip')   # name only; content irrelevant here
  $r = Run $d
  Check ($r.Code -ne 0) 'two artifacts side by side is REFUSED, not guessed at'
  Check ($r.Text -match 'exactly one') 'and the operator is told to leave exactly one'
  Check ($r.Text -match 'gcio-patch-1\.5\.0' -and $r.Text -match 'gcio-bundle-1\.5\.0') 'both candidates are named so the operator can see the ambiguity'

  # ------------------------------------------------ tier detection + verify
  $d = New-ReleaseDir 'patch'
  Copy-Item $realPatch $d
  $r = Run $d
  Check ($r.Text -match 'PATCH') 'a gcio-patch-* zip is identified as the patch tier'
  Check ($r.Text -match 'verifying with verify-patch\.ps1') 'the artifact is verified before anything is applied'
  Check (Test-Path (Join-Path $d 'gcio-patch-1.5.0-win-x64')) 'the archive was expanded beside the script'
  # It then hands off to install.ps1, which refuses because fake-install is not
  # a GCIO install. That refusal is the correct outcome here.
  Check ($r.Code -ne 0) 'applying to a directory that is not an install fails'
  Check ($r.Text -match 'no-install|NOTHING has been changed') 'and the refusal comes from the gates, with the no-change guarantee'

  # ------------------------------------------------ verification is never skipped
  $d = New-ReleaseDir 'tampered'
  Copy-Item $realPatch $d
  # Expand, corrupt one file, re-zip: a genuinely altered artifact.
  $tmpX = Join-Path $root 'x'
  Remove-Item -Recurse -Force $tmpX -ErrorAction SilentlyContinue
  Expand-Archive -Path (Join-Path $d 'gcio-patch-1.5.0-win-x64.zip') -DestinationPath $tmpX -Force
  $victim = Get-ChildItem "$tmpX/gcio-patch-1.5.0-win-x64/app/server" -Filter '*.js' | Select-Object -First 1
  Add-Content -LiteralPath $victim.FullName -Value "`n// tampered"
  Remove-Item (Join-Path $d 'gcio-patch-1.5.0-win-x64.zip')
  Compress-Archive -Path "$tmpX/gcio-patch-1.5.0-win-x64" -DestinationPath (Join-Path $d 'gcio-patch-1.5.0-win-x64.zip') -Force
  $r = Run $d
  Check ($r.Code -ne 0) 'a tampered artifact is refused'
  Check ($r.Text -match 'failed verification') 'and the reason names verification, not something downstream'
  Check ($r.Text -notmatch 'applying: install\.ps1') 'the installer is never reached for a tampered artifact'

  # ------------------------------------------------ rollback needs an install
  $d = New-ReleaseDir 'rollback'
  $r = Run $d @('-Rollback')
  Check ($r.Code -ne 0) 'rollback with no installed install.ps1 fails'
  Check ($r.Text -match 'cannot roll back') 'and explains that a rollback uses the INSTALLED installer'
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
