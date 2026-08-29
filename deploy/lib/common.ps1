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
  # Get-FileHash first, .NET as the fallback. The cmdlet arrived in PowerShell
  # 4.0 and is normally present on any host this runs on -- but it was NOT
  # available in one real deploy account, and the verifier's only reaction was
  # "the artifact failed verification", which points at the artifact and is
  # completely wrong. A hash function is not the place to depend on module
  # loading having gone well.
  $fh = Get-Command Get-FileHash -ErrorAction SilentlyContinue
  if ($fh) { return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLower() }
  $sha = [Security.Cryptography.SHA256]::Create()
  $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
  try {
    ($sha.ComputeHash($fs) | ForEach-Object { $_.ToString('x2') }) -join ''
  } finally { $fs.Dispose(); $sha.Dispose() }
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

<#
  Build the operator guidance for a REFUSED patch.

  Returns an ARRAY of plain lines; the caller prints each through its own warn
  helper. Pure -- no printing, no exit -- so it is unit-testable and shared by
  install.ps1 -Patch and code-update.ps1.

  Every message states, in this order: that NOTHING was changed (the gates are
  fail-closed and run before any mutation), what is INSTALLED, what the patch IS
  and REQUIRES, WHY it was refused in plain language, and the exact recovery
  COMMAND. The recovery is almost always the full bundle: a bundle ships Node
  and node_modules and applies migrations at boot, so it can bridge any gap a
  patch overlay cannot.

  ASCII only -- a host console is not guaranteed to be UTF-8.
#>
function Format-GcioPatchRefusal {
  param([Parameter(Mandatory)]$Compat)
  $inst = "$(Get-GcioProp $Compat 'Installed' 'unknown')"
  $pv   = "$(Get-GcioProp $Compat 'PatchVersion' 'unknown')"
  $mb   = "$(Get-GcioProp $Compat 'MinBase' 'unknown')"
  $code = "$(Get-GcioProp $Compat 'Code' 'unknown')"

  $why = switch ($code) {
    'schema-changed' {
      "This patch changes the database schema (server/db/migrations.js). GCIO applies migrations at boot, so an overlay would migrate this host without anyone having chosen to."
    }
    'deps-changed' {
      "This patch changes the dependency set, and a patch overlay ships no node_modules to satisfy it."
    }
    'node-major' {
      "This patch targets a different Node major than the runtime installed here, and a patch overlay ships no runtime to bridge that."
    }
    'min-base' {
      "This host is on $inst, which is older than this patch's minimum base of $mb. The patch assumes changes that install does not have."
    }
    'lockfile-missing' {
      "This install predates lockfile tracking, so its dependencies cannot be compared against the patch's and compatibility cannot be established."
    }
    'no-install' {
      "There is no GCIO install in this directory to patch."
    }
    'meta-missing' {
      "This artifact carries no patch-meta.json, so it cannot be verified as a patch at all. It may be a partial download."
    }
    default {
      "$(Get-GcioProp $Compat 'Reason' 'The compatibility check refused this patch.')"
    }
  }

  return @(
    'PATCH REFUSED - NOTHING has been changed on this host.',
    "  installed: $inst",
    "  patch:     $pv (requires at least $mb)",
    "  reason:    $code",
    "  $why",
    '',
    '  Recovery: install the full bundle instead -',
    "    Update-GCIO.cmd        (with gcio-bundle-$pv-win-x64.zip beside it)",
    '',
    '  A bundle ships Node and node_modules and applies migrations at boot, so it',
    '  can bridge any gap a patch overlay cannot.'
  )
}

# ---------------------------------------------------------------- file ops

<#
  Retry a destructive file operation through a transient lock -- a virus
  scanner, a still-draining process, a handle Windows has not released yet.
  Without this a deploy fails on a lock that would have cleared in a second.
#>
function Invoke-GcioFileOp {
  param([Parameter(Mandatory)][scriptblock]$Op, [int]$Tries = 5)
  for ($i = 1; $i -le $Tries; $i++) {
    try { & $Op; return }
    catch {
      if ($i -eq $Tries) { throw }
      Start-Sleep -Milliseconds (200 * $i)
    }
  }
}

<#
  COPY the current app aside, leaving the live app in place.

  Copy, not move: app code is static at runtime, so this runs BEFORE the service
  stops and the old version keeps serving throughout. That is what puts the
  backup off the downtime clock -- and it is also why data/ and vault/ must live
  outside app/, or every patch would re-copy the whole file archive.
