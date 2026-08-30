<#
  What uninstalling removes, and - more importantly - what it does not.

  DEDB's uninstall takes a single -Purge that deletes the application AND its
  persistent data together. GCIO deliberately splits that, because the two are
  not comparable losses:

    - app/ and runtime/ are reproducible from any release artifact.
    - vault/ is the AUDIT TRAIL. It is what makes "what did that workbook
      actually say" answerable months later, and nothing else holds those bytes.
    - data/ is the live drop folder.

  So: removing the service is the default and destroys nothing; removing the
  application is a separate switch; destroying state is a third, and it has to
  say out loud what it is about to take.

  The plan is a pure function so what-gets-deleted is asserted without deleting
  anything.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }
function HasPath { param($Plan, [string]$Leaf) return [bool](@($Plan.Paths | Where-Object { $_ -like "*$Leaf" }).Count) }

# ---------------------------------------------------------------- default

$p = Get-GcioUninstallPlan -InstallDir 'C:\gcio'
Check ($p.RemovesService -eq $true) 'the default removes the service'
Check ($p.Paths.Count -eq 0)        'the default deletes NOTHING on disk'
Check ($p.DestroysState -eq $false) 'and does not touch state'
Check ($p.Summary -match 'service')  'the summary says what it will do'

# ---------------------------------------------------------------- -RemoveApp

$p = Get-GcioUninstallPlan -InstallDir 'C:\gcio' -RemoveApp
Check (HasPath $p 'app')      '-RemoveApp removes app/'
Check (HasPath $p 'runtime')  '-RemoveApp removes runtime/'
Check (-not (HasPath $p 'vault')) '-RemoveApp does NOT remove the vault'
Check (-not (HasPath $p 'data'))  '-RemoveApp does NOT remove the drop folder'
Check (-not (HasPath $p '.env'))  '-RemoveApp does NOT remove .env - it holds the database password and is not reproducible'
Check ($p.DestroysState -eq $false) '-RemoveApp is not a state-destroying operation'

<#
  Backups are app copies, so they go with the app - keeping app.bak-* after
  deleting app/ leaves 500 MB of directories nothing can restore into.
#>
Check (HasPath $p 'app.bak-*') '-RemoveApp removes the app backups too'

# ---------------------------------------------------------------- -PurgeData

$p = Get-GcioUninstallPlan -InstallDir 'C:\gcio' -RemoveApp -PurgeData
Check ($p.DestroysState -eq $true) '-PurgeData is flagged as state-destroying'
Check (HasPath $p 'vault')  '-PurgeData removes the vault'
Check (HasPath $p 'data')   '-PurgeData removes the drop folder'
Check (HasPath $p 'audit')  '-PurgeData removes the audit directory'
Check ($p.Warnings.Count -ge 1) 'and it carries warnings rather than deleting quietly'
Check (($p.Warnings -join ' ') -match 'vault|audit trail') 'the warning names the vault specifically - it is the irreplaceable one'
Check (($p.Warnings -join ' ') -match 'database|SQL') 'and points out the database is NOT touched, so the portfolio survives'

# -PurgeData without -RemoveApp is refused: leaving an application installed
# with its drop folder and vault deleted is not a state anyone wants.
$p = Get-GcioUninstallPlan -InstallDir 'C:\gcio' -PurgeData
Check ($p.Valid -eq $false) '-PurgeData without -RemoveApp is refused as incoherent'
Check ($p.Summary -match 'RemoveApp') 'and says which switch is missing'

$p = Get-GcioUninstallPlan -InstallDir 'C:\gcio' -RemoveApp
Check ($p.Valid -eq $true) 'a coherent plan is valid'

# ---------------------------------------------------------------- paths

<#
  A PREFIX glob is not enough, and this is not hypothetical: the first version
  of this test asserted `-like 'D:\elsewhere*'`, which "D:\elsewhereapp"
  satisfies perfectly. The separator had been eaten by tooling and every path
  in the plan was malformed - the test passed, and the bug was only visible
  because a -WhatIf run against the real install printed "C:\gcioapp
  (not present)" for a directory that plainly exists.

  Assert the separator, not the prefix.
#>
$sep = [string][char]92
$p = Get-GcioUninstallPlan -InstallDir "D:${sep}elsewhere" -RemoveApp -PurgeData
Check ((@($p.Paths | Where-Object { $_ -notlike "D:${sep}elsewhere${sep}*" }).Count) -eq 0) 'every path is under the install directory WITH a separator, never outside it'
Check ((@($p.Paths | Where-Object { $_ -eq "D:${sep}elsewhere${sep}vault" }).Count) -eq 1) 'a known path is exactly right, separator included'
Check ((@($p.Paths | Where-Object { $_ -match 'elsewhere[a-z]' }).Count) -eq 0) 'no path has the leaf glued onto the directory name'

# A trailing separator on the install dir must not double up.
$p = Get-GcioUninstallPlan -InstallDir "D:${sep}elsewhere${sep}" -RemoveApp
Check ((@($p.Paths | Where-Object { $_ -match '\\\\' }).Count) -eq 0) 'a trailing separator on the install dir does not produce a doubled one'

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
