<#
  The stop half of the deploy window.

  A patch is stop -> overlay -> start -> health-check. Everything about that
  sequence assumes the OLD process is genuinely gone before the overlay begins.
  If it is not, the new files are written underneath a process still serving
  from memory, and the health check that follows can be answered by the very
  process the patch was supposed to replace. The deploy then reports health=OK
  having verified nothing.

  GCIO's stop was `sc.exe stop` followed by `Start-Sleep 3` with no port check
  at all. These tests pin the replacement.

  Every probe is injectable, so the whole sequence is driven deterministically
  with no service, no ports, and no processes.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

# ---------------------------------------------------------------- clean stop

# Port frees immediately, nothing left running.
$r = Wait-GcioCleanStop -InstallDir 'C:\gcio' -Port 8130 -GraceSec 2 `
  -GetProcs { param($d) @() } -TestPort { param($p) $false } `
  -KillProc { param($id) } -Sleep { param($ms) }
Check ($r.Clean -eq $true)      'a port that is already free reports clean'
Check ($r.Killed.Count -eq 0)   'nothing is killed when the stop was clean'

# Port busy for the first few polls, then free. Must wait rather than proceed.
$script:polls = 0
$r = Wait-GcioCleanStop -InstallDir 'C:\gcio' -Port 8130 -GraceSec 5 `
  -GetProcs { param($d) @() } `
  -TestPort { param($p) $script:polls++; return ($script:polls -lt 4) } `
  -KillProc { param($id) } -Sleep { param($ms) }
Check ($r.Clean -eq $true)  'a slow release is WAITED for, not raced'
Check ($script:polls -ge 4) "the port was polled until it freed (polls: $script:polls)"
Check ($r.Killed.Count -eq 0) 'a slow but clean release kills nothing'

# A process under the install dir survives the stop -> force-kill it.
$script:killed = @()
$script:alive = $true
$r = Wait-GcioCleanStop -InstallDir 'C:\gcio' -Port 8130 -GraceSec 1 `
  -GetProcs { param($d) if ($script:alive) { @([pscustomobject]@{ ProcessId = 4242 }) } else { @() } } `
  -TestPort { param($p) $false } `
  -KillProc { param($id) $script:killed += $id; $script:alive = $false } `
  -Sleep { param($ms) }
Check ($script:killed -contains 4242) 'a leftover process under the install dir is force-killed'
Check ($r.Killed -contains 4242)      'the kill is reported back to the caller'

# The port is held by something we cannot kill: report NOT clean rather than
# proceeding. Overlaying here is how a health check ends up answered by the
# process the patch was meant to replace.
$r = Wait-GcioCleanStop -InstallDir 'C:\gcio' -Port 8130 -GraceSec 1 `
  -GetProcs { param($d) @() } -TestPort { param($p) $true } `
  -KillProc { param($id) } -Sleep { param($ms) }
Check ($r.Clean -eq $false) 'a port still held after the grace period reports NOT clean'

# Port 0 means "do not probe a port" - used where the caller has none.
$r = Wait-GcioCleanStop -InstallDir 'C:\gcio' -Port 0 -GraceSec 1 `
  -GetProcs { param($d) @() } -TestPort { param($p) throw 'must not probe when Port is 0' } `
  -KillProc { param($id) } -Sleep { param($ms) }
Check ($r.Clean -eq $true) 'Port 0 skips the port probe entirely'

# ---------------------------------------------------------------- co-tenancy

<#
  This host family runs several applications on the same port, each pinned to a
  different IP. An unscoped probe would see a neighbour's listener, conclude the
  port is still held, and force-kill its way toward a stop that already
  happened. The bound address must reach the probe.
#>
$script:seenAddr = 'NOT-SET'
$null = Wait-GcioCleanStop -InstallDir 'C:\gcio' -Port 8130 -GraceSec 1 -BindAddr '10.1.2.3' `
  -GetProcs { param($d) @() } `
  -TestPort { param($p, $addr) $script:seenAddr = $addr; return $false } `
  -KillProc { param($id) } -Sleep { param($ms) }
Check ($script:seenAddr -eq '10.1.2.3') 'the bound address is passed to the port probe (co-tenant safety)'

# ---------------------------------------------------------------- service state

$script:states = @('StopPending', 'StopPending', 'Stopped')
$script:i = 0
$ok = Wait-GcioServiceState -State 'Stopped' -TimeoutSec 5 `
  -GetState { $s = $script:states[[Math]::Min($script:i, $script:states.Count - 1)]; $script:i++; return $s } `
  -Sleep { param($ms) }
Check ($ok -eq $true) 'STOP_PENDING is waited through until the SCM settles on Stopped'

$ok = Wait-GcioServiceState -State 'Stopped' -TimeoutSec 1 `
  -GetState { 'StopPending' } -Sleep { param($ms) }
Check ($ok -eq $false) 'a service stuck in STOP_PENDING times out rather than reporting success'

$ok = Wait-GcioServiceState -State 'Stopped' -TimeoutSec 1 `
  -GetState { $null } -Sleep { param($ms) }
Check ($ok -eq $true) 'a service that does not exist counts as Stopped (nothing to wait for)'

# ---------------------------------------------------------------- nssm restart

<#
  NSSM's AppExit=Restart is armed at install. Left armed across the overlay it
  can RESURRECT the old application while files are being replaced underneath
  it. It must be suppressed for the window and restored on every exit path.
#>
$script:nssmCalls = @()
$fakeNssm = { param($a, $b, $c, $d) $script:nssmCalls += "$b $c $d" }
Set-GcioNssmAutoRestart -Nssm 'nssm.exe' -Enabled:$false -Invoke $fakeNssm
Check ($script:nssmCalls[-1] -match 'AppExit Default Exit') 'disabling sets AppExit to Exit, so a crash is not restarted mid-overlay'
Set-GcioNssmAutoRestart -Nssm 'nssm.exe' -Enabled:$true -Invoke $fakeNssm
Check ($script:nssmCalls[-1] -match 'AppExit Default Restart') 'enabling restores AppExit to Restart'

# It must never throw: a failure to restore auto-restart during a rollback
# would be a second fault stacked on the first.
$threw = $false
try { Set-GcioNssmAutoRestart -Nssm 'nssm.exe' -Enabled:$true -Invoke { throw 'nssm exploded' } } catch { $threw = $true }
Check ($threw -eq $false) 'a failing nssm call is swallowed, never thrown from the restore path'

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
