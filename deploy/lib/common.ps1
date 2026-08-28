<#
  Shared helpers for the GCIO release system.

  Sourced by BOTH the build scripts (PowerShell 7, on a developer machine) and
  the host-side installer (whatever ships with Windows Server, which is 5.1).
  That means: no ternaries, no null-coalescing, no `clean` parameter sets, and
  nothing else 5.1 cannot parse. If it will not run under 5.1 it does not belong
  here, because the host is where a syntax error costs a deploy.

  Ported from C:\dev\DExDashBoard\deploy\lib\common.ps1, renamed Dedb -> Gcio,
  and reduced to what GCIO's single-app layout actually needs.
#>
Set-StrictMode -Version Latest

# ---------------------------------------------------------------- logging

function Write-GcioLog  { param([string]$Msg) Write-Host "[gcio] $Msg" }
function Write-GcioWarn { param([string]$Msg) Write-Warning "[gcio] $Msg" }
function Stop-Gcio      { param([string]$Msg) Write-Error "[gcio] $Msg"; exit 1 }

# ---------------------------------------------------------------- hashing

<#
  SHA-256 of one file, lowercase hex.

  -LiteralPath, always. Some node_modules packages ship test fixtures whose
  directory or file names contain PowerShell wildcard metacharacters -- a
  literal '[...]' is the common one. A positional -Path treats those as a glob,
  matches nothing, returns $null, and `.Hash` on $null throws an error that says
  nothing whatsoever about the real cause. A bundle contains the whole
  dependency tree, so this is not hypothetical.
#>
function Get-GcioSha256 {
  param([Parameter(Mandatory)][string]$Path)
  (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLower()
}

<#
  Verify a downloaded file against its pinned checksum.

  FATAL on mismatch, not a warning: this is the supply-chain check on the Node
  runtime and NSSM, and a warning that scrolls past in a build log is not a
  check. An absent expectation warns instead of failing, so a versions.json
  that has not pinned something yet does not become unbuildable -- but the
  pinned entries in this repo all carry a hash, verified on 2026-08-28.
#>
function Test-GcioSha256 {
  param([Parameter(Mandatory)][string]$Path, [string]$Expected)
  if (-not $Expected) {
    Write-GcioWarn "no expected sha256 for $Path - skipping verification"
    return
  }
  $got = Get-GcioSha256 $Path
  if ($got -ne $Expected.ToLower()) {
    Stop-Gcio "checksum mismatch for $Path`n  expected $Expected`n  got      $got"
  }
}

# ---------------------------------------------------------------- download

function Invoke-GcioDownload {
  param([Parameter(Mandatory)][string]$Url, [Parameter(Mandatory)][string]$Dest, [int]$Tries = 3)
  for ($i = 1; $i -le $Tries; $i++) {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
      return
    } catch {
      if ($i -eq $Tries) { throw }
      Write-GcioWarn "download failed ($i/$Tries), retrying: $Url"
      Start-Sleep 2
    }
  }
}

# ---------------------------------------------------------------- json

<#
  Read a dotted key out of a JSON file, or '' when any segment is missing.

  Returns empty rather than throwing so a caller can decide whether an absent
  key is fatal. The build scripts treat a missing node URL as fatal; the nssm
  cache path does not.
#>
function Get-GcioJsonValue {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$DottedKey)
  $o = Get-Content -Raw $Path | ConvertFrom-Json
  foreach ($k in $DottedKey.Split('.')) {
    if ($null -eq $o) { return '' }
    $prop = $o.PSObject.Properties[$k]
    if ($null -eq $prop) { return '' }
    $o = $prop.Value
  }
  if ($null -eq $o) { return '' }
  return $o
}
