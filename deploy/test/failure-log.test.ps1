<#
  What an operator is shown when a health check fails.

  The point is SINCE, not TAIL. A service log accumulates across deploys, and
  this host's own service-err.log holds 15 stack traces from a deliberately
  broken patch applied on 2026-08-29. Printing the tail would show those and
  send whoever reads it chasing a syntax error that stopped existing hours ago -
  which is a documented trap in docs/deployment-2026-08-28.md, not a
  hypothetical.

  So the length of each log is recorded BEFORE the deploy touches anything, and
  only what was written after that point is shown.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Check { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-fl-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force "$root/logs" | Out-Null
$errLog = "$root/logs/service-err.log"
$outLog = "$root/logs/service-out.log"

try {
  # ------------------------------------------------ length markers
  Check ((Get-GcioLogLength "$root/logs/nope.log") -eq 0) 'a log that does not exist yet measures 0, not an error'

  [IO.File]::WriteAllText($errLog, "OLD LINE 1`nOLD LINE 2`n")
  $mark = Get-GcioLogLength $errLog
  Check ($mark -gt 0) 'an existing log measures its current length'

  # ------------------------------------------------ only what came after
  Add-Content -Path $errLog -Value 'NEW LINE FROM THIS DEPLOY'
  $since = Get-GcioLogSince -Path $errLog -Since $mark
  Check ($since -match 'NEW LINE FROM THIS DEPLOY') 'content written after the marker is returned'
  Check ($since -notmatch 'OLD LINE')               'content written BEFORE the marker is NOT - that is the whole point'

  # Nothing new is nothing, not the whole file.
  $mark2 = Get-GcioLogLength $errLog
  Check ([string]::IsNullOrWhiteSpace((Get-GcioLogSince -Path $errLog -Since $mark2))) 'a log that did not grow returns empty'

  <#
    A rotated or truncated log is shorter than the marker. Reading from a stale
    offset would throw or return nonsense; fall back to the whole file, which is
    the best available answer once the marker is meaningless.
  #>
  [IO.File]::WriteAllText($errLog, "SHORTER AFTER ROTATION`n")
  $since = Get-GcioLogSince -Path $errLog -Since 99999
  Check ($since -match 'SHORTER AFTER ROTATION') 'a log shorter than the marker (rotated) falls back to the whole file'

  # ------------------------------------------------ the operator-facing report
  [IO.File]::WriteAllText($errLog, "STALE TRACE FROM AN OLD DEPLOY`n")
  [IO.File]::WriteAllText($outLog, "old boot line`n")
  $mErr = Get-GcioLogLength $errLog
  $mOut = Get-GcioLogLength $outLog
  Add-Content -Path $errLog -Value 'SyntaxError: Unexpected identifier'
  Add-Content -Path $outLog -Value 'gcio listening on 8130'

  $lines = @(Show-GcioFailureLog -InstallDir $root -SinceOut $mOut -SinceErr $mErr -ProbeUrl 'http://127.0.0.1:8130/healthz')
  $text = $lines -join "`n"

  Check ($lines.Count -ge 3)                       'the report is several lines, not one blob'
  Check ($text -match 'SyntaxError')               'it shows what the failing app actually wrote'
  Check ($text -match 'gcio listening on 8130')    'it shows stdout too - a boot can fail after printing something useful'
  Check ($text -notmatch 'STALE TRACE')            'it does NOT show the stale trace from an earlier deploy'
  Check ($text -match 'healthz')                   'it names the URL that was probed'
  Check ($text -match 'service-err\.log')          'it names the file, so an operator can read more'

  # Nothing new in either log is itself a finding - a service that never started
  # writes nothing, and saying so beats printing an empty section.
  $mErr = Get-GcioLogLength $errLog
  $mOut = Get-GcioLogLength $outLog
  $lines = @(Show-GcioFailureLog -InstallDir $root -SinceOut $mOut -SinceErr $mErr -ProbeUrl 'http://127.0.0.1:8130/healthz')
  $text = $lines -join "`n"
  Check ($text -match 'nothing new|no new output') 'when nothing was logged, it says so rather than printing an empty section'

  # Pure: returns lines, does not print or exit, so it is testable and both
  # callers can print it through their own helper.
  Check ($lines -is [array]) 'it returns an array of lines rather than writing to the host'

  # A missing log directory must not throw in the middle of a failure path.
  $threw = $false
  try { $null = Show-GcioFailureLog -InstallDir (Join-Path $root 'nonexistent') -SinceOut 0 -SinceErr 0 -ProbeUrl 'x' } catch { $threw = $true }
  Check (-not $threw) 'a missing log directory does not throw - this runs while something has already gone wrong'
} finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
