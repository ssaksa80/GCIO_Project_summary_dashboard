<#
  The message an operator reads when a patch is refused.

  A gate that refuses without saying what to do next gets bypassed, so this is
  tested like behaviour, not like formatting. Every refusal must state: that
  NOTHING changed, what is installed, what the patch needs, why it was refused,
  and the exact recovery command.
#>
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"

$script:fails = 0
function Assert-True { param($Cond, [string]$What)
  if ($Cond) { Write-Host "[ok] $What" -ForegroundColor Green }
  else { Write-Host "[FAIL] $What" -ForegroundColor Red; $script:fails++ } }

function Refusal { param([string]$Code, [string]$Installed = '1.5.0', [string]$PatchVersion = '1.6.0', [string]$MinBase = '1.5.0')
  Format-GcioPatchRefusal -Compat ([pscustomobject]@{
    Ok = $false; Code = $Code; Reason = "reason text for $Code"
    Installed = $Installed; PatchVersion = $PatchVersion; MinBase = $MinBase
  }) }

# Every Code the gates can return. A new verdict with no guidance is a silent
# regression, so this list is the contract.
$codes = 'schema-changed', 'deps-changed', 'node-major', 'min-base', 'lockfile-missing', 'no-install', 'meta-missing'

<#
  The per-code explanation, isolated from the boilerplate.

  Assertions here MUST target this line rather than the whole message. The
  standing recovery text already contains phrases like "applies migrations at
  boot", so a match against the joined blob passes even when the gate-specific
  explanation has been gutted -- which is exactly what happened on the first
  draft of these tests: mutating the schema explanation to "Refused." left two
  of three assertions green.
#>
function WhyLine { param([string]$Code)
  $lines = @(Refusal $Code)
  # The reason: line, then the explanation directly beneath it.
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*reason:') { return $lines[$i + 1] }
  }
  return ''
}

foreach ($code in $codes) {
  $lines = @(Refusal $code)
  $text  = $lines -join "`n"

  Assert-True ($lines.Count -ge 5) "$code : returns several lines, not one blob"
  Assert-True ($text -match 'NOTHING has been changed') "$code : says nothing was changed"
  Assert-True ($text -match '1\.5\.0') "$code : names the installed version"
  Assert-True ($text -match '1\.6\.0') "$code : names the patch version"
  Assert-True ($text -match 'gcio-bundle') "$code : names the recovery artifact"

  # A real sentence explaining THIS code, not the code echoed back.
  $why = WhyLine $code
  Assert-True ($why.Trim().Length -gt 40) "$code : the explanation under 'reason:' is a full sentence"
  Assert-True ($why -notmatch "^\s*$([regex]::Escape($code))\s*$") "$code : the explanation is not just the code repeated"
}

# The schema case is the one most likely to be met in practice, and the one
# whose cause is least guessable from the outside.
$schemaWhy = WhyLine 'schema-changed'
Assert-True ($schemaWhy -match 'migrations\.js') 'schema-changed names the file that changed, in its own explanation'
Assert-True ($schemaWhy -match 'boot')           'schema-changed explains WHY an overlay is unsafe here, in its own explanation'

$depsWhy = WhyLine 'deps-changed'
Assert-True ($depsWhy -match 'node_modules') 'deps-changed explains that an overlay ships no node_modules'

# ASCII only: this is printed on a host console that may not be UTF-8.
$all = ($codes | ForEach-Object { (Refusal $_) -join "`n" }) -join "`n"
# @() around the pipeline: Where-Object yields $null when nothing matches, and
# .Count on $null is a terminating error under StrictMode -- which would abort
# the run rather than report a result either way.
$nonAscii = @([char[]]$all | Where-Object { [int]$_ -gt 126 })
Assert-True ($nonAscii.Count -eq 0) "the guidance is pure ASCII (a host console is not guaranteed UTF-8); found $($nonAscii.Count) non-ASCII char(s)"

# Prove that assertion CAN fail, rather than trusting a zero. Built from a
# codepoint, not typed literally: this very file is meant to stay ASCII, and a
# literal em dash here would be the thing it is testing for.
$probe = @([char[]]("em dash " + [char]0x2014 + " here") | Where-Object { [int]$_ -gt 126 })
Assert-True ($probe.Count -eq 1) 'the ASCII check detects a non-ASCII character when one is present'

# Pure: no printing, no exit, so it can be tested and reused by both callers.
Assert-True ((Refusal 'min-base') -is [array]) 'it returns an array of lines rather than writing to the host'

if ($script:fails) { Write-Host "`n$($script:fails) failed" -ForegroundColor Red; exit 1 }
Write-Host "`nall passed" -ForegroundColor Green