#>
function Backup-GcioAppCopy {
  param([Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][string]$Ts)
  $dest = Join-Path $InstallDir "app.bak-$Ts"
  # Replace a stale same-second backup rather than merging into it: Copy-Item
  # -Force merges directories, which would leave the "backup" a blend of two
  # versions. Unreachable in normal use, but a backup must be a snapshot.
  if (Test-Path $dest) { Invoke-GcioFileOp { Remove-Item -Recurse -Force $dest } }
  Copy-Item -Recurse -Force (Join-Path $InstallDir 'app') $dest
}

<#
  Overlay a patch's app subset onto the installed app.

  Replaces code and built assets ONLY. node_modules, the runtime, .env and
  anything else in the install survive untouched -- that is the whole point of
  the patch tier, and the difference between a ten-second update and a
  reinstall.

  Remove-then-copy per directory, not Copy-Item -Force over the top: -Force
  MERGES directories, so a file deleted in the new release would survive
  forever. A stale module left behind is a genuine hazard - it still imports,
  and it is nobody's idea of what is deployed.
#>
function Copy-GcioPatchOverlay {
  param([Parameter(Mandatory)][string]$PatchApp, [Parameter(Mandatory)][string]$InstallApp)
  foreach ($sub in 'server', 'shared', 'scripts', 'sample-data') {
    $s = Join-Path $PatchApp $sub
    $d = Join-Path $InstallApp $sub
    if (Test-Path $s) {
      if (Test-Path $d) { Invoke-GcioFileOp { Remove-Item -Recurse -Force $d } }
      Copy-Item -Recurse -Force $s $d
    }
  }
  foreach ($f in 'package.json', 'package-lock.json') {
    $s = Join-Path $PatchApp $f
    if (Test-Path $s) { Copy-Item -Force $s (Join-Path $InstallApp $f) }
  }
  $s = Join-Path $PatchApp 'client\dist'
  $d = Join-Path $InstallApp 'client\dist'
  if (Test-Path $s) {
    if (Test-Path $d) { Invoke-GcioFileOp { Remove-Item -Recurse -Force $d } }
    Copy-Item -Recurse -Force $s $d
  }
}

# Backup timestamps present, newest first.
function Get-GcioBackups {
  param([Parameter(Mandatory)][string]$InstallDir)
  Get-ChildItem $InstallDir -Directory -Filter 'app.bak-*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { $_.Name -replace '^app\.bak-', '' }
}

# Move a backup back into place, removing whatever is currently there.
function Restore-GcioApp {
  param([Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][string]$Ts)
  $app = Join-Path $InstallDir 'app'
  $bak = Join-Path $InstallDir "app.bak-$Ts"
  if (Test-Path $bak) {
    if (Test-Path $app) { Invoke-GcioFileOp { Remove-Item -Recurse -Force $app } }
    Invoke-GcioFileOp { Move-Item $bak $app }
  }
}

function Remove-OldGcioBackups {
  param([Parameter(Mandatory)][string]$InstallDir, [int]$Keep = 3)
  $stamps = @(Get-GcioBackups -InstallDir $InstallDir)
  if ($stamps.Count -le $Keep) { return }
  foreach ($ts in ($stamps | Select-Object -Skip $Keep)) {
    Remove-Item -Recurse -Force (Join-Path $InstallDir "app.bak-$ts") -ErrorAction SilentlyContinue
  }
}

<#
  One line per deploy.

  THIS FILE is the authority for "what actually reached this host" -- not
  package.json, not a release PR, not what anyone remembers. A bundle is
  cumulative, so intermediate versions can reach a host inside a later bundle
  without ever having been deployed as their own version; only the log knows.
#>
function Write-GcioDeployLog {
  param(
    [Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][string]$Kind,
    [string]$From = '?', [string]$To = '?', [string]$Extra = ''
  )
  $logDir = Join-Path $InstallDir 'logs'
  New-Item -ItemType Directory -Force $logDir | Out-Null
  $stamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
  $line = ("$stamp  $Kind  $From -> $To  $Extra").TrimEnd()
  Add-Content -Path (Join-Path $logDir 'deploy.log') -Value $line -Encoding ascii
}

# ---------------------------------------------------------------- health

<#
  Does this /healthz body say the app is up?

  GCIO answers {"status":"ok",...}; DEDB answers {"ok":true}. Do not port
  DEDB's matcher here -- accepting the wrong shape means every patch rolls back
  from a healthy host, and nothing about that failure points at the matcher.

  NULs are stripped first. nssm writes `get` output as UTF-16LE and PowerShell
  decodes it a byte at a time, so every real character arrives followed by a
  NUL. A console does not render those, so the string looks completely normal
  when an operator prints it -- while a literal pattern can never match. In
  DEDB that made EVERY patch roll back on hosts that were fine.
