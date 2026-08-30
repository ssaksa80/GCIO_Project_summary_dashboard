<#
  The update flow's decisions.

  code-update.ps1 now checks elevation at step 0/4 - everything it does stops or
  starts a service, and discovering that three steps in as a confusing service
  failure helps nobody. That makes the SCRIPT untestable from an ordinary
  prompt, so the decisions it makes are pure functions in lib/common.ps1 and are
  tested here directly. The script is then a thin shell around them.

  What is deliberately NOT tested here: expanding an archive and handing off to
  install.ps1. That path needs a real service, and it is covered by the live
  deployment record instead.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

# ---------------------------------------------------------------- artifact choice

$r = Select-GcioArtifact -Names @('gcio-patch-1.5.1-win-x64.zip')
Check ($r.Kind -eq 'patch' -and "$($r.Version)" -eq '1.5.1') 'a lone patch is chosen'

$r = Select-GcioArtifact -Names @('gcio-bundle-1.6.0-win-x64.zip')
Check ($r.Kind -eq 'bundle' -and "$($r.Version)" -eq '1.6.0') 'a lone bundle is chosen'

Check ($null -eq (Select-GcioArtifact -Names @()))                        'nothing present yields no decision'
Check ($null -eq (Select-GcioArtifact -Names @('notes.txt','README.md'))) 'unrelated files are not mistaken for artifacts'

<#
  Arbitration, the rule ported from DEDB: the BUNDLE WINS at equal or greater
  version. A bundle does everything a patch does and more, so preferring it is
  never the less-capable choice - and choosing the patch would risk overlaying
  onto a base the operator meant to replace wholesale.
#>
$r = Select-GcioArtifact -Names @('gcio-patch-1.5.1-win-x64.zip', 'gcio-bundle-1.5.1-win-x64.zip')
Check ($r.Kind -eq 'bundle') 'at EQUAL version the bundle wins over the patch'

$r = Select-GcioArtifact -Names @('gcio-patch-1.5.1-win-x64.zip', 'gcio-bundle-1.6.0-win-x64.zip')
Check ($r.Kind -eq 'bundle' -and "$($r.Version)" -eq '1.6.0') 'a NEWER bundle wins'

$r = Select-GcioArtifact -Names @('gcio-patch-1.7.0-win-x64.zip', 'gcio-bundle-1.6.0-win-x64.zip')
Check ($r.Kind -eq 'patch' -and "$($r.Version)" -eq '1.7.0') 'a patch NEWER than every bundle is chosen'

$r = Select-GcioArtifact -Names @('gcio-patch-1.5.0-win-x64.zip', 'gcio-patch-1.5.3-win-x64.zip', 'gcio-patch-1.5.1-win-x64.zip')
Check ("$($r.Version)" -eq '1.5.3') 'the newest of several patches is chosen'

$r = Select-GcioArtifact -Names @('gcio-bundle-1.9.0-win-x64.zip', 'gcio-bundle-1.10.0-win-x64.zip')
Check ("$($r.Version)" -eq '1.10.0') 'versions compare numerically, not as strings (1.10.0 > 1.9.0)'

$r = Select-GcioArtifact -Names @('gcio-patch-1.5.1-win-x64.zip', 'gcio-bundle-1.6.0-win-x64.zip')
Check ($r.Reason -match 'bundle wins') 'the choice explains itself'

# ---------------------------------------------------------------- version gate

$g = Test-GcioVersionGate -Installed 'none' -Artifact '1.5.0'
Check ($g.Proceed -and $g.Code -eq 'first-install') 'a host with no install proceeds as a first install'

$g = Test-GcioVersionGate -Installed '1.5.0' -Artifact '1.6.0'
Check ($g.Proceed -and $g.Code -eq 'upgrade') 'a newer artifact proceeds as an upgrade'

# Both refusals must change nothing - an operator running a release folder twice
# is the common case, and a downgrade is almost always a mistake.
$g = Test-GcioVersionGate -Installed '1.5.0' -Artifact '1.5.0'
Check (-not $g.Proceed -and $g.Code -eq 'same-version') 'the same version is REFUSED rather than re-applied'
Check ($g.Message -match '-Force')                       'and the refusal names the override'

$g = Test-GcioVersionGate -Installed '1.6.0' -Artifact '1.5.0'
Check (-not $g.Proceed -and $g.Code -eq 'downgrade') 'an older artifact is REFUSED as a downgrade'
Check ($g.Message -match 'NOTHING was changed')      'and says plainly that nothing was changed'

$g = Test-GcioVersionGate -Installed '1.5.0' -Artifact '1.5.0' -Force $true
Check ($g.Proceed -and $g.Code -eq 'forced') '-Force re-applies the same version'
$g = Test-GcioVersionGate -Installed '1.6.0' -Artifact '1.5.0' -Force $true
Check ($g.Proceed -and $g.Code -eq 'forced') '-Force allows a downgrade'

Check ((Test-GcioVersionGate -Installed '1.9.0' -Artifact '1.10.0').Code -eq 'upgrade') 'the gate compares numerically too (1.10.0 > 1.9.0)'

# ---------------------------------------------------------------- the script itself

<#
  Only what can be checked without elevation or a service: that the script
  parses under the version the host actually runs, and that its elevation guard
  is present. Removing that guard is a regression - everything after it stops
  and starts a service.
#>
$script:updater = Join-Path $PSScriptRoot '../code-update.ps1'
$errs = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $script:updater).Path, [ref]$null, [ref]$errs)
Check (-not $errs) 'code-update.ps1 parses'

$text = Get-Content -Raw $script:updater

<#
  The guard is that the updater refuses when it cannot control the service. The
  earlier version of this asserted the SOURCE TEXT
  `WindowsBuiltInRole]::Administrator`, which pinned one IMPLEMENTATION of that
  guard rather than the guard itself - and went red the moment the check was
  corrected to test the capability instead of the role, even though the guard
  had got strictly better. Assert the behaviour.
#>
Check ($text -match 'Test-GcioCanControlService') 'code-update.ps1 refuses when it cannot control the service'

# ...and the check itself is exercised directly, which the source grep never did.
$ctl = Test-GcioCanControlService -ServiceName 'a-service-that-does-not-exist'
Check ($null -ne $ctl -and $null -ne $ctl.Can) 'the capability check returns a verdict for an unknown service rather than throwing'
Check ($ctl.Why -and $ctl.Why.Length -gt 10) 'and explains itself, so a refusal says what to do'
Check ($text -match 'Select-GcioArtifact')  'code-update.ps1 uses the shared artifact chooser rather than its own copy'
Check ($text -match 'Test-GcioVersionGate') 'code-update.ps1 uses the shared version gate'
Check ((@([char[]]$text | Where-Object { [int]$_ -gt 126 })).Count -eq 0) 'code-update.ps1 is ASCII-only (a BOM-less non-ASCII script breaks 5.1 parsing)'

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
