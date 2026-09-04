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
<#
  The argument vector for setting nssm's exit action. Separate from the call so
  the SHAPE can be asserted.

  nssm takes `set <service> AppExit Default <action>` as FIVE arguments. Passing
  "AppExit Default" as one string is rejected with
  `Invalid parameter "AppExit Default"` and a list of every valid parameter -
  which is what happened on the first real deploy that used this. The original
  test asserted a CONCATENATED string of the call, so it matched
  "AppExit Default Exit" while the arguments underneath were wrong, and passed.
  Returning the vector is what makes the structure testable.
#>
function Get-GcioNssmAutoRestartArgs {
  param([Parameter(Mandatory)][string]$ServiceName, [Parameter(Mandatory)][bool]$Enabled)
  $action = if ($Enabled) { 'Restart' } else { 'Exit' }
  return @('set', $ServiceName, 'AppExit', 'Default', $action)
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
  $argv = Get-GcioNssmAutoRestartArgs -ServiceName $ServiceName -Enabled $Enabled
  $invoke = if ($Invoke) { $Invoke } else { { param($exe, $a) & $exe @a | Out-Null } }
  try { & $invoke $Nssm $argv | Out-Null } catch { }
}

# ---------------------------------------------------------------- update flow

<#
  Choose which artifact to apply when several are present.

  THE BUNDLE WINS when its version is at least the newest patch's. A bundle can
  do everything a patch can and more, so preferring it is never the less-capable
  choice - and picking the patch instead would risk overlaying onto a base the
  operator meant to replace wholesale.

  Pure: takes names, returns a decision. The caller does the file work, and this
  can be tested without a release folder.

  Returns { Name; Kind; Version; Reason } or $null when there is nothing to do.
#>
function Select-GcioArtifact {
  param([string[]]$Names)
  $cands = @()
  foreach ($n in @($Names)) {
    if ($n -match '^gcio-(patch|bundle)-(\d+\.\d+\.\d+)') {
      $cands += [pscustomobject]@{ Name = $n; Kind = $Matches[1]; Version = [version]$Matches[2] }
    }
  }
  if (-not $cands.Count) { return $null }

  $patches = @($cands | Where-Object { $_.Kind -eq 'patch' })
  $bundles = @($cands | Where-Object { $_.Kind -eq 'bundle' })
  $newestPatch  = if ($patches.Count) { ($patches | Sort-Object Version -Descending | Select-Object -First 1).Version } else { $null }
  $newestBundle = if ($bundles.Count) { ($bundles | Sort-Object Version -Descending | Select-Object -First 1).Version } else { $null }

  if ($newestBundle -and (-not $newestPatch -or $newestBundle -ge $newestPatch)) {
    $pick = $bundles | Where-Object { $_.Version -eq $newestBundle } | Select-Object -First 1
    $why = if ($newestPatch) { "a bundle ($newestBundle) at or above the newest patch ($newestPatch) - the bundle wins" } else { 'the only tier present is a bundle' }
    return [pscustomobject]@{ Name = $pick.Name; Kind = 'bundle'; Version = $pick.Version; Reason = $why }
  }

  $pick = $patches | Where-Object { $_.Version -eq $newestPatch } | Select-Object -First 1
  $why = if ($newestBundle) { "the newest patch ($newestPatch) is above every bundle present ($newestBundle)" } else { 'the only tier present is a patch' }
  return [pscustomobject]@{ Name = $pick.Name; Kind = 'patch'; Version = $pick.Version; Reason = $why }
}

<#
  Should this artifact be applied to this install?

  Refuses a re-apply and refuses a downgrade, both having changed nothing. A
  re-apply is usually an operator running a release folder twice; a downgrade
  almost always is a mistake. -Force overrides either.

  Returns { Proceed; Code; Message }. Code is one of: first-install, upgrade,
  same-version, downgrade, forced.
