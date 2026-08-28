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

# ---------------------------------------------------------------- fingerprints

# SHA-256 of a string, lowercase hex. Shared by both fingerprints below so they
# cannot drift apart in how they hash.
function Get-GcioTextSha256 {
  param([string]$Text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) -join ''
  } finally { $sha.Dispose() }
}

<#
  Fingerprint the database schema.

  GCIO keeps its migrations as JavaScript objects in server/db/migrations.js,
  not as a directory of .sql files (which is what DEDB fingerprints), so this
  hashes the whole file.

  THE CONSEQUENCE, stated plainly because it will surprise someone: editing a
  COMMENT in migrations.js changes this hash and therefore forces a bundle,
  even though no schema changed. That is deliberate and it is the safe
  direction. Over-triggering costs one bundle deploy. Under-triggering lets a
  schema change ride in on a patch overlay -- and because GCIO applies
  migrations at BOOT (server/index.js), that would migrate a host nobody chose
  to migrate. There is a test pinning this behaviour; read it before "fixing"
  this.

  EOL-normalized, so a Windows checkout flipping LF to CRLF never trips it.
#>
function Get-GcioMigrationsFingerprint {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  Get-GcioTextSha256 ([IO.File]::ReadAllText($Path) -replace "`r`n", "`n")
}

<#
  Fingerprint the DEPENDENCY closure, ignoring the app's own version.

  Everything before the first "node_modules/" key is the app's own metadata --
  name, version, lockfileVersion -- plus the root "" package entry. None of it
  describes a dependency, so it is dropped and only the closure is hashed.
  Without that, `npm version patch` alone would read as a dependency change and
  refuse every patch: the exact false positive that gets a gate switched off.

  A substring, NOT a regex over "version" lines. A regex that nulls every
  "version" line also nulls each DEPENDENCY's version, leaving the gate blind
  to the change it exists to catch. That was measured, not guessed: against
  this repo's real lockfile such a regex PASSES both directions (a dependency
  change also alters `resolved` and `integrity`, which survive it) while
  FAILING the single-line fixtures in the test -- correct-looking exactly where
  it is least tested.

  Read as text rather than through ConvertFrom-Json: npm lockfiles carry an
  empty-string key ("") which Windows PowerShell 5.1's parser refuses, and the
  host runs 5.1.
#>
function Get-GcioLockDepsHash {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $text = [IO.File]::ReadAllText($Path) -replace "`r`n", "`n"
  $i = $text.IndexOf('"node_modules/')
  # No dependencies at all: nothing to fingerprint. Hashing the whole text here
  # would put the app's own version back into the hash.
  if ($i -ge 0) { $text = $text.Substring($i) } else { $text = '' }
  Get-GcioTextSha256 $text
}