#>
function Test-GcioHealthBody {
  param([string]$Body)
  if (-not $Body) { return $false }
  return (($Body -replace "`0", '') -match '"status"\s*:\s*"ok"')
}

function Get-GcioVersionFromHealth {
  param([string]$Body)
  if (-not $Body) { return '' }
  if (($Body -replace "`0", '') -match '"version"\s*:\s*"([^"]+)"') { return $Matches[1] }
  return ''
}

# An unreachable or erroring endpoint is "not healthy", never an exception:
# this is called in a retry loop where a connection refused during boot is the
# normal case, not a fault.
function Get-GcioHealthBody {
  param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSec = 5)
  try { return (Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing).Content }
  catch { return '' }
}

function Test-GcioHealth {
  param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSec = 5)
  return Test-GcioHealthBody (Get-GcioHealthBody -Url $Url -TimeoutSec $TimeoutSec)
}

# ---------------------------------------------------------------- release policy

<#
  Which component of X.Y.Z moved between two versions.

  'none', 'downgrade' and 'unknown' are distinct verdicts on purpose: each is a
  reason to refuse a release, and collapsing them would lose the operator's
  explanation for why.
#>
function Get-GcioBumpType {
  param([string]$BaseVersion, [string]$HeadVersion)
  if (-not $BaseVersion -or -not $HeadVersion) { return 'unknown' }
  try { $b = [version]$BaseVersion; $h = [version]$HeadVersion } catch { return 'unknown' }
  if ($h -eq $b) { return 'none' }
  if ($h -lt $b) { return 'downgrade' }
  if ($h.Major -gt $b.Major) { return 'major' }
  if ($h.Minor -gt $b.Minor) { return 'minor' }
  return 'patch'
}

<#
  Does this bump match what actually changed?

  The tier is decided by COMPATIBILITY, not by "did code change":
    - a Z bump may not carry a migration, a dependency change, a Node-major
      change, or new functionality;
    - a Y bump may not carry a breaking change.

  The feature rule lives INSIDE the patch branch deliberately. A minor carrying
  a feature is this function's success case. Do not hoist it "for symmetry" --
  in DEDB that exact change regressed three ways at once, including making an
  already-released version unbuildable from its own release commit.
#>
function Test-GcioReleaseBump {
  param(
    [string]$Bump, [bool]$MigrationsChanged, [bool]$DepsChanged,
    [bool]$NodeChanged, [bool]$Breaking, [bool]$FeatureAdded
  )
  $mk = { param($ok, $reason, $artifact) [pscustomobject]@{ Ok = [bool]$ok; Reason = "$reason"; Artifact = "$artifact" } }

  # Checked before the switch: a breaking change outranks every other rule.
  if ($Breaking -and $Bump -ne 'major') {
    return & $mk $false 'a breaking change requires a MAJOR bump and a full BUNDLE' 'bundle'
  }

  switch ($Bump) {
    'patch' {
      # Node first: it routes to MAJOR, not MINOR, so a combined change gets
      # the stronger answer rather than the first one that happens to match.
      if ($NodeChanged)       { return & $mk $false 'the Node runtime major changed -> bump the MAJOR and ship a BUNDLE' 'bundle' }
      if ($MigrationsChanged) { return & $mk $false 'migrations changed -> bump the MINOR and ship a BUNDLE, not a patch' 'bundle' }
      if ($DepsChanged)       { return & $mk $false 'dependencies changed -> bump the MINOR and ship a BUNDLE, not a patch' 'bundle' }
      if ($FeatureAdded)      { return & $mk $false 'new functionality (feat) -> bump the MINOR and ship a BUNDLE, not a patch' 'bundle' }
      return & $mk $true 'application-only change with no schema, dependency or runtime change' 'patch'
    }
    'minor' { return & $mk $true 'new backward-compatible functionality' 'bundle' }
    'major' { return & $mk $true 'breaking change - ship a bundle, back up first, and write upgrade notes' 'bundle' }
    'none'      { return & $mk $false 'no version bump - nothing to release' 'none' }
    'downgrade' { return & $mk $false 'the version went backwards - releases only move forward' 'none' }
    default     { return & $mk $false "unsupported bump '$Bump' - could not determine what changed" 'none' }
  }
}