#>
function Test-GcioVersionGate {
  param([string]$Installed, [string]$Artifact, [bool]$Force = $false)
  $mk = { param($proceed, $code, $msg) [pscustomobject]@{ Proceed = [bool]$proceed; Code = "$code"; Message = "$msg" } }

  if ($Installed -eq 'none' -or -not $Installed) {
    return & $mk $true 'first-install' 'no existing install - this will be a first install'
  }
  $toVer = { param($s) try { [version]($s -replace '[^0-9.]', '') } catch { [version]'0.0.0' } }
  $cv = & $toVer $Installed
  $tv = & $toVer $Artifact

  if ($tv -eq $cv) {
    if ($Force) { return & $mk $true 'forced' "re-applying $Artifact over the same installed version (-Force)" }
    return & $mk $false 'same-version' "this host is already on $Installed - nothing to do. Use -Force to re-apply, or -Rollback to revert."
  }
  if ($tv -lt $cv) {
    if ($Force) { return & $mk $true 'forced' "downgrading $Installed -> $Artifact (-Force)" }
    return & $mk $false 'downgrade' "artifact $Artifact is OLDER than the installed $Installed - refusing to downgrade. NOTHING was changed. Use -Force to override, or -Rollback to revert."
  }
  return & $mk $true 'upgrade' "will move $Installed -> $Artifact"
}

# ---------------------------------------------------------------- sql pre-check

<#
  Is SQL Server reachable, checked BEFORE the first mutation?

  Run before the copy-backup and before the stop, so a database that is down
  aborts a deploy having changed nothing - rather than the deploy proceeding,
  failing its health check, and rolling back for a reason that has nothing to do
  with the patch.

  GCIO needs this more than it appears. /healthz reports process liveness and
  never consults the store, so the health gate cannot distinguish "the new code
  is broken" from "SQL is unreachable": it sees no answer either way and rolls
  back. This host has already had exactly that failure - SQL Server crashed
  mid-deploy on 2026-08-28 (System event 7034).

  The probe is the application's OWN scripts/db-check.mjs, which builds its
  connection through server/db/pool.js's buildConfig. A pass therefore means the
  app's configuration is right, not merely that some connection string
  somewhere works. It runs with the working directory at the INSTALL ROOT
  because dotenv reads .env from the working directory and .env lives there,
  while the script lives under app\scripts.

  THE ASYMMETRY IS THE DESIGN. Only a DEFINITIVE failure - the probe ran and
  said no - returns Ok=$false. Everything the probe cannot establish (no node,
  no script, no .env, a store that is not SQL, a probe that throws) returns
  Ok=$true with Inconclusive=$true. A pre-check that blocks a deploy because it
  could not run is worse than none: it teaches operators to pass
  -SkipSqlPrecheck permanently, and then it protects nobody.

  Returns { Ok; Inconclusive; Reason }.
#>
function Test-GcioSqlReady {
  param(
    [Parameter(Mandatory)][string]$InstallDir,
    [scriptblock]$Invoke = $null
  )
  $mk = { param($ok, $incon, $reason) [pscustomobject]@{ Ok = [bool]$ok; Inconclusive = [bool]$incon; Reason = "$reason" } }

  $envFile = Join-Path $InstallDir '.env'
  if (-not (Test-Path $envFile)) {
    return & $mk $true $true "no .env at $envFile - STORE is unknown, so nothing is claimed either way"
  }
  $store = ''
  foreach ($line in (Get-Content $envFile)) { if ($line -match '^\s*STORE\s*=\s*(\S+)') { $store = $Matches[1] } }
  if ($store -ne 'mssql') {
    return & $mk $true $true "STORE=$store does not use SQL Server - nothing to probe"
  }

  $node = Join-Path $InstallDir 'runtime\node\node.exe'
  if (-not (Test-Path $node)) {
    return & $mk $true $true "no bundled runtime at $node - cannot probe, proceeding"
  }
  $probe = Join-Path $InstallDir 'app\scripts\db-check.mjs'
  if (-not (Test-Path $probe)) {
    return & $mk $true $true "no db-check.mjs in this install - cannot probe, proceeding"
  }

  $invoke = if ($Invoke) { $Invoke } else {
    { param($nodeExe, $scriptPath, $cwd)
      Push-Location $cwd
      try {
        $out = & $nodeExe $scriptPath 2>&1 | ForEach-Object { "$_" }
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($out -join "`n") }
      } finally { Pop-Location } }
  }

  $result = $null
  try { $result = & $invoke $node $probe $InstallDir }
  catch { return & $mk $true $true "the probe could not run ($($_.Exception.Message)) - proceeding" }

  if ($null -eq $result) { return & $mk $true $true 'the probe returned nothing - proceeding' }
  if ([int]$result.ExitCode -eq 0) { return & $mk $true $false 'SQL Server is reachable with this configuration' }

  # The one blocking verdict: the probe ran and said no.
  return & $mk $false $false "SQL Server is NOT reachable: $($result.Output)"
}

