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

<#
  Resolving the bind address from .env.

  The -BindAddr parameter above was declared, documented and tested for two
  weeks while NOTHING passed it. The guard looked wired, tested as if wired, and
  every port probe was in fact unscoped. These tests pin the resolution so that
  cannot recur silently.

  Scoping is SAFE here even if the resolved address is wrong, because the
  process check under the install directory is the primary guard: a listener we
  fail to match still shows up as a live node process under InstallDir, and the
  stop is reported not-clean. The address filter only ever makes the port probe
  more precise, never blinder.
#>
$envRoot = Join-Path ([IO.Path]::GetTempPath()) ("gcio-ba-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $envRoot | Out-Null
try {
  [IO.File]::WriteAllText("$envRoot/.env", "STORE=mssql`nHOST=10.20.30.40`nPORT=8130`n")
  Check ((Get-GcioBindAddress -InstallDir $envRoot) -eq '10.20.30.40') 'a pinned IPv4 in HOST is resolved and returned'

  [IO.File]::WriteAllText("$envRoot/.env", "HOST=0.0.0.0`nPORT=8130`n")
  Check ((Get-GcioBindAddress -InstallDir $envRoot) -eq '') 'a wildcard bind returns empty - scoping to 0.0.0.0 would match nothing useful'

  [IO.File]::WriteAllText("$envRoot/.env", "PORT=8130`n")
  Check ((Get-GcioBindAddress -InstallDir $envRoot) -eq '') 'no HOST at all returns empty (unscoped)'

  [IO.File]::WriteAllText("$envRoot/.env", "HOST=127.0.0.1`nPORT=8130`n")
  Check ((Get-GcioBindAddress -InstallDir $envRoot) -eq '127.0.0.1') 'loopback IS scoped - another application can bind the same port on a different address'

  Remove-Item "$envRoot/.env"
  Check ((Get-GcioBindAddress -InstallDir $envRoot) -eq '') 'a missing .env returns empty rather than throwing'

  # A hostname must resolve to an address: Get-NetTCPConnection reports numeric
  # LocalAddress, so an unresolved name would match nothing and silently unscope.
  [IO.File]::WriteAllText("$envRoot/.env", "HOST=localhost`nPORT=8130`n")
  $r = Get-GcioBindAddress -InstallDir $envRoot
  Check ($r -match '^\d{1,3}(\.\d{1,3}){3}$' -or $r -eq '') 'a hostname resolves to an IPv4, or returns empty rather than a name the probe cannot match'

  [IO.File]::WriteAllText("$envRoot/.env", "HOST=no-such-host-anywhere.invalid`nPORT=8130`n")
  Check ((Get-GcioBindAddress -InstallDir $envRoot) -eq '') 'an unresolvable hostname returns empty (unscoped) rather than a useless filter'
} finally { Remove-Item -Recurse -Force $envRoot -ErrorAction SilentlyContinue }

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
<#
  The ARGUMENT VECTOR, not a concatenation of it.

  nssm takes `set <service> AppExit Default <action>` as five separate
  arguments. The first version of this test recorded "$b $c $d" and matched
  "AppExit Default Exit" - which passed while the real call was passing
  "AppExit Default" as ONE argument. nssm rejected it on the first real deploy
  with `Invalid parameter "AppExit Default"`, and the suppression silently never
  happened. Assert the shape.
#>
$argv = Get-GcioNssmAutoRestartArgs -ServiceName 'GCIOProjectIntelligence' -Enabled $false
Check ($argv.Count -eq 5)          'the nssm call is FIVE arguments, not a concatenated string'
Check ($argv[0] -eq 'set')         'argv[0] is set'
Check ($argv[2] -eq 'AppExit')     'argv[2] is AppExit on its own'
Check ($argv[3] -eq 'Default')     'argv[3] is Default on its own - NOT joined to AppExit'
Check ($argv[4] -eq 'Exit')        'disabling asks for Exit, so a crash is not restarted mid-overlay'

$argv = Get-GcioNssmAutoRestartArgs -ServiceName 'GCIOProjectIntelligence' -Enabled $true
Check ($argv[4] -eq 'Restart')     'enabling restores Restart'
Check ($argv[3] -eq 'Default')     'and Default is still its own argument'

# The wrapper must hand that vector through untouched.
$script:seen = $null
Set-GcioNssmAutoRestart -Nssm 'nssm.exe' -Enabled:$false -Invoke { param($exe, $a) $script:seen = $a }
Check ($script:seen.Count -eq 5 -and $script:seen[2] -eq 'AppExit' -and $script:seen[3] -eq 'Default') 'the wrapper passes the vector through unaltered'

# It must never throw: a failure to restore auto-restart during a rollback would
# be a second fault stacked on the first.
$threw = $false
try { Set-GcioNssmAutoRestart -Nssm 'nssm.exe' -Enabled:$true -Invoke { throw 'nssm exploded' } } catch { $threw = $true }
Check ($threw -eq $false) 'a failing nssm call is swallowed, never thrown from the restore path'

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