# Scans commit BODIES: a breaking marker usually lives in a footer, not a subject.
function Test-GcioBreakingMarker {
  param([string]$LogBody)
  if (-not $LogBody) { return $false }
  if ($LogBody -match '(?m)^\s*BREAKING[ -]CHANGE\s*:') { return $true }
  if ($LogBody -match '(?m)^\s*[a-z]+(\([^)]*\))?!\s*:') { return $true }
  return $false
}

<#
  Scans commit SUBJECTS only, line-anchored.

  Deliberately not bodies, unlike the breaking check: a squash-merge body quotes
  every original commit bullet, so scanning bodies would false-positive on any
  release commit that merely summarises what merged.

  This is a BACKSTOP, not a guarantee. A feature squash-merged under a
  non-conventional PR title is not detected, and no amount of regex fixes that.
#>
function Test-GcioFeatureMarker {
  param([string]$Subjects)
  if (-not $Subjects) { return $false }
  return [bool]($Subjects -match '(?m)^\s*feat(\([^)]*\))?!?\s*:')
}

function Get-GcioNotesHeading {
  param([string]$Version)
  return "## GCIO $Version"
}

<#
  A release with no operator-facing notes ships silently: nobody on the host
  side can tell what the update contains or that they need to run it.
#>
function Test-GcioReleaseNotes {
  param([string]$Notes, [string]$Version)
  $head = Get-GcioNotesHeading -Version $Version
  # Anchored at both ends so "## GCIO 1.6.01" cannot satisfy 1.6.0.
  if ($Notes -and ($Notes -match ('(?m)^' + [regex]::Escape($head) + '\s*$'))) {
    return @{ Ok = $true; Reason = "release notes present for $Version" }
  }
  return @{ Ok = $false; Reason = "deploy/RELEASE-NOTES.md has no '$head' section - write the operator-facing notes before releasing" }
}

<#
  The most recent commit whose SUBJECT is "release X.Y.Z ...", from
  `git log --format='%H%x09%s'`.

  Subject only, never the body: a squash-merge body quotes everything that
  merged, so a body scan would match prose about a release and pick the wrong
  base ref - which silently changes what the whole preflight compares against.
#>
function Get-GcioReleaseCommitSha {
  param([string[]]$LogLines)
  foreach ($l in $LogLines) {
    $parts = "$l" -split "`t", 2
    if ($parts.Count -lt 2) { continue }
    if ($parts[1] -match '^release\s+\d+\.\d+\.\d+(\s|$)') { return $parts[0] }
  }
  return ''
}

# ---------------------------------------------------------------- stop window

<#
  Is a port held, and by whom?

  LocalAddress scopes the probe to one bound IP. That is not cosmetic on a host
  running several applications on the same port behind different addresses: an
  unscoped probe sees a neighbour's listener, concludes our own stop has not
  finished, and force-kills its way toward a state that had already been
  reached. Empty means "match any address".
#>
function Test-GcioPortInUse {
  param([Parameter(Mandatory)][int]$Port, [string]$LocalAddress = '')
  try {
    $conns = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($LocalAddress) { $conns = @($conns | Where-Object { $_.LocalAddress -eq $LocalAddress }) }
    if ($conns.Count) { return $conns[0] }
    return $null
  } catch { return $null }
}

<#
  Wait for a stopped service to ACTUALLY let go, then force-kill what did not.

  This is the guard the deploy sequence rests on. A patch is
  stop -> overlay -> start -> health-check, and every step after the stop
  assumes the old process is gone. If it is not, the overlay writes new files
  underneath a process still serving from memory, and the health check that
  follows can be answered by the very process the patch was meant to replace -
  reporting health=OK having verified nothing.

  A fixed sleep cannot do this. `sc.exe stop` returns when the SCM has accepted
  the request, not when the process has exited and released its socket, and how
  long that takes depends on in-flight requests and the shutdown path.

  Returns { Clean; Killed; Reason }. Clean=$false means the port is still held
  by something this could not stop, and the CALLER MUST NOT PROCEED - overlaying
  then is the exact failure described above.

  Every probe is injectable so the sequence can be tested without a service.