# ---------------------------------------------------------------- failure log

# Current length of a log in bytes, or 0 when it does not exist yet. Recorded
# BEFORE a deploy touches anything, so what follows can be told apart from what
# was already there.
function Get-GcioLogLength {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return 0 }
  try { return (Get-Item -LiteralPath $Path).Length } catch { return 0 }
}

<#
  What a log gained after a recorded offset.

  A log SHORTER than the marker has been rotated or truncated, which makes the
  offset meaningless; fall back to the whole file, since that is the best
  available answer rather than nothing or an exception.
#>
function Get-GcioLogSince {
  param([Parameter(Mandatory)][string]$Path, [long]$Since = 0, [int]$MaxLines = 40)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  try {
    $len = (Get-Item -LiteralPath $Path).Length
    if ($len -le $Since) {
      if ($len -lt $Since) {
        # rotated: the marker no longer refers to this file
        $all = [IO.File]::ReadAllText($Path)
        return (($all -split "`r?`n" | Select-Object -Last $MaxLines) -join "`n").Trim()
      }
      return ''
    }
    $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      [void]$fs.Seek($Since, [IO.SeekOrigin]::Begin)
      $buf = New-Object byte[] ($len - $Since)
      [void]$fs.Read($buf, 0, $buf.Length)
      $text = [Text.Encoding]::UTF8.GetString($buf)
    } finally { $fs.Dispose() }
    return (($text -split "`r?`n" | Select-Object -Last $MaxLines) -join "`n").Trim()
  } catch { return '' }
}

<#
  What to show an operator when a health check has just failed.

  SINCE, not TAIL. A service log accumulates across deploys - this host's
  service-err.log holds 15 stack traces from a deliberately broken patch applied
  on 2026-08-29 - so printing the tail sends whoever reads it chasing a fault
  that stopped existing hours ago. Only what THIS deploy produced is useful, and
  saying "nothing new" is itself a finding: a service that never started writes
  nothing at all.

  Pure - returns lines, does not print or exit - so both install.ps1 and
  code-update.ps1 can print it through their own helper, and it is testable.
  Never throws: it runs when something has already gone wrong, and a second
  fault stacked on the first helps nobody.
#>
function Show-GcioFailureLog {
  param(
    [Parameter(Mandatory)][string]$InstallDir,
    [long]$SinceOut = 0,
    [long]$SinceErr = 0,
    [string]$ProbeUrl = ''
  )
  $lines = @()
  try {
    $logDir = Join-Path $InstallDir 'logs'
    $errPath = Join-Path $logDir 'service-err.log'
    $outPath = Join-Path $logDir 'service-out.log'

    $lines += '--- what the application logged during THIS deploy ---'
    if ($ProbeUrl) { $lines += "    probed: $ProbeUrl" }

    $err = Get-GcioLogSince -Path $errPath -Since $SinceErr
    $out = Get-GcioLogSince -Path $outPath -Since $SinceOut

    if ($err) {
      $lines += ''
      $lines += "  stderr ($errPath):"
      foreach ($l in ($err -split "`n")) { $lines += "    $l" }
    }
    if ($out) {
      $lines += ''
      $lines += "  stdout ($outPath):"
      foreach ($l in ($out -split "`n")) { $lines += "    $l" }
    }
    if (-not $err -and -not $out) {
      $lines += ''
      $lines += '  nothing new was logged by this deploy.'
      $lines += "  A service that never started writes nothing at all - check that it is registered,"
      $lines += "  and that $errPath is writable."
    }
    $lines += ''
    $lines += "  Older entries in those files are from EARLIER deploys and are not shown."
    $lines += "  Read them directly if you need them, and check timestamps before believing a trace."
  } catch {
    $lines += "  (could not read the service logs: $($_.Exception.Message))"
  }
  return $lines
}

# ---------------------------------------------------------------- uninstall

