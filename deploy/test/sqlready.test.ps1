<#
  The SQL pre-check.

  Run BEFORE the first mutation - before the copy-backup, before the stop - so a
  database that is down aborts having changed nothing, instead of the deploy
  proceeding, failing its health check, and rolling back for a reason that has
  nothing to do with the patch.

  GCIO needs this more than it looks. /healthz reports process liveness and
  never consults the store, so a bare health gate cannot tell "the new code is
  broken" from "SQL is unreachable" - it just sees no answer and rolls back.
  This host has already had the failure: SQL Server crashed mid-deploy on
  2026-08-28 (event 7034).

  THE ASYMMETRY IS THE DESIGN. Only a DEFINITIVE "SQL is down" aborts. Anything
  the probe cannot establish - no node, no script, a store that is not SQL at
  all - warns and PROCEEDS. A pre-check that blocks deploys because it could not
  run is worse than no pre-check: it gets bypassed, and then it protects
  nothing.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-sql-" + [guid]::NewGuid().ToString('N'))
function New-Install {
  param([string]$Store = 'mssql', [switch]$NoScript, [switch]$NoNode)
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force "$root/app/scripts", "$root/runtime/node" | Out-Null
  [IO.File]::WriteAllText("$root/.env", "STORE=$Store`nPORT=8130`n")
  if (-not $NoScript) { [IO.File]::WriteAllText("$root/app/scripts/db-check.mjs", '// probe') }
  if (-not $NoNode)   { [IO.File]::WriteAllText("$root/runtime/node/node.exe", 'fake') }
  return $root
}

try {
  # ------------------------------------------------ the definitive verdicts
  $d = New-Install
  $r = Test-GcioSqlReady -InstallDir $d -Invoke { param($node, $script, $cwd) [pscustomobject]@{ ExitCode = 0; Output = 'connected' } }
  Check ($r.Ok -and -not $r.Inconclusive) 'a successful probe is a definitive OK'

  $r = Test-GcioSqlReady -InstallDir $d -Invoke { param($node, $script, $cwd) [pscustomobject]@{ ExitCode = 1; Output = 'FAILED: ECONNREFUSED 127.0.0.1:1433' } }
  Check (-not $r.Ok)              'a failing probe is a definitive NOT-OK - this is the one that aborts a deploy'
  Check (-not $r.Inconclusive)    'and it is not dressed up as inconclusive'
  Check ($r.Reason -match 'ECONNREFUSED') 'the reason carries what the probe actually said, not a summary'

  # ------------------------------------------------ everything else PROCEEDS
  <#
    Each of these is a reason the probe could not establish anything. None may
    block a deploy. If they did, the first host without a node on PATH would
    teach its operator to pass -SkipSqlPrecheck permanently, and the check would
    protect nobody from then on.
  #>
  $d = New-Install -Store 'memory'
  $r = Test-GcioSqlReady -InstallDir $d -Invoke { param($n, $s, $c) throw 'must not probe when STORE is not mssql' }
  Check ($r.Ok -and $r.Inconclusive) 'STORE=memory does not probe at all, and does not block'
  Check ($r.Reason -match 'memory')  'and says why it was skipped'

  $d = New-Install -NoScript
  $r = Test-GcioSqlReady -InstallDir $d -Invoke { param($n, $s, $c) throw 'must not probe without the script' }
  Check ($r.Ok -and $r.Inconclusive) 'a missing db-check.mjs is inconclusive, not a block'

  $d = New-Install -NoNode
  $r = Test-GcioSqlReady -InstallDir $d -Invoke { param($n, $s, $c) throw 'must not probe without node' }
  Check ($r.Ok -and $r.Inconclusive) 'a missing bundled node is inconclusive, not a block'

  $d = New-Install
  Remove-Item "$d/.env"
  $r = Test-GcioSqlReady -InstallDir $d -Invoke { param($n, $s, $c) throw 'must not probe without .env' }
  Check ($r.Ok -and $r.Inconclusive) 'a missing .env is inconclusive - STORE is unknown, so nothing is claimed'

  # A probe that throws outright must not take the deploy down with it.
  $d = New-Install
  $r = Test-GcioSqlReady -InstallDir $d -Invoke { param($n, $s, $c) throw 'node exploded' }
  Check ($r.Ok -and $r.Inconclusive) 'a probe that throws is inconclusive, never fatal'
  Check ($r.Reason -match 'exploded') 'and the throw is reported rather than swallowed'

  # ------------------------------------------------ it runs from the right place
  <#
    dotenv reads .env from the WORKING DIRECTORY, and .env lives at the install
    root while the script lives under app\scripts. Run it from the wrong place
    and it silently probes whatever the defaults point at - which is exactly the
    Task 6A failure wearing different clothes.
  #>
  $script:cwdSeen = ''
  $script:scriptSeen = ''
  $d = New-Install
  $null = Test-GcioSqlReady -InstallDir $d -Invoke {
    param($node, $scriptPath, $cwd)
    $script:cwdSeen = $cwd; $script:scriptSeen = $scriptPath
    [pscustomobject]@{ ExitCode = 0; Output = '' } }
  Check ($script:cwdSeen -eq $d) 'the probe runs with the working directory at the INSTALL ROOT, where .env is'
  Check ($script:scriptSeen -like '*app*scripts*db-check.mjs') 'and points at the bundled app scripts/db-check.mjs'
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
