<#
  The health probe the patch gate rolls back on.

  GCIO answers /healthz with {"status":"ok",...} -- NOT DEDB's {"ok":true} --
  so the matcher is genuinely different code, not a rename. Getting it wrong
  does not fail loudly: every patch would roll back from a perfectly healthy
  host, which is exactly what happened in DEDB when nssm's UTF-16 output made
  a literal match silently impossible.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

# ---- the real shape this app returns ----
$real = '{"status":"ok","uptimeSec":3,"version":"1.5.0"}'
Check (Test-GcioHealthBody $real) 'the real /healthz body is accepted'
Check ((Get-GcioVersionFromHealth $real) -eq '1.5.0') 'the version is read out of the health body'

# ---- things that must NOT read as healthy ----
Check (-not (Test-GcioHealthBody '{"status":"degraded"}')) 'a non-ok status is rejected'
Check (-not (Test-GcioHealthBody ''))                      'an empty body is rejected'
Check (-not (Test-GcioHealthBody '<html>502 Bad Gateway</html>')) 'a proxy error page is rejected'
Check (-not (Test-GcioHealthBody '{"ready":false,"reason":"no data has been ingested yet"}')) 'a /readyz body is not mistaken for a healthy /healthz'
# The dangerous near-miss: DEDB's shape. If someone ports the matcher back,
# this catches it before every patch starts rolling back.
Check (-not (Test-GcioHealthBody '{"ok":true}')) "DEDB's health shape is NOT accepted - GCIO reports status, not ok"

<#
  NUL-laden input.

  nssm writes its `get` output as UTF-16LE, and PowerShell decodes that stream
  a byte at a time, so every real character arrives followed by a NUL. A
  console does not render those, so the string looks completely normal when an
  operator prints it by hand -- while a literal pattern can never match it. In
  DEDB this made EVERY patch roll back on a healthy host. Strip, then match.
#>
$nulLaden = ($real.ToCharArray() | ForEach-Object { "$_`0" }) -join ''
Check (Test-GcioHealthBody $nulLaden) 'a NUL-laden body still matches (the nssm UTF-16 trap)'
Check ((Get-GcioVersionFromHealth $nulLaden) -eq '1.5.0') 'the version is still readable from a NUL-laden body'

# ---- whitespace tolerance: a body is not required to be minified ----
Check (Test-GcioHealthBody "{`n  `"status`" : `"ok`" ,`n  `"version`": `"1.5.0`"`n}") 'a pretty-printed body still matches'

# ---- absent version is empty, not an exception ----
Check ((Get-GcioVersionFromHealth '{"status":"ok"}') -eq '') 'a body with no version yields empty rather than throwing'

# ---- an unreachable URL is "not healthy", not a crash ----
# Port 1 is reserved and nothing listens there.
Check (-not (Test-GcioHealth -Url 'http://127.0.0.1:1/healthz')) 'an unreachable host reads as unhealthy rather than throwing'

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