<#
  What an uninstall would remove. Pure - computes a plan, deletes nothing - so
  what-gets-destroyed is asserted by tests without destroying anything, and so
  the operator can be shown the list before it happens.

  DEDB has a single -Purge that takes the application and its data together.
  GCIO splits it deliberately, because the two are not comparable losses:

    app/, runtime/   reproducible from any release artifact
    app.bak-*        copies of the above; useless once app/ is gone
    vault/           THE AUDIT TRAIL. What makes "what did that workbook
                     actually say" answerable later. Nothing else holds it.
    data/            the live drop folder
    .env             holds the database password; not reproducible

  So removing the service destroys nothing, removing the application is a
  separate switch, and destroying state is a third that has to say out loud what
  it is taking.

  Returns { Valid; RemovesService; DestroysState; Paths; Warnings; Summary }.
#>
<#
  Join two path segments as TEXT.

  Join-Path validates that the drive exists, which a pure planning function must
  not do - a plan for D:\elsewhere has to be computable on a machine with no D:
  drive, and a test that can only run against real directories is not testing
  the planner.
#>
function Join-GcioPathLiteral {
  param([string]$Base, [string]$Leaf)
  # [char]92 is a backslash. Written as a codepoint on purpose: this line has
  # been silently emptied twice by tooling that ate the escape, producing
  # "C:\gcioapp" with no separator - and the test that was meant to catch it
  # used a prefix glob, which "C:\gcioapp" still matches. Assert the separator.
  $sep = [string][char]92
  return ($Base.TrimEnd($sep) + $sep + $Leaf)
}

function Get-GcioUninstallPlan {
  param(
    [Parameter(Mandatory)][string]$InstallDir,
    [switch]$RemoveApp,
    [switch]$PurgeData
  )
  $paths = @()
  $warnings = @()
  $valid = $true
  $summary = 'stop and remove the Windows service; nothing on disk is deleted'

  if ($PurgeData -and -not $RemoveApp) {
    return [pscustomobject]@{
      Valid = $false; RemovesService = $true; DestroysState = $false
      Paths = @(); Warnings = @()
      Summary = '-PurgeData requires -RemoveApp: leaving the application installed with its drop folder and vault deleted is not a state anyone wants.'
    }
  }

  if ($RemoveApp) {
    $paths += (Join-GcioPathLiteral $InstallDir 'app')
    $paths += (Join-GcioPathLiteral $InstallDir 'runtime')
    # Backups are copies of app/. Keeping them after deleting app/ leaves
    # hundreds of megabytes of directories nothing can restore into.
    $paths += (Join-GcioPathLiteral $InstallDir 'app.bak-*')
    $paths += (Join-GcioPathLiteral $InstallDir 'lib')
    foreach ($f in 'install.ps1', 'install-service.ps1', 'VERSION', 'versions.json') {
      $paths += (Join-GcioPathLiteral $InstallDir $f)
    }
    $summary = 'remove the service and the installed application; .env, the drop folder, the vault and the audit directory are KEPT'
  }

  if ($PurgeData) {
    $paths += (Join-GcioPathLiteral $InstallDir 'data')
    $paths += (Join-GcioPathLiteral $InstallDir 'vault')
    $paths += (Join-GcioPathLiteral $InstallDir 'audit')
    $paths += (Join-GcioPathLiteral $InstallDir 'logs')
    $paths += (Join-GcioPathLiteral $InstallDir '.env')
    $warnings += 'This DESTROYS the vault - the audit trail of every workbook ever ingested, and the only copy of those bytes. It cannot be reconstructed from the database or from a release artifact.'
    $warnings += 'It also destroys the drop folder, the audit directory, .env (which holds the database password), and the deploy log.'
    $warnings += 'The SQL database is NOT touched: the portfolio itself survives, and a fresh install pointed at the same database will serve it again.'
    $summary = 'remove the service, the application, AND all local state including the vault'
  }

  return [pscustomobject]@{
    Valid = $valid
    RemovesService = $true
    DestroysState = [bool]$PurgeData
    Paths = $paths
    Warnings = $warnings
    Summary = $summary
  }
}

<#
  Can this session actually stop and start the service?

  NOT "is it elevated". Elevation is the usual way to hold that right, but it is
  not the only one: a service's own security descriptor can grant start/stop to
  a named account, and on this project it was granted exactly that way. Checking
  the ROLE instead of the CAPABILITY refuses a session that is perfectly able to
  do the work - which is what happened the first time a deploy ran under such a
  grant.

  Administrator short-circuits to true. Otherwise the service descriptor is read
  and the caller's own SID looked for with both RP (start) and WP (stop).

  Group-granted rights are not detected: the SDDL would name the group, not the
  caller. That is a false NEGATIVE, so the worst case is telling someone to
  elevate when they need not - never the reverse.
