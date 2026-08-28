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

# ---------------------------------------------------------------- patch tier

<#
  Read a property off an object, or $Default when absent or null.

  Guards against StrictMode, which turns a missing property into a terminating
  error -- and this code reads JSON written by an older release, where a
  property genuinely may not exist.
#>
function Get-GcioProp {
  param($Obj, [Parameter(Mandatory)][string]$Name, $Default = $null)
  if ($null -eq $Obj) { return $Default }
  $p = $Obj.PSObject.Properties[$Name]
  if ($null -eq $p -or $null -eq $p.Value) { return $Default }
  return $p.Value
}

function ConvertTo-GcioNodeMajor {
  param([string]$VersionString)
  if ($VersionString -match 'v?(\d+)\.') { return [int]$Matches[1] }
  return -1
}

# The Node major actually installed, read from the bundled runtime. Returns -1
# when there is no runtime to ask, which never equals a patch's target and so
# fails closed.
function Get-GcioNodeMajor {
  param([Parameter(Mandatory)][string]$InstallDir)
  $exe = Join-Path $InstallDir 'runtime\node\node.exe'
  if (-not (Test-Path $exe)) { return -1 }
  try { return ConvertTo-GcioNodeMajor (& $exe --version 2>$null) } catch { return -1 }
}

function Test-GcioVersionAtLeast {
  param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Min)
  try { return ([version]($Version -replace '[^0-9.]', '')) -ge ([version]($Min -replace '[^0-9.]', '')) }
  catch { return $false }
}

<#
  The compatibility contract a patch carries with it.

  Recorded at BUILD time from the staged files, so the host compares like with
  like rather than trusting a number someone typed.
#>
function New-GcioPatchMeta {
  param(
    [Parameter(Mandatory)][string]$AppDir,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][int]$NodeMajor,
    [Parameter(Mandatory)][string]$MinBase,
    [string]$BuiltFrom = ''
  )
  return [ordered]@{
    kind                  = 'patch'
    version               = $Version
    nodeMajor             = $NodeMajor
    minBase               = $MinBase
    lockDepsHash          = (Get-GcioLockDepsHash (Join-Path $AppDir 'package-lock.json'))
    migrationsFingerprint = (Get-GcioMigrationsFingerprint (Join-Path $AppDir 'server\db\migrations.js'))
    builtFrom             = $BuiltFrom
  }
}

<#
  Required files present and NO runtime -> this looks like a real patch.

  Catches a truncated download or a half-extracted zip before the compatibility
  gates do, so the operator gets "this is not a complete artifact" rather than a
  confusing verdict about versions.
#>
function Test-GcioPatchComplete {
  param([Parameter(Mandatory)][string]$Root)
  $need = 'install.ps1', 'lib\common.ps1', 'app\server\index.js', 'app\package-lock.json',
          'app\client\dist\index.html', 'patch-meta.json', 'checksums.txt'
  foreach ($p in $need) { if (-not (Test-Path (Join-Path $Root $p))) { return $false } }
  # A runtime means somebody handed us a full bundle.
  if (Test-Path (Join-Path $Root 'runtime\node\node.exe')) { return $false }
  return $true
}

<#
  The four fail-closed gates. Returns
    { Ok; Code; Reason; Installed; PatchVersion; MinBase }

  MUTATES NOTHING. It runs before any stop, backup or overlay, so a refusal
  leaves the install byte-identical and there is no rollback to perform. That
  property is asserted directly by deploy/test/patch-gates.test.ps1 across every
  refusal path -- keep it true.

  Code is what callers switch on to build operator guidance; Reason is prose for
  a log. Pass -InstalledNodeMajor to inject the host's Node major (tests);
  otherwise it is read from the installed runtime.
#>
function Test-GcioPatchCompatible {
  param(
    [Parameter(Mandatory)][string]$PatchRoot,
    [Parameter(Mandatory)][string]$InstallDir,
    [int]$InstalledNodeMajor = -1
  )
  # One shape for every verdict, so no return path can forget a field.
  $mk = {
    param($ok, $code, $reason, $installed, $patchVer, $minBase)
    [pscustomobject]@{
      Ok = [bool]$ok; Code = "$code"; Reason = "$reason"
      Installed = "$installed"; PatchVersion = "$patchVer"; MinBase = "$minBase"
    }
  }

  $metaPath = Join-Path $PatchRoot 'patch-meta.json'
  if (-not (Test-Path $metaPath)) {
    return & $mk $false 'meta-missing' 'patch-meta.json missing' 'unknown' 'unknown' 'unknown'
  }
  $meta     = Get-Content -Raw $metaPath | ConvertFrom-Json
  $patchVer = "$(Get-GcioProp $meta 'version' 'unknown')"
  $minBase  = "$(Get-GcioProp $meta 'minBase' 'unknown')"

  $pkg = Join-Path $InstallDir 'app\package.json'
  if (-not (Test-Path $pkg)) {
    return & $mk $false 'no-install' 'no existing install - run a full bundle first' 'unknown' $patchVer $minBase
  }
  $instVer = "$((Get-Content -Raw $pkg | ConvertFrom-Json).version)"

  # 1. min base
  if (-not (Test-GcioVersionAtLeast -Version $instVer -Min $minBase)) {
    return & $mk $false 'min-base' "installed version $instVer is older than this patch's minimum base $minBase - use the full bundle" $instVer $patchVer $minBase
  }

  # 2. node major
  $nm = $InstalledNodeMajor
  if ($nm -lt 0) { $nm = Get-GcioNodeMajor -InstallDir $InstallDir }
  $want = [int](Get-GcioProp $meta 'nodeMajor' -1)
  if ($nm -ne $want) {
    return & $mk $false 'node-major' "Node runtime major $nm != patch target $want - use the full bundle" $instVer $patchVer $minBase
  }

  # 3. dependencies
  $instLock = Join-Path $InstallDir 'app\package-lock.json'
  if (-not (Test-Path $instLock)) {
    return & $mk $false 'lockfile-missing' 'cannot verify dependencies (this install predates lockfile tracking) - use the full bundle' $instVer $patchVer $minBase
  }
  if ((Get-GcioLockDepsHash $instLock) -ne (Get-GcioLockDepsHash (Join-Path $PatchRoot 'app\package-lock.json'))) {
    return & $mk $false 'deps-changed' 'dependencies changed - use the full bundle' $instVer $patchVer $minBase
  }

  # 4. schema
  $instMig  = Get-GcioMigrationsFingerprint (Join-Path $InstallDir 'app\server\db\migrations.js')
  $patchMig = Get-GcioMigrationsFingerprint (Join-Path $PatchRoot  'app\server\db\migrations.js')
  if ($instMig -ne $patchMig) {
    return & $mk $false 'schema-changed' 'database schema (migrations.js) changed - use the full bundle' $instVer $patchVer $minBase
  }

  return & $mk $true 'ok' '' $instVer $patchVer $minBase
}