#>
function Wait-GcioCleanStop {
  param(
    [Parameter(Mandatory)][string]$InstallDir,
    [int]$Port = 0,
    [int]$GraceSec = 12,
    [string]$BindAddr = '',
    [scriptblock]$GetProcs = $null,
    [scriptblock]$TestPort = $null,
    [scriptblock]$KillProc = $null,
    [scriptblock]$Sleep = $null
  )

  # Node processes running FROM this install. Scoped by path so a developer's
  # unrelated node, or another application's, is never a candidate for killing.
  $getProcs = if ($GetProcs) { $GetProcs } else {
    { param($d) @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($d, [StringComparison]::OrdinalIgnoreCase) }) }
  }
  $testPort = if ($TestPort) { $TestPort } else { { param($p, $addr) [bool](Test-GcioPortInUse -Port $p -LocalAddress $addr) } }
  $killProc = if ($KillProc) { $KillProc } else { { param($procId) try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { } } }
  $sleep    = if ($Sleep)    { $Sleep }    else { { param($ms) Start-Sleep -Milliseconds $ms } }

  $killed = @()
  $clean = $false
  $steps = [Math]::Max(1, [int]($GraceSec * 2))   # 500ms steps

  for ($i = 0; $i -lt $steps; $i++) {
    $procs = @(& $getProcs $InstallDir)
    $busy = if ($Port -gt 0) { [bool](& $testPort $Port $BindAddr) } else { $false }
    if ($procs.Count -eq 0 -and -not $busy) { $clean = $true; break }
    & $sleep 500
  }

  if (-not $clean) {
    Write-GcioWarn "the service did not fully release after stop - force-killing leftover node processes under $InstallDir"
    foreach ($p in @(& $getProcs $InstallDir)) {
      & $killProc $p.ProcessId
      $killed += $p.ProcessId
    }
    & $sleep 500
    $stillBusy = if ($Port -gt 0) { [bool](& $testPort $Port $BindAddr) } else { $false }
    $stillProcs = @(& $getProcs $InstallDir).Count
    if (-not $stillBusy -and $stillProcs -eq 0) {
      return [pscustomobject]@{ Clean = $true; Killed = $killed; Reason = 'clean after force-kill' }
    }
    # Held by something outside this install. Say so and let the caller refuse:
    # proceeding would overlay under a live listener.
    return [pscustomobject]@{
      Clean = $false; Killed = $killed
      Reason = "port $Port still held after force-kill (by a process outside $InstallDir, or one that could not be stopped)"
    }
  }

  return [pscustomobject]@{ Clean = $true; Killed = $killed; Reason = 'stopped cleanly' }
}

<#
  Wait for the SCM to settle on a state.

  `sc.exe stop` returning does not mean Stopped - it commonly means
  STOP_PENDING, and a stale STOP_PENDING can strand the later start, leaving
  the service down after an apparently successful patch.

  A service that does not exist counts as reaching Stopped: there is nothing to
  wait for, and a rehearsal install with no service registered is a valid case.
#>
function Wait-GcioServiceState {
  param(
    [Parameter(Mandatory)][string]$State,
    [string]$ServiceName = 'GCIOProjectIntelligence',
    [int]$TimeoutSec = 30,
    [scriptblock]$GetState = $null,
    [scriptblock]$Sleep = $null
  )
  $getState = if ($GetState) { $GetState } else {
    { $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
      if ($null -eq $svc) { return $null }
      return "$($svc.Status)" }
  }
  $sleep = if ($Sleep) { $Sleep } else { { param($ms) Start-Sleep -Milliseconds $ms } }

  $steps = [Math]::Max(1, [int]($TimeoutSec * 2))
  for ($i = 0; $i -lt $steps; $i++) {
    $s = & $getState
    if ($null -eq $s) { return $true }       # no such service - nothing to wait for
    if ("$s" -eq $State) { return $true }
    & $sleep 500
  }
  return $false
}

<#
  Suppress or restore NSSM's automatic restart.

  AppExit=Restart is armed at install so NSSM can self-heal a crash of the
  running application. Left armed across an overlay it does the opposite: it
  RESURRECTS the old application while its files are being replaced underneath
  it. Suppress it for the stop -> overlay -> start window and restore it on
  every exit path - success, rollback, or a thrown error - or a future crash
  goes unrestarted.

  Never throws. A failure to restore during a rollback would be a second fault
  stacked on the first, and the caller is already handling one.
#>
function Set-GcioNssmAutoRestart {
  param(
    [Parameter(Mandatory)][string]$Nssm,
    [Parameter(Mandatory)][bool]$Enabled,
    [string]$ServiceName = 'GCIOProjectIntelligence',
    [scriptblock]$Invoke = $null
  )
  $action = if ($Enabled) { 'Restart' } else { 'Exit' }
  $invoke = if ($Invoke) { $Invoke } else { { param($exe, $a, $b, $c) & $exe set $ServiceName $b $c | Out-Null } }
  try { & $invoke $Nssm $ServiceName 'AppExit Default' $action | Out-Null } catch { }
}