#>
function Test-GcioCanControlService {
  param([string]$ServiceName = 'GCIOProjectIntelligence')
  try {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      return [pscustomobject]@{ Can = $true; Why = 'running elevated' }
    }
  } catch { }

  try {
    $sid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    $sddl = ((& sc.exe sdshow $ServiceName 2>&1) | Where-Object { $_ -match '^D:' }) -join ''
    if ($sddl) {
      foreach ($ace in [regex]::Matches($sddl, '\(([^)]*)\)')) {
        $parts = $ace.Groups[1].Value -split ';'
        if ($parts.Count -ge 6 -and $parts[5] -eq $sid) {
          $rights = $parts[2]
          if ($rights -match 'RP' -and $rights -match 'WP') {
            return [pscustomobject]@{ Can = $true; Why = "the service grants this account start/stop directly (not elevated)" }
          }
        }
      }
    }
  } catch { }

  return [pscustomobject]@{ Can = $false; Why = 'not elevated, and the service does not grant this account start/stop' }
}

<#
  The address this install binds to, for scoping a port probe.

  Wait-GcioCleanStop has taken a -BindAddr parameter since it was written, with
  a comment and a test. NOTHING PASSED IT: the only occurrence outside tests was
  the declaration, so every port probe was unscoped while appearing to be
  scoped. This is the missing half.

  Returns '' when the probe should NOT be scoped:
    - no .env, or no HOST setting
    - a wildcard bind (0.0.0.0 / ::) - scoping to it matches nothing useful
    - a hostname that does not resolve - Get-NetTCPConnection reports numeric
      addresses, so an unresolved name would filter everything out and silently
      unscope anyway, but loudly wrong instead of quietly right

  Loopback IS scoped, unlike DEDB, which treats it as "single-service, do not
  bother". Another application can bind the same port on a different address on
  this host family, and scoping to 127.0.0.1 is strictly more precise.

  Getting this wrong is SAFE in one direction only, and that is why it is worth
  doing: if the address is wrong the port probe matches nothing, but the process
  check under the install directory still sees a live node and reports the stop
  not-clean. The filter can only make the probe more precise, never blinder.
#>
function Get-GcioBindAddress {
  param([Parameter(Mandatory)][string]$InstallDir)
  $envFile = Join-Path $InstallDir '.env'
  if (-not (Test-Path $envFile)) { return '' }

  $bindHost = ''
  foreach ($line in (Get-Content $envFile)) {
    if ($line -match '^\s*HOST\s*=\s*(\S+)') { $bindHost = $Matches[1] }
  }
  if (-not $bindHost) { return '' }
  if ($bindHost -eq '0.0.0.0' -or $bindHost -eq '::' -or $bindHost -eq '*') { return '' }

  # Already numeric IPv4 - use it as-is.
  if ($bindHost -match '^\d{1,3}(\.\d{1,3}){3}$') { return $bindHost }

  # A name: resolve to IPv4, because the probe compares against numeric
  # LocalAddress values. Unresolvable means unscoped rather than a filter that
  # silently matches nothing.
  try {
    $ip = [System.Net.Dns]::GetHostAddresses($bindHost) |
      Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1
    if ($ip) { return $ip.IPAddressToString }
  } catch { }
  return ''
}

<#
  Set a single KEY=VALUE in a .env file, in place.

  Rewrites rather than appends, because install.ps1 leaves the LDAP service
  account settings behind as a COMMENTED placeholder block. An appender would
  add a second live copy below the commented one, and dotenv takes the last
  occurrence -- so the file would end up with a key that looks unset to a reader
  and set to something else to the app. Both the commented and uncommented forms
  are therefore treated as the same setting and replaced in place, which also
  makes this idempotent: running it twice leaves one line, not two.

  Surrounding comments, blank lines and ordering are preserved. Line endings are
  preserved by writing back with the same WriteAllLines the rest of deploy/ uses.

  Returns nothing; throws if the file is missing.
#>
function Set-GcioEnvSetting {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][AllowEmptyString()][string]$Value
  )
  if (-not (Test-Path -LiteralPath $Path)) { throw "no .env at $Path" }
  $lines = [IO.File]::ReadAllLines($Path)
  $out = [Collections.Generic.List[string]]::new()
  $written = $false
  # Anchored, and the key is escaped: a name containing regex metacharacters
  # must not match a different setting.
  $pattern = '^\s*#?\s*' + [Regex]::Escape($Name) + '\s*='
  foreach ($line in $lines) {
    if ($line -match $pattern) {
      if (-not $written) { $out.Add("$Name=$Value"); $written = $true }
      # later duplicates are dropped, so the file cannot keep a stale second copy
    } else { $out.Add($line) }
  }
  if (-not $written) { $out.Add("$Name=$Value") }
  [IO.File]::WriteAllLines($Path, $out)
}

<#
  The Node one-liner seal-secret.ps1 pipes a password into.

  Lives here rather than inline in the script so a test can render the REAL
  template and execute it. It was inline once, and shipped with bare absolute
  Windows paths in its import statements - which Node's ESM loader rejects with
  ERR_UNSUPPORTED_ESM_URL_SCHEME ("protocol c:"). Nothing caught it, because the
  only thing that ran the template was the interactive script nobody could test.

  Two forms of the same directory are needed and they are not interchangeable:
  imports must be file:// URLs, while resolveKeyFile takes a plain filesystem
  path. Rendering both from one input is what keeps them from drifting apart.

  The password arrives on STDIN, never argv - argv is readable by any process
  listing, any EDR agent, and Windows command-line auditing.
#>
function Get-GcioSealerScript {
  param([Parameter(Mandatory)][string]$AppRoot)
  # [IO.Path]::AltDirectorySeparatorChar rather than a regex: '\' alone is not a
  # valid pattern, and '\\' in a -replace is one escaped backslash, which is a
  # trap worth stepping around entirely.
  $slashed = $AppRoot.Replace('\', '/')
  return @"
import { makeSecretBox } from "file:///$slashed/server/crypto/secretBox.js";
import { loadOrCreateKey, resolveKeyFile } from "file:///$slashed/server/crypto/masterKey.js";
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const keyFile = resolveKeyFile("$slashed", process.env.GCIO_KEY_FILE);
process.stdout.write(makeSecretBox(loadOrCreateKey(keyFile)).seal(input) + "\n");
process.stderr.write("key: " + keyFile + "\n");
"@
}

<#
  Read one live KEY=VALUE out of a .env file, or $null.

  "Live" means uncommented: a commented line is an absent setting, not its
  value, which is the whole point of the placeholder block install.ps1 leaves
  behind. When a key appears more than once the LAST live copy wins, matching
  what dotenv actually loads - a reader who assumes "first" would show an
  operator a value the app is not using.
#>
function Get-GcioEnvSetting {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $pattern = '^\s*' + [Regex]::Escape($Name) + '\s*=(.*)$'
  $value = $null
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line -match $pattern) { $value = $Matches[1].Trim() }
  }
  return $value
}

<#
  Turn what an operator typed into something the directory will accept as a
  bind identity.

  Mirrors bindIdentity() in server/auth/ldap.js so the value written to .env is
  the same shape the app would have constructed. Already-qualified input is
  returned untouched: appending a suffix to a UPN produces svc@a.test@b.test,
  which fails as a credential error and reads like a wrong password.

  The refusal matters more than the derivation. A DN made only of DC= and OU=
  components names a CONTAINER, not an account - it is what you get by pasting
  the base DN into a prompt labelled "Bind DN", which is exactly what happened
  on this deployment. Binding as it fails with "invalid credentials", so the
  operator goes looking for a password problem that does not exist. Catch it
  here, while the person who typed it is still watching.
#>
function Resolve-GcioBindIdentity {
  param(
    [Parameter(Mandatory)][AllowEmptyString()][string]$User,
    [string]$BaseDN,
    [string]$Domain,
    [string]$UpnSuffix
  )
  $u = $User.Trim()
  if (-not $u) { throw 'a username is required' }

  # Order matters: a full DN contains OU= and DC= too, so it has to be
  # recognised before the container check rejects those components.
  if ($u -match '(?i)^\s*CN\s*=') { return $u }
  if ($u -match '(?i)(^|,)\s*(DC|OU)\s*=') {
    throw ("'$u' looks like a directory path, not an account. It has no CN= " +
           'component, so it names a container rather than a user - this is ' +
           'the BASE DN, which is configured separately. Enter just the ' +
           "account name (for example: svc_app), or a full DN beginning CN=.")
  }
  if ($u.Contains('@') -or $u.Contains('\')) { return $u }

  $suffix = if ($UpnSuffix) { $UpnSuffix.Trim() }
            elseif ($BaseDN) {
              # DC=example,DC=test -> example.test
              (($BaseDN -split ',' | ForEach-Object { $_.Trim() } |
                Where-Object { $_ -match '(?i)^DC=' } |
                ForEach-Object { $_.Substring(3) }) -join '.')
            } else { '' }

  if ($suffix) { return "$u@$suffix" }
  if ($Domain) { return "$Domain" + [char]92 + "$u" }
  return $u
}

<#
  Expand a zip, quickly, without giving up the safety net.

  Expand-Archive charges per file, and a bundle is 17,571 entries of which
  15,312 are node_modules. Measured on the real 77.8 MB artifact:

      Expand-Archive                      730.4s
      ZipFile::ExtractToDirectory         205.3s
      per-entry loop with progress        462.6s

  So this uses bulk extraction, which is 3.6x faster than what it replaces. It
  is also 2.3x faster than DEDB's per-entry version, whose own comment says it
  exists to render a progress bar rather than to be quick - worth knowing
  before copying it wholesale.

  ANY failure falls back to Expand-Archive. That idea IS DEDB's and it is the
  right one: an odd-but-valid archive must never brick an update that used to
  work, and the slow path is still a working path.

  Zip-slip is handled by ExtractToDirectory itself, which refuses entries
  resolving outside the destination. That is asserted in
  deploy/test/expand-archive.test.ps1 rather than assumed, because if it were
  untrue this change would silently drop a security property DEDB implements by
  hand.

  -FastExtractor exists so the fallback can be tested by injection. Simulating
  it with a corrupt archive would fail both paths and prove nothing.
#>
function Expand-GcioArchive {
  param(
    [Parameter(Mandatory)][string]$Zip,
    [Parameter(Mandatory)][string]$Dest,
    [switch]$Force,
    [scriptblock]$FastExtractor
  )
  if (-not (Test-Path -LiteralPath $Zip)) { throw "archive not found: $Zip" }

  $fast = if ($FastExtractor) { $FastExtractor } else {
    {
      param($z, $d, $f)
      try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop } catch { }
      # The three-argument overload takes an overwrite flag but does not exist
      # on Windows PowerShell 5.1's .NET Framework, so it is looked up rather
      # than called blind; without it, a clean destination gives the same
      # result, and the call sites already remove theirs.
      $m = [System.IO.Compression.ZipFile].GetMethod('ExtractToDirectory', [Type[]]@([string], [string], [bool]))
      if ($m) {
        # [object[]] with each argument cast explicitly. PowerShell wraps values
        # placed in a plain @() into PSObject, and Invoke then fails with
        # "PSObject cannot be converted to type 'System.String'" - which the
        # catch below would swallow into a silent fall back to the slow path.
        # That is exactly what happened: the real bundle took 402s instead of
        # 207s and nothing said why.
        [void]$m.Invoke($null, [object[]]@([string]$z, [string]$d, [bool]$f))
      }
      else { [System.IO.Compression.ZipFile]::ExtractToDirectory([string]$z, [string]$d) }
    }
  }

  $zipFull = (Resolve-Path -LiteralPath $Zip).Path
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $destFull = (Resolve-Path -LiteralPath $Dest).Path

  try {
    & $fast $zipFull $destFull $Force.IsPresent
  } catch {
    $msg = "$($_.Exception.Message)"
    # A traversal entry is a refusal, not a malfunction. Falling back would
    # hand the archive to a second extractor and hope it declines too.
    if ($msg -match 'outside the destination|zip-slip|Extracting Zip entry would have resulted') { throw }
    Write-GcioWarn "fast extraction of $(Split-Path $Zip -Leaf) failed ($msg) - falling back to Expand-Archive"
    Expand-Archive -LiteralPath $Zip -DestinationPath $Dest -Force
  }
}
