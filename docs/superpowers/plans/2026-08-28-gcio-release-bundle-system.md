# GCIO Release Bundle System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give GCIO the same two-tier, gated, self-verifying release system DEDB has — a full bundle and a patch overlay, where the version number decides the tier and fail-closed gates refuse a patch that cannot safely apply.

**Architecture:** Port `C:\dev\DExDashBoard\deploy` to GCIO, renaming `Dedb` → `Gcio` throughout. Two artifacts (`gcio-bundle-X.Y.Z-win-x64.zip`, `gcio-patch-X.Y.Z-win-x64.zip`) built from one repo. Four fail-closed host gates run before any mutation; the same helper functions run at release time so preflight and the host can never disagree. Every apply is health-gated with automatic rollback to a copy-backup taken while the old version is still serving.

**Tech Stack:** PowerShell 7 (build), PowerShell 5.1-compatible (host), NSSM, Node 24.19.0 pinned by URL + SHA-256, `node:test` for the JS side, plain `.test.ps1` scripts for the deploy side.

---

## Source of truth

Read these before starting. They are the system being cloned, and every non-obvious decision in this plan traces to one of them:

- `C:\dev\DExDashBoard\RELEASING.md` — the policy: what bump, what tier, why.
- `C:\dev\DExDashBoard\deploy\lib\common.ps1` — the 1,585-line helper library. The gates live at lines 1037–1210.
- `C:\dev\DExDashBoard\deploy\build-bundle.ps1`, `build-patch.ps1`, `verify-bundle.ps1`, `verify-patch.ps1`, `preflight-release.ps1`.
- `C:\dev\DExDashBoard\deploy\install.ps1` — the `-Patch` path's health gate and auto-rollback, lines 107–180.

**Access constraint:** treat `C:\dev\DExDashBoard` as **read-only**. Do not edit, commit, build, or run tests in it, and do not touch its databases. A peer session reported that its owner asked for it to be left alone; reading it to port the design was authorised by the user directly, nothing more.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Schema-change detection | EOL-normalized SHA-256 of the whole `server/db/migrations.js` | GCIO has no `.sql` directory to fingerprint. Whole-file hashing over-triggers (a comment edit forces a bundle) but never under-triggers, which is the safe direction for a gate. |
| Migration timing | Keep auto-apply at boot (`server/index.js:68`) | Proven behaviour. The gate makes it safe: a patch whose migrations differ is refused, so a schema change can only arrive inside a bundle the operator chose. |
| Scope | Full clone — both tiers, all gates, preflight, notes gate, tests | The gates are worth little individually; a patch tier without its four gates is the failure mode the system exists to prevent. |

## File structure

| Path | Responsibility |
|---|---|
| `deploy/lib/common.ps1` | **New.** Shared helpers: logging, hashing, health probing, backup/restore/overlay, the four gates, release-policy helpers. The only file both build-time and host-time code sources. |
| `deploy/versions.json` | **New.** Pins Node and NSSM by URL + SHA-256. |
| `deploy/build-bundle.ps1` | **New.** Full artifact: app + `node_modules` + runtime + installers. |
| `deploy/build-patch.ps1` | **New.** App-subset overlay + `patch-meta.json`. |
| `deploy/verify-bundle.ps1` / `verify-patch.ps1` | **New.** Re-hash `checksums.txt`; `verify-patch` also refuses an artifact carrying a runtime. |
| `deploy/install.ps1` | **New.** `-Bundle` (full install/upgrade), `-Patch` (gated overlay), `-Rollback`. |
| `deploy/code-update.ps1` + `deploy/Update-GCIO.cmd` | **New.** The updater. Ships **outside** the archive — it is what unzips the archive. |
| `deploy/preflight-release.ps1` | **New.** Release-time gate: bump vs what changed, breaking/feature markers, notes. |
| `deploy/release.ps1` | **New.** Wraps bump → preflight → build. Adds no policy. |
| `deploy/RELEASE-NOTES.md` | **New.** Operator-facing notes, newest first, `## GCIO X.Y.Z`. |
| `RELEASING.md` | **New.** The releaser's single source of truth. |
| `deploy/test/*.test.ps1` | **New.** One file per gate/behaviour. |
| `deploy/install-service.ps1` | **Existing, keep.** Its `Read-EnvPairs` / preflight logic is reused, not replaced. |
| `server/app.js:31` | **Modify.** `VERSION` is hardcoded `"1.0.0"`. |

## Naming conventions

- Functions: `Write-GcioLog`, `Test-GcioPatchCompatible`, … (DEDB's `Dedb` → `Gcio`).
- Artifacts: `gcio-bundle-1.6.0-win-x64.zip`, `gcio-patch-1.5.1-win-x64.zip`.
- Log prefix: `[gcio]`.
- Service: `GCIOProjectIntelligence`. Install dir: `C:\gcio`.
- Output dir: `dist-bundle/` at repo root. **Add it to `.gitignore`** — and anchor the entry (`/dist-bundle/`), because this repo has already been bitten once by an unanchored `audit/` swallowing `test/audit/`.

---

## Task 1: Fix the version `/healthz` reports

The whole system compares versions. `/healthz` currently lies, so fix it before anything reads it.

**Files:**
- Modify: `server/app.js:31`
- Test: `test/api/health.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import request from "supertest";
import { createApp } from "../../server/app.js";
import { MemoryStore } from "../../server/store/memoryStore.js";

test("/healthz reports the real package version, not a hardcoded one", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const app = createApp({ store: new MemoryStore(), authMode: "dev", devRole: "admin" });
  const res = await request(app).get("/healthz").expect(200);
  assert.equal(res.body.version, pkg.version,
    "a release system built on version comparison cannot have /healthz reporting a stale literal");
});
```

> Check `createApp`'s real signature in `server/app.js` and the existing tests in `test/api/` before writing this — match how they construct the app rather than the sketch above.

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test test/api/health.test.js
```

Expected: FAIL, `'1.0.0' !== '1.5.0'`.

- [ ] **Step 3: Read the version from `package.json`**

`server/metrics.js` already does this for `gcio_build_info`. Find how it reads the version and reuse that exact mechanism — do not add a second, differently-implemented reader. Replace `const VERSION = "1.0.0";` at `server/app.js:31` with it.

- [ ] **Step 4: Run the test and the full suite**

```bash
node --test test/api/health.test.js
```

```bash
npm test
```

Expected: the new test passes; total rises by 1, **fail 0**.

- [ ] **Step 5: Mutation-check**

Put `"1.0.0"` back. Confirm the new test goes red and the message names the real problem. Restore.

- [ ] **Step 6: Commit**

```bash
git add server/app.js test/api/health.test.js && git commit -m "fix(api): report the real version from /healthz"
```

---

## Task 2: Pin the runtime — `deploy/versions.json`

**Files:**
- Create: `deploy/versions.json`

- [ ] **Step 1: Get the real SHA-256 for Node 24.19.0 win-x64**

Do not invent these. Fetch the official checksum file and read the line:

```bash
curl -s https://nodejs.org/dist/v24.19.0/SHASUMS256.txt | grep 'node-v24.19.0-win-x64.zip'
```

If the machine is offline, stop and say so rather than writing a placeholder — a wrong hash makes every build fail at `Test-Sha256` with a message that looks like a tampering alert.

- [ ] **Step 2: Get the NSSM checksum**

DEDB pins NSSM 2.24 at `https://nssm.cc/release/nssm-2.24.zip` with sha256 `727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743`. Reuse that URL and hash. **Verify it independently** by hashing the copy already on this machine if its version matches:

```bash
sha256sum "/c/Users/<you>/AppData/Local/Microsoft/WinGet/Packages/NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe/nssm-2.24-101-g897c7ad/win64/nssm.exe"
```

That hashes the extracted `.exe`, not the zip, so it will **not** match the zip's hash — it only confirms which build you have. Note the result; do not treat a mismatch as a failure.

- [ ] **Step 3: Write the file**

```json
{
  "node": {
    "version": "24.19.0",
    "win-x64": {
      "url": "https://nodejs.org/dist/v24.19.0/node-v24.19.0-win-x64.zip",
      "sha256": "<from step 1>"
    }
  },
  "nssm": {
    "version": "2.24",
    "url": "https://nssm.cc/release/nssm-2.24.zip",
    "sha256": "727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743"
  }
}
```

Linux is deliberately omitted: GCIO deploys to Windows + IIS, and DEDB's own script refuses to cross-build Linux on Windows anyway (symlinks and exec bits are lost).

- [ ] **Step 4: Commit**

```bash
git add deploy/versions.json && git commit -m "build(deploy): pin the Node and NSSM runtime by URL and checksum"
```

---

## Task 3: `common.ps1` foundations — logging, hashing, JSON

**Files:**
- Create: `deploy/lib/common.ps1`
- Test: `deploy/test/common-basics.test.ps1`

- [ ] **Step 1: Write the failing test**

```powershell
# deploy/test/common-basics.test.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"
$fails = 0
function Assert-Eq($actual, $expected, $what) {
  if ("$actual" -ne "$expected") { Write-Host "[FAIL] $what : got '$actual' want '$expected'" -ForegroundColor Red; $script:fails++ }
  else { Write-Host "[ok] $what" -ForegroundColor Green }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("gcio-t-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  $f = Join-Path $tmp 'a.txt'
  [IO.File]::WriteAllText($f, 'hello')
  # sha256("hello")
  Assert-Eq (Get-GcioSha256 $f) '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' 'Get-GcioSha256 matches a known vector'

  $j = Join-Path $tmp 'v.json'
  [IO.File]::WriteAllText($j, '{"node":{"win-x64":{"url":"U"}}}')
  Assert-Eq (Get-GcioJsonValue $j 'node.win-x64.url') 'U' 'Get-GcioJsonValue walks a dotted key'
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

if ($fails) { Write-Host "$fails failed" -ForegroundColor Red; exit 1 }
Write-Host 'all passed' -ForegroundColor Green
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pwsh -NoProfile -File deploy/test/common-basics.test.ps1
```

Expected: FAIL — `common.ps1` does not exist yet.

- [ ] **Step 3: Write the foundations**

Port from `DExDashBoard/deploy/lib/common.ps1` lines 1–63, renaming. Keep the file **PowerShell 5.1-safe**: it is sourced on the host, where only 5.1 is guaranteed.

```powershell
# deploy/lib/common.ps1
Set-StrictMode -Version Latest

function Write-GcioLog  { param([string]$Msg) Write-Host "[gcio] $Msg" }
function Write-GcioWarn { param([string]$Msg) Write-Warning "[gcio] $Msg" }
function Stop-Gcio      { param([string]$Msg) Write-Error "[gcio] $Msg"; exit 1 }

function Get-GcioSha256 {
  param([Parameter(Mandatory)][string]$Path)
  # -LiteralPath, always: node_modules ships fixtures whose names contain
  # wildcard metachars ([ ]) which a positional path globs to $null, and
  # .Hash on $null throws a message that says nothing about the real cause.
  (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLower()
}

function Test-GcioSha256 {
  param([Parameter(Mandatory)][string]$Path, [string]$Expected)
  if (-not $Expected) { Write-GcioWarn "no expected sha256 for $Path - skipping verification"; return }
  $got = Get-GcioSha256 $Path
  if ($got -ne $Expected.ToLower()) {
    Stop-Gcio "checksum mismatch for $Path`n  expected $Expected`n  got      $got"
  }
}

function Invoke-GcioDownload {
  param([Parameter(Mandatory)][string]$Url, [Parameter(Mandatory)][string]$Dest, [int]$Tries = 3)
  for ($i = 1; $i -le $Tries; $i++) {
    try { Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing; return }
    catch { if ($i -eq $Tries) { throw }; Write-GcioWarn "download failed ($i/$Tries), retrying: $Url"; Start-Sleep 2 }
  }
}

function Get-GcioJsonValue {
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$DottedKey)
  $o = Get-Content -Raw $Path | ConvertFrom-Json
  foreach ($k in $DottedKey.Split('.')) {
    if ($null -eq $o) { return $null }
    $o = $o.$k
  }
  return $o
}
```

- [ ] **Step 4: Run the test**

```bash
pwsh -NoProfile -File deploy/test/common-basics.test.ps1
```

Expected: `all passed`.

- [ ] **Step 5: Commit**

```bash
git add deploy/lib/common.ps1 deploy/test/common-basics.test.ps1 && git commit -m "build(deploy): add common.ps1 hashing and json helpers"
```

---

## Task 4: The two fingerprints — schema and dependencies

These are the heart of the patch gate. Both must be immune to changes that do not alter meaning.

**Files:**
- Modify: `deploy/lib/common.ps1`
- Test: `deploy/test/fingerprint.test.ps1`

- [ ] **Step 1: Write the failing test**

```powershell
# deploy/test/fingerprint.test.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"
$fails = 0
function Assert-Eq($a, $b, $what)  { if ("$a" -ne "$b") { Write-Host "[FAIL] $what" -ForegroundColor Red; $script:fails++ } else { Write-Host "[ok] $what" -ForegroundColor Green } }
function Assert-Ne($a, $b, $what)  { if ("$a" -eq "$b") { Write-Host "[FAIL] $what" -ForegroundColor Red; $script:fails++ } else { Write-Host "[ok] $what" -ForegroundColor Green } }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("gcio-fp-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  # ---- schema fingerprint: EOL-immune, content-sensitive ----
  $lf   = Join-Path $tmp 'm-lf.js';   [IO.File]::WriteAllText($lf,   "export const MIGRATIONS = [`n  { id: 1 },`n];`n")
  $crlf = Join-Path $tmp 'm-crlf.js'; [IO.File]::WriteAllText($crlf, "export const MIGRATIONS = [`r`n  { id: 1 },`r`n];`r`n")
  $diff = Join-Path $tmp 'm-diff.js'; [IO.File]::WriteAllText($diff, "export const MIGRATIONS = [`n  { id: 2 },`n];`n")

  Assert-Eq (Get-GcioMigrationsFingerprint $lf) (Get-GcioMigrationsFingerprint $crlf) 'CRLF vs LF hashes the same (a checkout must not force a bundle)'
  Assert-Ne (Get-GcioMigrationsFingerprint $lf) (Get-GcioMigrationsFingerprint $diff) 'a changed migration changes the fingerprint'
  Assert-Eq (Get-GcioMigrationsFingerprint (Join-Path $tmp 'missing.js')) '' 'a missing file fingerprints as empty, not an error'

  # ---- lock deps hash: version-independent ----
  $l1 = Join-Path $tmp 'l1.json'
  $l2 = Join-Path $tmp 'l2.json'
  [IO.File]::WriteAllText($l1, '{"name":"g","version":"1.5.0","packages":{"":{"version":"1.5.0"},"node_modules/x":{"version":"2.0.0"}}}')
  [IO.File]::WriteAllText($l2, '{"name":"g","version":"1.6.0","packages":{"":{"version":"1.6.0"},"node_modules/x":{"version":"2.0.0"}}}')
  Assert-Eq (Get-GcioLockDepsHash $l1) (Get-GcioLockDepsHash $l2) 'an npm version bump alone does not change the deps hash'

  $l3 = Join-Path $tmp 'l3.json'
  [IO.File]::WriteAllText($l3, '{"name":"g","version":"1.5.0","packages":{"":{"version":"1.5.0"},"node_modules/x":{"version":"3.0.0"}}}')
  Assert-Ne (Get-GcioLockDepsHash $l1) (Get-GcioLockDepsHash $l3) 'a real dependency change DOES change the deps hash'
} finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }

if ($fails) { Write-Host "$fails failed" -ForegroundColor Red; exit 1 }
Write-Host 'all passed' -ForegroundColor Green
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pwsh -NoProfile -File deploy/test/fingerprint.test.ps1
```

Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement both**

```powershell
# ---- schema + dependency fingerprints ----

<#
  GCIO keeps its migrations as JS objects in server/db/migrations.js, not as a
  directory of .sql files (which is what DEDB fingerprints). So this hashes the
  whole file.

  The consequence, stated plainly because it will surprise someone: editing a
  COMMENT in migrations.js changes this hash and therefore forces a bundle,
  even though no schema changed. That is the safe direction -- the gate's job
  is to never let a schema change ride in on a patch, and over-triggering costs
  one bundle deploy while under-triggering costs a silent migration on a host
  the operator did not choose to migrate. Boot-time auto-apply
  (server/index.js) is exactly why under-triggering is unacceptable here.

  EOL-normalized so a Windows checkout flipping LF->CRLF never trips it.
#>
function Get-GcioMigrationsFingerprint {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $text = [IO.File]::ReadAllText($Path) -replace "`r`n", "`n"
  $sha  = [Security.Cryptography.SHA256]::Create()
  try {
    ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) -join ''
  } finally { $sha.Dispose() }
}

<#
  Hash a package-lock's DEPENDENCY set, ignoring the app's own version.

  Without nulling the root version, `npm version patch` alone would look like a
  dependency change and refuse every patch -- the exact false positive that
  makes a gate get switched off.

  Read as text and regex-null the root version rather than round-tripping
  through ConvertFrom-Json: npm lockfiles carry an empty-string key ("") which
  Windows PowerShell 5.1's ConvertFrom-Json refuses, and the host runs 5.1.
#>
function Get-GcioLockDepsHash {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  $text = [IO.File]::ReadAllText($Path) -replace "`r`n", "`n"
  # Top-level "version": "..." and the root package entry's version.
  $text = $text -replace '(?m)^\s*"version"\s*:\s*"[^"]*",\s*$', '"version":"",'
  $sha  = [Security.Cryptography.SHA256]::Create()
  try {
    ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) -join ''
  } finally { $sha.Dispose() }
}
```

> The regex above is the risky part. Run step 4 and read the failures: if it nulls a *dependency's* version too, the `Assert-Ne` case will fail and tell you. Tighten it until both assertions pass. DEDB's `Get-DedbLockDepsHash` (`common.ps1:910`) solves the same problem — read it before inventing a third approach.

- [ ] **Step 4: Run the test**

```bash
pwsh -NoProfile -File deploy/test/fingerprint.test.ps1
```

Expected: `all passed`.

- [ ] **Step 5: Prove it against the real files**

```bash
pwsh -NoProfile -Command ". ./deploy/lib/common.ps1; 'schema: ' + (Get-GcioMigrationsFingerprint ./server/db/migrations.js); 'deps:   ' + (Get-GcioLockDepsHash ./package-lock.json)"
```

Expected: two 64-character hex strings. An empty string means the path is wrong.

- [ ] **Step 6: Commit**

```bash
git add deploy/lib/common.ps1 deploy/test/fingerprint.test.ps1 && git commit -m "build(deploy): fingerprint schema and dependencies immune to noise"
```

---

## Task 5: `patch-meta.json` and the four gates

**Files:**
- Modify: `deploy/lib/common.ps1`
- Test: `deploy/test/patch-gates.test.ps1`

- [ ] **Step 1: Write the failing test**

Build a fake install and a fake patch on disk, then assert each gate fires on exactly its own condition. Every branch gets a case — a gate with no test is a gate that will be wrong.

```powershell
# deploy/test/patch-gates.test.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"
$fails = 0
function Assert-Code($compat, $code, $what) {
  if ($compat.Code -ne $code) { Write-Host "[FAIL] $what : got '$($compat.Code)' want '$code'" -ForegroundColor Red; $script:fails++ }
  else { Write-Host "[ok] $what" -ForegroundColor Green }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-g-" + [guid]::NewGuid().ToString('N'))
function New-Fixture {
  param([string]$InstVer = '1.5.0', [string]$MinBase = '1.5.0', [int]$NodeMajor = 24,
        [string]$InstDeps = 'A', [string]$PatchDeps = 'A',
        [string]$InstMig  = 'M', [string]$PatchMig  = 'M')
  $inst  = Join-Path $root 'install'
  $patch = Join-Path $root 'patch'
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force "$inst/app/server/db","$patch/app/server/db" | Out-Null
  [IO.File]::WriteAllText("$inst/app/package.json", "{""version"":""$InstVer""}")
  [IO.File]::WriteAllText("$inst/app/package-lock.json",  "{""packages"":{""node_modules/x"":{""version"":""$InstDeps""}}}")
  [IO.File]::WriteAllText("$patch/app/package-lock.json", "{""packages"":{""node_modules/x"":{""version"":""$PatchDeps""}}}")
  [IO.File]::WriteAllText("$inst/app/server/db/migrations.js",  $InstMig)
  [IO.File]::WriteAllText("$patch/app/server/db/migrations.js", $PatchMig)
  $meta = [ordered]@{ kind='patch'; version='1.5.1'; nodeMajor=$NodeMajor; minBase=$MinBase
                      server=[ordered]@{ packageLockSha256='x' }; migrations=@(); builtFrom='' }
  $meta | ConvertTo-Json -Depth 6 | Out-File -Encoding ascii "$patch/patch-meta.json"
  return @{ Install = $inst; Patch = $patch }
}

try {
  $f = New-Fixture
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'ok' 'a compatible patch passes'

  $f = New-Fixture -InstVer '1.4.0' -MinBase '1.5.0'
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'min-base' 'an install older than minBase is refused'

  $f = New-Fixture
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 20) 'node-major' 'a Node major mismatch is refused'

  $f = New-Fixture -InstDeps 'A' -PatchDeps 'B'
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'deps-changed' 'changed dependencies are refused'

  $f = New-Fixture -InstMig 'M1' -PatchMig 'M2'
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'schema-changed' 'a changed schema is refused'

  $f = New-Fixture
  Remove-Item "$($f.Patch)/patch-meta.json"
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'meta-missing' 'a patch with no meta is refused'

  $f = New-Fixture
  Remove-Item "$($f.Install)/app/package.json"
  Assert-Code (Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24) 'no-install' 'patching a machine with no install is refused'

  # A refusal must not have touched anything.
  $f = New-Fixture -InstMig 'M1' -PatchMig 'M2'
  $before = (Get-ChildItem -Recurse -File $f.Install | ForEach-Object { Get-GcioSha256 $_.FullName }) -join ','
  [void](Test-GcioPatchCompatible -PatchRoot $f.Patch -InstallDir $f.Install -InstalledNodeMajor 24)
  $after  = (Get-ChildItem -Recurse -File $f.Install | ForEach-Object { Get-GcioSha256 $_.FullName }) -join ','
  if ($before -ne $after) { Write-Host '[FAIL] a refused gate mutated the install' -ForegroundColor Red; $fails++ }
  else { Write-Host '[ok] a refusal leaves the install byte-identical' -ForegroundColor Green }
} finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }

if ($fails) { Write-Host "$fails failed" -ForegroundColor Red; exit 1 }
Write-Host 'all passed' -ForegroundColor Green
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pwsh -NoProfile -File deploy/test/patch-gates.test.ps1
```

- [ ] **Step 3: Implement the gates**

Port `DExDashBoard/deploy/lib/common.ps1:1037–1142`, adjusting paths for GCIO's single-app layout (`app/package.json`, not `app/server/package.json`) and the JS migrations file.

```powershell
function Get-GcioProp {
  param($Obj, [string]$Name, $Default = $null)
  if ($null -eq $Obj) { return $Default }
  $p = $Obj.PSObject.Properties[$Name]
  if ($null -eq $p -or $null -eq $p.Value) { return $Default }
  return $p.Value
}

function ConvertTo-GcioNodeMajor {
  param([Parameter(Mandatory)][string]$VersionString)
  if ($VersionString -match 'v?(\d+)\.') { return [int]$Matches[1] }
  return -1
}

function Get-GcioNodeMajor {
  param([Parameter(Mandatory)][string]$InstallDir)
  $exe = Join-Path $InstallDir 'runtime\node\node.exe'
  if (-not (Test-Path $exe)) { return -1 }
  try { ConvertTo-GcioNodeMajor (& $exe --version 2>$null) } catch { -1 }
}

function Test-GcioVersionAtLeast {
  param([Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Min)
  try { return ([version]($Version -replace '[^0-9.]','')) -ge ([version]($Min -replace '[^0-9.]','')) }
  catch { return $false }
}

function New-GcioPatchMeta {
  param(
    [Parameter(Mandatory)][string]$AppDir,
    [Parameter(Mandatory)][string]$Version,
    [Parameter(Mandatory)][int]$NodeMajor,
    [Parameter(Mandatory)][string]$MinBase,
    [string]$BuiltFrom = ''
  )
  [ordered]@{
    kind = 'patch'; version = $Version; nodeMajor = $NodeMajor; minBase = $MinBase
    lockDepsHash = (Get-GcioLockDepsHash (Join-Path $AppDir 'package-lock.json'))
    migrationsFingerprint = (Get-GcioMigrationsFingerprint (Join-Path $AppDir 'server\db\migrations.js'))
    builtFrom = $BuiltFrom
  }
}

# Required files present and NO runtime -> looks like a real patch artifact.
function Test-GcioPatchComplete {
  param([Parameter(Mandatory)][string]$Root)
  $need = 'install.ps1','lib\common.ps1','app\server\index.js','app\package-lock.json',
          'app\client\dist\index.html','patch-meta.json','checksums.txt'
  foreach ($p in $need) { if (-not (Test-Path (Join-Path $Root $p))) { return $false } }
  if (Test-Path (Join-Path $Root 'runtime\node\node.exe')) { return $false }
  return $true
}

<#
  The four fail-closed gates. Returns { Ok; Code; Reason; Installed; PatchVersion; MinBase }.

  Mutates NOTHING. It runs BEFORE any stop/backup/overlay, so a refusal leaves
  the install untouched and there is no rollback to perform. That property is
  asserted by deploy/test/patch-gates.test.ps1 -- keep it true.
#>
function Test-GcioPatchCompatible {
  param(
    [Parameter(Mandatory)][string]$PatchRoot,
    [Parameter(Mandatory)][string]$InstallDir,
    [int]$InstalledNodeMajor = -1
  )
  # One shape for every verdict so no return path can forget a field.
  $mk = {
    param($ok, $code, $reason, $installed, $patchVer, $minBase)
    [pscustomobject]@{
      Ok = [bool]$ok; Code = "$code"; Reason = "$reason"
      Installed = "$installed"; PatchVersion = "$patchVer"; MinBase = "$minBase"
    }
  }

  $metaPath = Join-Path $PatchRoot 'patch-meta.json'
  if (-not (Test-Path $metaPath)) { return & $mk $false 'meta-missing' 'patch-meta.json missing' 'unknown' 'unknown' 'unknown' }
  $meta = Get-Content -Raw $metaPath | ConvertFrom-Json
  $patchVer = "$(Get-GcioProp $meta 'version' 'unknown')"
  $minBase  = "$(Get-GcioProp $meta 'minBase' 'unknown')"

  $pkg = Join-Path $InstallDir 'app\package.json'
  if (-not (Test-Path $pkg)) { return & $mk $false 'no-install' 'no existing install - run a full bundle first' 'unknown' $patchVer $minBase }
  $instVer = (Get-Content -Raw $pkg | ConvertFrom-Json).version

  if (-not (Test-GcioVersionAtLeast -Version $instVer -Min $minBase)) {
    return & $mk $false 'min-base' "installed version $instVer is older than this patch's minimum base $minBase - use the full bundle" $instVer $patchVer $minBase
  }
  $nm = if ($InstalledNodeMajor -ge 0) { $InstalledNodeMajor } else { Get-GcioNodeMajor -InstallDir $InstallDir }
  if ($nm -ne [int](Get-GcioProp $meta 'nodeMajor' -1)) {
    return & $mk $false 'node-major' "Node runtime major $nm != patch target $(Get-GcioProp $meta 'nodeMajor' '?') - use the full bundle" $instVer $patchVer $minBase
  }
  $instLock = Join-Path $InstallDir 'app\package-lock.json'
  if (-not (Test-Path $instLock)) {
    return & $mk $false 'lockfile-missing' 'cannot verify dependencies (base install predates lockfile tracking) - use the full bundle' $instVer $patchVer $minBase
  }
  if ((Get-GcioLockDepsHash $instLock) -ne (Get-GcioLockDepsHash (Join-Path $PatchRoot 'app\package-lock.json'))) {
    return & $mk $false 'deps-changed' 'dependencies changed - use the full bundle' $instVer $patchVer $minBase
  }
  $instMig  = Get-GcioMigrationsFingerprint (Join-Path $InstallDir 'app\server\db\migrations.js')
  $patchMig = Get-GcioMigrationsFingerprint (Join-Path $PatchRoot  'app\server\db\migrations.js')
  if ($instMig -ne $patchMig) {
    return & $mk $false 'schema-changed' 'database schema (migrations.js) changed - use the full bundle' $instVer $patchVer $minBase
  }
  return & $mk $true 'ok' '' $instVer $patchVer $minBase
}
```

- [ ] **Step 4: Run the test**

```bash
pwsh -NoProfile -File deploy/test/patch-gates.test.ps1
```

Expected: `all passed`, 8 `[ok]` lines.

- [ ] **Step 5: Mutation-check the gate that matters most**

Comment out the `schema-changed` branch. Confirm `deploy/test/patch-gates.test.ps1` reports exactly that case failing. Restore. A gate you have not watched fail is a gate you have not tested.

- [ ] **Step 6: Commit**

```bash
git add deploy/lib/common.ps1 deploy/test/patch-gates.test.ps1 && git commit -m "build(deploy): add the four fail-closed patch compatibility gates"
```

---

## Task 6: Operator guidance for a refusal

A gate that refuses without saying what to do next gets bypassed.

**Files:**
- Modify: `deploy/lib/common.ps1`
- Test: `deploy/test/patch-refusal.test.ps1`

- [ ] **Step 1: Write the failing test**

```powershell
# deploy/test/patch-refusal.test.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"
$fails = 0
$compat = [pscustomobject]@{ Ok=$false; Code='schema-changed'; Reason='database schema (migrations.js) changed - use the full bundle'
                             Installed='1.5.0'; PatchVersion='1.6.0'; MinBase='1.5.0' }
$lines = @(Format-GcioPatchRefusal -Compat $compat)
$text  = $lines -join "`n"

foreach ($must in 'NOTHING has been changed', '1.5.0', '1.6.0', 'gcio-bundle') {
  if ($text -notmatch [regex]::Escape($must)) { Write-Host "[FAIL] refusal text omits '$must'" -ForegroundColor Red; $fails++ }
  else { Write-Host "[ok] refusal text states '$must'" -ForegroundColor Green }
}
if ($lines -isnot [array]) { Write-Host '[FAIL] must return an array of lines' -ForegroundColor Red; $fails++ }
if ($fails) { exit 1 }
Write-Host 'all passed' -ForegroundColor Green
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pwsh -NoProfile -File deploy/test/patch-refusal.test.ps1
```

- [ ] **Step 3: Implement**

Pure — no printing, no exit — so it is testable and shared by `install.ps1 -Patch` and `code-update.ps1`.

```powershell
<#
  Build the operator guidance for a REFUSED patch. Returns an ARRAY of plain
  lines; the caller prints each through its own warn helper.

  Every message states, in this order: that NOTHING was changed (the gate is
  fail-closed and runs before any mutation), what is INSTALLED, what the patch
  IS and REQUIRES, WHY it was refused, and the exact recovery COMMAND. The
  recovery is almost always the full bundle: a bundle ships Node and
  node_modules and applies migrations at boot, so it can bridge any gap a patch
  overlay cannot. ASCII and PowerShell 5.1 safe.
#>
function Format-GcioPatchRefusal {
  param([Parameter(Mandatory)]$Compat)
  $inst  = "$(Get-GcioProp $Compat 'Installed' 'unknown')"
  $pv    = "$(Get-GcioProp $Compat 'PatchVersion' 'unknown')"
  $mb    = "$(Get-GcioProp $Compat 'MinBase' 'unknown')"
  $code  = "$(Get-GcioProp $Compat 'Code' 'unknown')"

  $why = switch ($code) {
    'schema-changed'   { "This patch changes the database schema (server/db/migrations.js). GCIO applies migrations at boot, so an overlay would migrate this host without anyone choosing to." }
    'deps-changed'     { "This patch changes the dependency set, and a patch overlay does not ship node_modules." }
    'node-major'       { "This patch targets a different Node major than the runtime installed here." }
    'min-base'         { "This host is on $inst, older than this patch's minimum base $mb." }
    'lockfile-missing' { "This install predates lockfile tracking, so dependencies cannot be verified." }
    'no-install'       { "There is no GCIO install here to patch." }
    'meta-missing'     { "This artifact has no patch-meta.json, so it cannot be verified as a patch." }
    default            { "$(Get-GcioProp $Compat 'Reason' 'refused')" }
  }

  @(
    'PATCH REFUSED - NOTHING has been changed on this host.',
    "  installed: $inst",
    "  patch:     $pv (requires at least $mb)",
    "  reason:    $code",
    "  $why",
    '',
    '  Recovery: install the full bundle instead -',
    "    .\Update-GCIO.cmd            (with gcio-bundle-$pv-win-x64.zip beside it)",
    '',
    '  The bundle ships Node and node_modules and applies migrations at boot,',
    '  so it can bridge any gap a patch overlay cannot.'
  )
}
```

- [ ] **Step 4: Run the test**

```bash
pwsh -NoProfile -File deploy/test/patch-refusal.test.ps1
```

- [ ] **Step 5: Read the output as an operator would**

```bash
pwsh -NoProfile -Command ". ./deploy/lib/common.ps1; Format-GcioPatchRefusal ([pscustomobject]@{Ok=`$false;Code='deps-changed';Reason='';Installed='1.5.0';PatchVersion='1.6.0';MinBase='1.5.0'})"
```

If you cannot tell what to do next from that text alone, rewrite it. This is the message someone reads at 2am.

- [ ] **Step 6: Commit**

```bash
git add deploy/lib/common.ps1 deploy/test/patch-refusal.test.ps1 && git commit -m "build(deploy): explain a refused patch in operator terms"
```

---

## Task 7: `build-bundle.ps1`

**Files:**
- Create: `deploy/build-bundle.ps1`
- Modify: `.gitignore`

- [ ] **Step 1: Ignore the output directory — anchored**

Append to `.gitignore`:

```gitignore
# Release artifacts. ANCHORED: an unanchored pattern in this repo once
# swallowed test/audit/ and six tests never reached the remote.
/dist-bundle/
```

- [ ] **Step 2: Write the script**

Port `DExDashBoard/deploy/build-bundle.ps1`, collapsed to GCIO's single-app layout.

```powershell
#requires -version 7
[CmdletBinding()] param(
  [ValidateSet('win-x64')][string]$Os = 'win-x64',
  [switch]$SkipRuntimeFetch,
  [string]$Out
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here/lib/common.ps1"
$Repo = Resolve-Path "$Here/.."
if (-not $Out) { $Out = Join-Path $Repo 'dist-bundle' }

$Ver = (Get-Content -Raw "$Repo/package.json" | ConvertFrom-Json).version
if (-not $Ver) { Stop-Gcio 'no version in package.json' }
$Name  = "gcio-bundle-$Ver-$Os"
$Stage = Join-Path $Out $Name
Write-GcioLog "building $Name"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path "$Stage/app","$Stage/runtime" | Out-Null

Write-GcioLog 'npm ci (prod)'
Push-Location $Repo; npm ci --omit=dev; $ec = $LASTEXITCODE; Pop-Location
if ($ec) { Stop-Gcio "'npm ci' failed (exit $ec). package-lock.json is likely out of sync with package.json (e.g. after a version bump) - run 'npm install', commit the lockfile, then rebuild. Refusing to ship a stale bundle." }

Write-GcioLog 'build client'
Push-Location $Repo; npm run build; $ec = $LASTEXITCODE; Pop-Location
if ($ec) { Stop-Gcio "client build failed (exit $ec). Refusing to ship a stale client dist." }

# The app payload. node_modules is included: that is what makes this a BUNDLE.
Copy-Item -Recurse -Force `
  "$Repo/server","$Repo/shared","$Repo/scripts","$Repo/sample-data", `
  "$Repo/package.json","$Repo/package-lock.json","$Repo/node_modules" "$Stage/app/"
New-Item -ItemType Directory -Force "$Stage/app/client" | Out-Null
Copy-Item -Recurse -Force "$Repo/client/dist" "$Stage/app/client/dist"

if (-not $SkipRuntimeFetch) {
  $nodeUrl = Get-GcioJsonValue "$Here/versions.json" "node.$Os.url"
  $nodeSha = Get-GcioJsonValue "$Here/versions.json" "node.$Os.sha256"
  $pkg = Join-Path "$Stage/runtime" (Split-Path $nodeUrl -Leaf)
  Write-GcioLog "fetch node: $nodeUrl"; Invoke-GcioDownload $nodeUrl $pkg; Test-GcioSha256 $pkg $nodeSha
  Expand-Archive -Path $pkg -DestinationPath "$Stage/runtime" -Force; Remove-Item $pkg
  Get-ChildItem "$Stage/runtime" -Directory -Filter 'node-*' | Select-Object -First 1 |
    ForEach-Object { Rename-Item $_.FullName (Join-Path "$Stage/runtime" 'node') }

  # nssm.cc is flaky; prefer a local cache so an outage cannot block a rebuild.
  $nssmCache = Join-Path $Here '.cache/nssm.exe'
  if (Test-Path $nssmCache) {
    Write-GcioLog 'using cached nssm.exe'
    Copy-Item $nssmCache "$Stage/runtime/nssm.exe"
  } else {
    $nssmUrl = Get-GcioJsonValue "$Here/versions.json" nssm.url
    $nssmSha = Get-GcioJsonValue "$Here/versions.json" nssm.sha256
    Write-GcioLog 'fetch nssm'; Invoke-GcioDownload $nssmUrl "$Stage/runtime/nssm.zip"
    Test-GcioSha256 "$Stage/runtime/nssm.zip" $nssmSha
    Expand-Archive "$Stage/runtime/nssm.zip" "$Stage/runtime/nssm-tmp" -Force
    Copy-Item (Get-ChildItem "$Stage/runtime/nssm-tmp" -Recurse -Filter nssm.exe |
      Where-Object FullName -like '*win64*' | Select-Object -First 1).FullName "$Stage/runtime/nssm.exe"
    Remove-Item -Recurse -Force "$Stage/runtime/nssm-tmp","$Stage/runtime/nssm.zip"
    New-Item -ItemType Directory -Force (Split-Path $nssmCache) | Out-Null
    Copy-Item "$Stage/runtime/nssm.exe" $nssmCache
  }
} else { Write-GcioWarn 'SkipRuntimeFetch: bundle has no Node/NSSM (testing only)' }

# NOTE: this is an ALLOW-LIST. A host-side script not named here silently does NOT
# ship, and the operator finds out only when it is missing on the server. In DEDB
# that was exactly how Set-DedbBindHost.ps1 reached zero hosts across many releases.
# Add new host scripts here.
foreach ($f in 'install.ps1','install-service.ps1','uninstall.ps1') {
  if (Test-Path "$Here/$f") { Copy-Item "$Here/$f" "$Stage/" }
}
# install.ps1 sources lib/common.ps1 at runtime - bundle it or it fails with "not found".
Copy-Item -Recurse -Force "$Here/lib" "$Stage/lib"
Copy-Item "$Here/versions.json" "$Stage/versions.json"
$Ver | Out-File -Encoding ascii "$Stage/VERSION"

Write-GcioLog 'writing checksums'
Push-Location $Stage
# -LiteralPath so a node_modules fixture with wildcard metachars ([ ]) in its name
# hashes instead of globbing to $null. UTF-8 so a non-ASCII filename round-trips.
Get-ChildItem -Recurse -File | Where-Object Name -ne 'checksums.txt' | Sort-Object FullName | ForEach-Object {
  $rel = Resolve-Path -Relative -LiteralPath $_.FullName
  "$(Get-GcioSha256 $_.FullName)  $rel"
} | Out-File -Encoding utf8 checksums.txt
Pop-Location

Write-GcioLog 'packing archive'
Compress-Archive -Path $Stage -DestinationPath "$Out/$Name.zip" -Force

# code-update.ps1 ships OUTSIDE the bundle, beside the archive: it bootstraps the
# deploy by expanding the bundle zip, so it must not live inside the thing it unzips.
foreach ($f in 'code-update.ps1','Update-GCIO.cmd') {
  if (Test-Path "$Here/$f") { Copy-Item "$Here/$f" "$Out/" -Force; Write-GcioLog "placed $f beside the archive" }
}
Write-GcioLog "done -> $Out/$Name.zip"
```

- [ ] **Step 3: Build one without the runtime (fast) and look at it**

```bash
pwsh -NoProfile -File deploy/build-bundle.ps1 -SkipRuntimeFetch
```

Expected: `dist-bundle/gcio-bundle-1.5.0-win-x64/` staged, plus the `.zip`.

- [ ] **Step 4: Confirm the payload is actually complete**

```bash
pwsh -NoProfile -Command "Get-ChildItem dist-bundle/gcio-bundle-1.5.0-win-x64 | Select-Object Name; 'files: ' + (Get-ChildItem -Recurse -File dist-bundle/gcio-bundle-1.5.0-win-x64).Count"
```

Check by eye that `app/server/index.js`, `app/client/dist/index.html`, `app/node_modules`, `lib/common.ps1`, `VERSION` and `checksums.txt` are present. A bundle missing `node_modules` is not a bundle.

- [ ] **Step 5: Commit**

```bash
git add deploy/build-bundle.ps1 .gitignore && git commit -m "build(deploy): build a full GCIO bundle with pinned runtime"
```

---

## Task 8: `build-patch.ps1`

**Files:**
- Create: `deploy/build-patch.ps1`

- [ ] **Step 1: Write the script**

```powershell
#requires -version 7
[CmdletBinding()] param(
  [ValidateSet('win-x64')][string]$Os = 'win-x64',
  [string]$MinBase = '',        # default: <major>.<minor>.0 of the app version
  [string]$Out
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here/lib/common.ps1"
$Repo = Resolve-Path "$Here/.."
if (-not $Out) { $Out = Join-Path $Repo 'dist-bundle' }

$Ver = (Get-Content -Raw "$Repo/package.json" | ConvertFrom-Json).version
if (-not $Ver) { Stop-Gcio 'no version in package.json' }
if (-not $MinBase) { $v = [version]$Ver; $MinBase = "$($v.Major).$($v.Minor).0" }
$Name  = "gcio-patch-$Ver-$Os"
$Stage = Join-Path $Out $Name
Write-GcioLog "building $Name (minBase $MinBase)"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force "$Stage/app/client" | Out-Null

# The SPA build is the only slow step. No npm ci --omit=dev, no runtime fetch,
# no node_modules copy - that is the entire point of the patch tier.
Write-GcioLog 'build client'
Push-Location $Repo; npm run build; $ec = $LASTEXITCODE; Pop-Location
if ($ec) { Stop-Gcio "client build failed (exit $ec)." }

Copy-Item -Recurse -Force `
  "$Repo/server","$Repo/shared","$Repo/scripts","$Repo/sample-data", `
  "$Repo/package.json","$Repo/package-lock.json" "$Stage/app/"
Copy-Item -Recurse -Force "$Repo/client/dist" "$Stage/app/client/dist"

# Installer + helpers (a patch runs install.ps1 -Patch, which sources lib/common.ps1).
Copy-Item "$Here/install.ps1" "$Stage/"
Copy-Item -Recurse -Force "$Here/lib" "$Stage/lib"

$nodeUrl   = Get-GcioJsonValue "$Here/versions.json" "node.$Os.url"
$nodeMajor = if ($nodeUrl -match 'v(\d+)\.') { [int]$Matches[1] } else { Stop-Gcio "cannot read node major from versions.json ($nodeUrl)" }
$builtFrom = try { (& git -C $Repo rev-parse --short HEAD 2>$null) } catch { '' }
$meta = New-GcioPatchMeta -AppDir "$Stage/app" -Version $Ver -NodeMajor $nodeMajor -MinBase $MinBase -BuiltFrom "$builtFrom"
$meta | ConvertTo-Json -Depth 6 | Out-File -Encoding ascii "$Stage/patch-meta.json"
$Ver | Out-File -Encoding ascii "$Stage/VERSION"

Write-GcioLog 'writing checksums'
Push-Location $Stage
Get-ChildItem -Recurse -File | Where-Object Name -ne 'checksums.txt' | Sort-Object FullName | ForEach-Object {
  $rel = Resolve-Path -Relative -LiteralPath $_.FullName
  "$(Get-GcioSha256 $_.FullName)  $rel"
} | Out-File -Encoding utf8 checksums.txt
Pop-Location

Write-GcioLog 'packing archive'
Compress-Archive -Path $Stage -DestinationPath "$Out/$Name.zip" -Force
foreach ($f in 'code-update.ps1','Update-GCIO.cmd') {
  if (Test-Path "$Here/$f") { Copy-Item "$Here/$f" "$Out/" -Force }
}
Write-GcioLog "done -> $Out/$Name.zip"
```

- [ ] **Step 2: Build one and confirm it is genuinely a patch**

```bash
pwsh -NoProfile -File deploy/build-patch.ps1
```

- [ ] **Step 3: Prove the size difference is real**

```bash
pwsh -NoProfile -Command "Get-ChildItem dist-bundle/*.zip | Select-Object Name,@{n='MB';e={[math]::Round($_.Length/1MB,1)}}"
```

The patch must be dramatically smaller than the bundle. If it is not, `node_modules` leaked in — find out how before continuing.

- [ ] **Step 4: Confirm the meta records the real fingerprints**

```bash
pwsh -NoProfile -Command "Get-Content -Raw dist-bundle/gcio-patch-1.5.0-win-x64/patch-meta.json"
```

`lockDepsHash` and `migrationsFingerprint` must both be 64-char hex, and must equal the values Task 4 step 5 printed for the working tree.

- [ ] **Step 5: Commit**

```bash
git add deploy/build-patch.ps1 && git commit -m "build(deploy): build an app-only patch overlay with a compatibility meta"
```

---

## Task 9: `verify-bundle.ps1` and `verify-patch.ps1`

**Files:**
- Create: `deploy/verify-bundle.ps1`, `deploy/verify-patch.ps1`
- Test: `deploy/test/verify.test.ps1`

- [ ] **Step 1: Write the failing test**

The important case: a tampered file must be caught, and a bundle handed to `verify-patch` must be rejected.

```powershell
# deploy/test/verify.test.ps1
$ErrorActionPreference = 'Stop'
$fails = 0
$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-v-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force "$root/app/server","$root/app/client/dist","$root/lib" | Out-Null
[IO.File]::WriteAllText("$root/app/server/index.js", 'x')
[IO.File]::WriteAllText("$root/app/package-lock.json", '{}')
[IO.File]::WriteAllText("$root/app/client/dist/index.html", '<html>')
[IO.File]::WriteAllText("$root/lib/common.ps1", '#')
[IO.File]::WriteAllText("$root/install.ps1", '#')
[IO.File]::WriteAllText("$root/patch-meta.json", '{"version":"1.5.0"}')
[IO.File]::WriteAllText("$root/VERSION", '1.5.0')
Push-Location $root
Get-ChildItem -Recurse -File | Where-Object Name -ne 'checksums.txt' | Sort-Object FullName | ForEach-Object {
  "$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower())  $(Resolve-Path -Relative -LiteralPath $_.FullName)"
} | Out-File -Encoding utf8 checksums.txt
Pop-Location

& pwsh -NoProfile -File "$PSScriptRoot/../verify-patch.ps1" -Dir $root | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host '[FAIL] a good patch should verify' -ForegroundColor Red; $fails++ } else { Write-Host '[ok] a good patch verifies' -ForegroundColor Green }

# tamper
[IO.File]::WriteAllText("$root/app/server/index.js", 'TAMPERED')
& pwsh -NoProfile -File "$PSScriptRoot/../verify-patch.ps1" -Dir $root 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host '[FAIL] a tampered file must fail verification' -ForegroundColor Red; $fails++ } else { Write-Host '[ok] tampering is caught' -ForegroundColor Green }

# a bundle handed to verify-patch must be refused
[IO.File]::WriteAllText("$root/app/server/index.js", 'x')
New-Item -ItemType Directory -Force "$root/runtime/node" | Out-Null
[IO.File]::WriteAllText("$root/runtime/node/node.exe", 'fake')
& pwsh -NoProfile -File "$PSScriptRoot/../verify-patch.ps1" -Dir $root 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Host '[FAIL] a bundle must not verify as a patch' -ForegroundColor Red; $fails++ } else { Write-Host '[ok] a bundle is refused by verify-patch' -ForegroundColor Green }

Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
if ($fails) { exit 1 }
Write-Host 'all passed' -ForegroundColor Green
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pwsh -NoProfile -File deploy/test/verify.test.ps1
```

- [ ] **Step 3: Write both verifiers**

```powershell
# deploy/verify-bundle.ps1
#requires -version 7
[CmdletBinding()] param([string]$Dir = '.')
$ErrorActionPreference = 'Stop'
if (-not (Test-Path "$Dir/checksums.txt")) { Write-Error "no checksums.txt in $Dir"; exit 1 }
$need = 'app/server/index.js','app/package-lock.json','app/node_modules','app/client/dist/index.html','VERSION','versions.json'
foreach ($p in $need) { if (-not (Test-Path (Join-Path $Dir $p))) { Write-Error "MISSING: $p"; exit 1 } }
Push-Location $Dir
foreach ($line in Get-Content -Encoding utf8 checksums.txt) {
  $sum, $path = $line -split '\s+', 2
  if ($path -eq './checksums.txt') { continue }
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath ($path -replace '^\./','')).Hash.ToLower()
  if ($got -ne $sum) { Pop-Location; Write-Error "CHECKSUM FAIL: $path"; exit 1 }
}
Pop-Location
Write-Host "bundle OK: $Dir"
```

```powershell
# deploy/verify-patch.ps1
#requires -version 7
[CmdletBinding()] param([string]$Dir = '.')
$ErrorActionPreference = 'Stop'
if (-not (Test-Path "$Dir/checksums.txt"))   { Write-Error "no checksums.txt in $Dir"; exit 1 }
if (-not (Test-Path "$Dir/patch-meta.json")) { Write-Error "no patch-meta.json in $Dir"; exit 1 }
# A bundle carries a runtime. If one is here, someone handed us the wrong artifact.
if (Test-Path "$Dir/runtime/node/node.exe")  { Write-Error 'runtime present - this is a full bundle, not a patch'; exit 1 }
$need = 'app/server/index.js','app/package-lock.json','app/client/dist/index.html','VERSION'
foreach ($p in $need) { if (-not (Test-Path (Join-Path $Dir $p))) { Write-Error "MISSING: $p"; exit 1 } }
Push-Location $Dir
foreach ($line in Get-Content -Encoding utf8 checksums.txt) {
  $sum, $path = $line -split '\s+', 2
  if ($path -eq './checksums.txt') { continue }
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath ($path -replace '^\./','')).Hash.ToLower()
  if ($got -ne $sum) { Pop-Location; Write-Error "CHECKSUM FAIL: $path"; exit 1 }
}
Pop-Location
Write-Host "patch OK: $Dir"
```

- [ ] **Step 4: Run the test, then verify the real artifacts**

```bash
pwsh -NoProfile -File deploy/test/verify.test.ps1
```

```bash
pwsh -NoProfile -File deploy/verify-patch.ps1 -Dir dist-bundle/gcio-patch-1.5.0-win-x64
```

- [ ] **Step 5: Commit**

```bash
git add deploy/verify-bundle.ps1 deploy/verify-patch.ps1 deploy/test/verify.test.ps1 && git commit -m "build(deploy): verify artifacts by checksum and refuse the wrong tier"
```

---

## Task 10: Backup, overlay, restore, and the deploy log

The pieces the health gate needs before it can roll anything back.

**Files:**
- Modify: `deploy/lib/common.ps1`
- Test: `deploy/test/overlay.test.ps1`

- [ ] **Step 1: Write the failing test**

The behaviour that matters: an overlay must replace app code **without** destroying `node_modules`, `.env`, `data`, or `vault`.

```powershell
# deploy/test/overlay.test.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"
$fails = 0
function Check($cond, $what) { if ($cond) { Write-Host "[ok] $what" -ForegroundColor Green } else { Write-Host "[FAIL] $what" -ForegroundColor Red; $script:fails++ } }

$root = Join-Path ([IO.Path]::GetTempPath()) ("gcio-o-" + [guid]::NewGuid().ToString('N'))
$inst = Join-Path $root 'install'; $patch = Join-Path $root 'patch'
New-Item -ItemType Directory -Force "$inst/app/server","$inst/app/node_modules/dep","$inst/app/client/dist","$patch/app/server","$patch/app/client/dist" | Out-Null
[IO.File]::WriteAllText("$inst/app/server/index.js", 'OLD')
[IO.File]::WriteAllText("$inst/app/node_modules/dep/i.js", 'KEEP-ME')
[IO.File]::WriteAllText("$inst/app/client/dist/index.html", 'OLD')
[IO.File]::WriteAllText("$inst/app/.env", 'SECRET=1')
[IO.File]::WriteAllText("$patch/app/server/index.js", 'NEW')
[IO.File]::WriteAllText("$patch/app/client/dist/index.html", 'NEW')

$ts = '20260828-120000'
Backup-GcioAppCopy -InstallDir $inst -Ts $ts
Check (Test-Path "$inst/app.bak-$ts/server/index.js") 'a copy-backup exists'
Check ((Get-Content -Raw "$inst/app/server/index.js").Trim() -eq 'OLD') 'the live app is still in place after a COPY backup'

Copy-GcioPatchOverlay -PatchApp "$patch/app" -InstallApp "$inst/app"
Check ((Get-Content -Raw "$inst/app/server/index.js").Trim() -eq 'NEW') 'server code was overlaid'
Check ((Get-Content -Raw "$inst/app/client/dist/index.html").Trim() -eq 'NEW') 'client dist was overlaid'
Check (Test-Path "$inst/app/node_modules/dep/i.js") 'node_modules SURVIVED the overlay'
Check (Test-Path "$inst/app/.env") '.env SURVIVED the overlay'

Restore-GcioApp -InstallDir $inst -Ts $ts
Check ((Get-Content -Raw "$inst/app/server/index.js").Trim() -eq 'OLD') 'restore put the old code back'

Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
if ($fails) { exit 1 }
Write-Host 'all passed' -ForegroundColor Green
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pwsh -NoProfile -File deploy/test/overlay.test.ps1
```

- [ ] **Step 3: Implement**

```powershell
# Retry a destructive file op through a transient lock (a virus scanner, a
# still-draining process). Without this, a deploy fails on a lock that would
# have cleared in a second.
function Invoke-GcioFileOp {
  param([Parameter(Mandatory)][scriptblock]$Op, [int]$Tries = 5)
  for ($i = 1; $i -le $Tries; $i++) {
    try { & $Op; return } catch { if ($i -eq $Tries) { throw }; Start-Sleep -Milliseconds (200 * $i) }
  }
}

# COPY (not move) the current app aside, leaving the live app serving while the
# copy is taken. Runs BEFORE the service stops - app code is static at runtime -
# so this is off the downtime clock.
function Backup-GcioAppCopy {
  param([Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][string]$Ts)
  $dest = Join-Path $InstallDir "app.bak-$Ts"
  # Replace a stale same-second backup rather than merge into it (Copy-Item -Force
  # merges directories), so the backup stays an exact snapshot even on a re-run.
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  Copy-Item -Recurse -Force (Join-Path $InstallDir 'app') $dest
}

# Overlay a patch's app subset onto the installed app, PRESERVING node_modules,
# .env, data/ and vault/. Only code and built assets are replaced.
function Copy-GcioPatchOverlay {
  param([Parameter(Mandatory)][string]$PatchApp, [Parameter(Mandatory)][string]$InstallApp)
  foreach ($sub in 'server','shared','scripts','sample-data') {
    $s = Join-Path $PatchApp $sub; $d = Join-Path $InstallApp $sub
    if (Test-Path $s) {
      if (Test-Path $d) { Invoke-GcioFileOp { Remove-Item -Recurse -Force $d } }
      Copy-Item -Recurse -Force $s $d
    }
  }
  foreach ($f in 'package.json','package-lock.json') {
    $s = Join-Path $PatchApp $f
    if (Test-Path $s) { Copy-Item -Force $s (Join-Path $InstallApp $f) }
  }
  $s = Join-Path $PatchApp 'client\dist'; $d = Join-Path $InstallApp 'client\dist'
  if (Test-Path $s) {
    if (Test-Path $d) { Invoke-GcioFileOp { Remove-Item -Recurse -Force $d } }
    Copy-Item -Recurse -Force $s $d
  }
}

function Get-GcioBackups {
  param([Parameter(Mandatory)][string]$InstallDir)
  Get-ChildItem $InstallDir -Directory -Filter 'app.bak-*' -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | ForEach-Object { $_.Name -replace '^app\.bak-','' }
}

function Restore-GcioApp {
  param([Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][string]$Ts)
  $app = Join-Path $InstallDir 'app'; $bak = Join-Path $InstallDir "app.bak-$Ts"
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

# One line per deploy. THIS FILE, not package.json and not a release PR, is the
# authority for "what actually reached this host".
function Write-GcioDeployLog {
  param(
    [Parameter(Mandatory)][string]$InstallDir, [Parameter(Mandatory)][string]$Kind,
    [string]$From = '?', [string]$To = '?', [string]$Extra = ''
  )
  $logDir = Join-Path $InstallDir 'logs'
  New-Item -ItemType Directory -Force $logDir | Out-Null
  $stamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
  Add-Content -Path (Join-Path $logDir 'deploy.log') -Value (("$stamp  $Kind  $From -> $To  $Extra").TrimEnd()) -Encoding ascii
}
```

- [ ] **Step 4: Run the test**

```bash
pwsh -NoProfile -File deploy/test/overlay.test.ps1
```

Expected: `all passed`, 7 `[ok]` lines.

- [ ] **Step 5: Mutation-check the preservation guarantee**

Add `node_modules` to the `foreach ($sub in ...)` list in `Copy-GcioPatchOverlay`. Confirm `node_modules SURVIVED the overlay` goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add deploy/lib/common.ps1 deploy/test/overlay.test.ps1 && git commit -m "build(deploy): add copy-backup, overlay, restore and the deploy log"
```

---

## Task 11: `install.ps1` — health gate and auto-rollback

**Files:**
- Create: `deploy/install.ps1`
- Modify: `deploy/lib/common.ps1` (health probe)
- Test: `deploy/test/health-probe.test.ps1`

- [ ] **Step 1: Add the health probe with a test**

GCIO's `/healthz` returns `{"status":"ok",...}` — note this is **not** DEDB's `{"ok":true}` shape, so the matcher differs.

```powershell
# deploy/test/health-probe.test.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"
$fails = 0
function Check($c, $w) { if ($c) { Write-Host "[ok] $w" -ForegroundColor Green } else { Write-Host "[FAIL] $w" -ForegroundColor Red; $script:fails++ } }

Check (Test-GcioHealthBody '{"status":"ok","uptimeSec":3,"version":"1.5.0"}') 'a healthy body is accepted'
Check (-not (Test-GcioHealthBody '{"status":"degraded"}'))                    'a non-ok status is rejected'
Check (-not (Test-GcioHealthBody ''))                                          'an empty body is rejected'
# nssm/UTF-16 can interleave NULs; a literal match would silently never fire.
Check (Test-GcioHealthBody "{`0`"`0s`0t`0a`0t`0u`0s`0`"`0:`0`"`0o`0k`0`"`0}") 'a NUL-laden body still matches'
Check ((Get-GcioVersionFromHealth '{"status":"ok","version":"1.5.0"}') -eq '1.5.0') 'the version is read out of the health body'

if ($fails) { exit 1 }
Write-Host 'all passed' -ForegroundColor Green
```

Run it, watch it fail, then implement:

```powershell
<#
  Match a /healthz body.

  Strips NULs first. nssm writes its `get` output as UTF-16LE and PowerShell
  decodes that stream a byte at a time, so every real character arrives followed
  by a NUL - which a console does NOT render, so the string looks completely
  normal when an operator prints it. A literal pattern can never match it. In
  DEDB this exact bug made EVERY patch roll back on a host that was perfectly
  healthy. Strip, then match.
#>
function Test-GcioHealthBody {
  param([string]$Body)
  if (-not $Body) { return $false }
  return (($Body -replace "`0", '') -match '"status"\s*:\s*"ok"')
}

function Get-GcioVersionFromHealth {
  param([string]$Body)
  if (($Body -replace "`0", '') -match '"version"\s*:\s*"([^"]+)"') { return $Matches[1] }
  return ''
}

function Get-GcioHealthBody {
  param([Parameter(Mandatory)][string]$Url, [int]$TimeoutSec = 5)
  try { (Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing).Content } catch { '' }
}

function Test-GcioHealth {
  param([Parameter(Mandatory)][string]$Url)
  Test-GcioHealthBody (Get-GcioHealthBody -Url $Url)
}
```

- [ ] **Step 2: Write `install.ps1`**

Port the `-Patch` path from `DExDashBoard/deploy/install.ps1:107–180`. The ordering is the whole design — do not rearrange it.

```powershell
#requires -version 5.1
<#
.SYNOPSIS
  Install, patch, or roll back GCIO Project Intelligence.
.DESCRIPTION
  -Bundle   full install/upgrade (app + node_modules + runtime)
  -Patch    app-only overlay, gated and health-gated, auto-rollback on failure
  -Rollback revert to the most recent app.bak-*
#>
[CmdletBinding(DefaultParameterSetName = 'Bundle')]
param(
  [Parameter(ParameterSetName='Bundle')]   [switch]$Bundle,
  [Parameter(ParameterSetName='Patch')]    [switch]$Patch,
  [Parameter(ParameterSetName='Rollback')] [switch]$Rollback,
  [string]$InstallDir  = 'C:\gcio',
  [string]$ServiceName = 'GCIOProjectIntelligence',
  [int]$Port = 0,
  [switch]$SkipHealthGate
)
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here/lib/common.ps1"

if ($Port -le 0) { $Port = 8130 }   # override with -Port; .env's PORT is the real source
$HealthUrl = "http://127.0.0.1:$Port/healthz"
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'

function Get-InstalledVersion {
  $p = Join-Path $InstallDir 'app\package.json'
  if (Test-Path $p) { (Get-Content -Raw $p | ConvertFrom-Json).version } else { 'none' }
}

if ($Rollback) {
  $stamps = @(Get-GcioBackups -InstallDir $InstallDir)
  if (-not $stamps.Count) { Stop-Gcio "no backup to roll back to in $InstallDir" }
  $from = Get-InstalledVersion
  Write-GcioLog "rolling back to app.bak-$($stamps[0])"
  try { & sc.exe stop $ServiceName | Out-Null } catch { }
  Start-Sleep 3
  Restore-GcioApp -InstallDir $InstallDir -Ts $stamps[0]
  try { & sc.exe start $ServiceName | Out-Null } catch { }
  $to = Get-InstalledVersion
  Write-GcioDeployLog -InstallDir $InstallDir -Kind 'ROLLBACK' -From $from -To $to
  Write-GcioLog "rolled back -> $to"
  exit 0
}

if ($Patch) {
  # ---- gates FIRST: a refusal must change nothing ----
  $compat = Test-GcioPatchCompatible -PatchRoot $Here -InstallDir $InstallDir
  if (-not $compat.Ok) {
    foreach ($line in Format-GcioPatchRefusal -Compat $compat) { Write-GcioWarn $line }
    exit 1
  }
  $oldVer = $compat.Installed
  $newVer = $compat.PatchVersion
  Write-GcioLog "patching GCIO $oldVer -> $newVer (deps + schema verified; node_modules/runtime preserved)"

  # Copy-backup while still serving: this is off the downtime clock.
  Backup-GcioAppCopy -InstallDir $InstallDir -Ts $ts

  try { & sc.exe stop $ServiceName | Out-Null } catch { }
  Start-Sleep 3
  Copy-GcioPatchOverlay -PatchApp (Join-Path $Here 'app') -InstallApp (Join-Path $InstallDir 'app')
  try { & sc.exe start $ServiceName | Out-Null } catch { }

  if ($SkipHealthGate) { Write-GcioWarn 'health gate skipped (-SkipHealthGate)'; exit 0 }

  Write-GcioLog 'health check (allow time for first boot)'
  $ok = $false; $downStreak = 0
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-GcioHealth -Url $HealthUrl) { $ok = $true; break }
    $cur = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    # A service that keeps landing back on Stopped is not slow-booting, it is
    # crashing. Bail early rather than burning the full two minutes.
    if ($cur -and $cur.Status -eq 'Stopped') { $downStreak++ } else { $downStreak = 0 }
    if ($downStreak -ge 5) { break }
    Start-Sleep 2
  }

  if ($ok) {
    Remove-OldGcioBackups -InstallDir $InstallDir -Keep 3
    Write-GcioDeployLog -InstallDir $InstallDir -Kind 'PATCH' -From $oldVer -To $newVer -Extra "backup=app.bak-$ts health=OK"
    Write-GcioLog "OK - GCIO healthy at $HealthUrl"
    exit 0
  }

  Write-GcioWarn 'health check failed - rolling back to the previous version'
  try { & sc.exe stop $ServiceName | Out-Null } catch { }
  Start-Sleep 3
  Restore-GcioApp -InstallDir $InstallDir -Ts $ts
  try { & sc.exe start $ServiceName | Out-Null } catch { }
  $back = Get-InstalledVersion
  Write-GcioDeployLog -InstallDir $InstallDir -Kind 'PATCH-ROLLBACK' -From $oldVer -To $back -Extra 'health=FAIL'
  Stop-Gcio "patch failed its health check and was rolled back to $back. Check the service error log before re-running."
}

if ($Bundle) {
  Write-GcioLog "installing the full bundle into $InstallDir"
  $from = Get-InstalledVersion
  if ((Get-InstalledVersion) -ne 'none') { Backup-GcioAppCopy -InstallDir $InstallDir -Ts $ts }
  try { & sc.exe stop $ServiceName | Out-Null } catch { }
  Start-Sleep 3
  New-Item -ItemType Directory -Force $InstallDir | Out-Null
  foreach ($d in 'app','runtime') {
    $src = Join-Path $Here $d
    if (Test-Path $src) {
      $dst = Join-Path $InstallDir $d
      if (Test-Path $dst) { Invoke-GcioFileOp { Remove-Item -Recurse -Force $dst } }
      Copy-Item -Recurse -Force $src $dst
    }
  }
  # Migrations apply at boot (server/index.js) - there is no separate step here
  # by design. The patch gate is what stops a schema change arriving unchosen.
  try { & sc.exe start $ServiceName | Out-Null } catch { }
  $to = Get-InstalledVersion
  Write-GcioDeployLog -InstallDir $InstallDir -Kind 'BUNDLE' -From $from -To $to
  Write-GcioLog "installed $to"
  exit 0
}

Stop-Gcio 'specify one of -Bundle, -Patch or -Rollback'
```

> `install.ps1` assumes NSSM has already registered the service via the existing `deploy/install-service.ps1`. Confirm the service name matches (`GCIOProjectIntelligence`) and that a first-time install path exists — if `install-service.ps1` must run first, say so in `RELEASING.md` step 6 rather than duplicating its logic here.

- [ ] **Step 3: Run the probe test and the whole deploy suite**

```bash
pwsh -NoProfile -File deploy/test/health-probe.test.ps1
```

```bash
pwsh -NoProfile -Command "Get-ChildItem deploy/test/*.test.ps1 | ForEach-Object { Write-Host ''; Write-Host $_.Name -ForegroundColor Cyan; & pwsh -NoProfile -File $_.FullName }"
```

- [ ] **Step 4: Commit**

```bash
git add deploy/install.ps1 deploy/lib/common.ps1 deploy/test/health-probe.test.ps1 && git commit -m "build(deploy): install, patch with a health gate, and auto-rollback"
```

---

## Task 12: `code-update.ps1` and `Update-GCIO.cmd`

**Files:**
- Create: `deploy/code-update.ps1`, `deploy/Update-GCIO.cmd`

- [ ] **Step 1: Write the updater**

It detects whichever artifact is beside it, expands it, and delegates. Crucially, it ships **outside** the archive.

```powershell
#requires -version 5.1
<#
.SYNOPSIS
  Expand whichever GCIO artifact sits beside this script and apply it.
.DESCRIPTION
  Ships OUTSIDE the archive - it is what unzips the archive, so it cannot live
  inside the thing it unzips.
#>
[CmdletBinding()] param(
  [string]$InstallDir = 'C:\gcio',
  [switch]$Rollback,
  [int]$Port = 0
)
$ErrorActionPreference = 'Continue'   # nssm prints benign noise to stderr; gate on real signals
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Rollback) {
  $inst = Join-Path $InstallDir 'install.ps1'
  if (-not (Test-Path $inst)) { Write-Error "no install.ps1 in $InstallDir"; exit 1 }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $inst -Rollback -InstallDir $InstallDir
  exit $LASTEXITCODE
}

# Files copied from another machine carry a zone marker that makes RemoteSigned
# refuse to run them. Unblocking the ZIP before extraction also stops the marker
# propagating to every extracted file. NOTE: a blocked copy of THIS script cannot
# unblock itself - run Update-GCIO.cmd for a zero-friction bootstrap.
Get-ChildItem $Here -Filter '*.zip' | Unblock-File -ErrorAction SilentlyContinue

$zip = Get-ChildItem $Here -Filter 'gcio-*-win-x64.zip' | Sort-Object Name -Descending | Select-Object -First 1
if (-not $zip) { Write-Error "no gcio-bundle-*/gcio-patch-* zip found beside $Here"; exit 1 }
$isPatch = $zip.Name -like 'gcio-patch-*'
Write-Host "[gcio] found $($zip.Name) -> $(if ($isPatch) { 'PATCH' } else { 'BUNDLE' })"

$dest = Join-Path $Here ($zip.BaseName)
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Expand-Archive -Path $zip.FullName -DestinationPath $Here -Force
if (-not (Test-Path $dest)) { Write-Error "expected $dest after extraction"; exit 1 }

# The verifier may sit beside this script or inside the artifact. Prefer
# whichever exists, and never silently skip verification.
$kind = if ($isPatch) { 'patch' } else { 'bundle' }
$verifier = @("$Here\verify-$kind.ps1", "$dest\verify-$kind.ps1") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if ($verifier) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $verifier -Dir $dest
  if ($LASTEXITCODE -ne 0) { Write-Error 'artifact failed verification - refusing to apply'; exit 1 }
} else {
  Write-Warning '[gcio] no verifier found beside the artifact - applying UNVERIFIED'
}

# NOT $args: that is an automatic variable in PowerShell and assigning to it
# inside a script is legal but shadows the caller's arguments in ways that bite
# later. Name it something of our own.
$installArgs = @('-InstallDir', $InstallDir)
if ($Port -gt 0) { $installArgs += @('-Port', "$Port") }
$installArgs += if ($isPatch) { '-Patch' } else { '-Bundle' }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dest 'install.ps1') @installArgs
exit $LASTEXITCODE
```

```bat
@echo off
REM Execution-policy-proof launcher. A copy of code-update.ps1 that carries a
REM zone marker cannot unblock itself, so bootstrap through this instead.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0code-update.ps1" %*
```

- [ ] **Step 2: Confirm verification actually runs and is not skipped**

```bash
pwsh -NoProfile -File deploy/code-update.ps1 -InstallDir "$env:TEMP/gcio-fake" 2>&1 | head -20
```

Expected: it finds the artifact, verifies, then fails at install because the fake install dir has nothing. That failure is fine; what you are checking is that verification ran and was not skipped with a warning.

- [ ] **Step 3: Commit**

```bash
git add deploy/code-update.ps1 deploy/Update-GCIO.cmd && git commit -m "build(deploy): add the updater that expands and applies an artifact"
```

---

## Task 13: `preflight-release.ps1` — the release-time gate

**Files:**
- Modify: `deploy/lib/common.ps1` (policy helpers)
- Create: `deploy/preflight-release.ps1`, `deploy/RELEASE-NOTES.md`
- Test: `deploy/test/preflight.test.ps1`

- [ ] **Step 1: Write the failing test for the policy helpers**

```powershell
# deploy/test/preflight.test.ps1
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../lib/common.ps1"
$fails = 0
function Check($c, $w) { if ($c) { Write-Host "[ok] $w" -ForegroundColor Green } else { Write-Host "[FAIL] $w" -ForegroundColor Red; $script:fails++ } }

Check ((Get-GcioBumpType -BaseVersion '1.5.0' -HeadVersion '1.5.1') -eq 'patch') 'Z bump is a patch'
Check ((Get-GcioBumpType -BaseVersion '1.5.1' -HeadVersion '1.6.0') -eq 'minor') 'Y bump is a minor'
Check ((Get-GcioBumpType -BaseVersion '1.6.0' -HeadVersion '2.0.0') -eq 'major') 'X bump is a major'
Check ((Get-GcioBumpType -BaseVersion '1.5.0' -HeadVersion '1.5.0') -eq 'none')  'no change is none'

# A patch may not carry schema, deps, node or breaking changes.
Check (-not (Test-GcioReleaseBump -Bump 'patch' -MigrationsChanged $true  -DepsChanged $false -NodeChanged $false -Breaking $false -FeatureAdded $false).Ok) 'a patch carrying a migration is refused'
Check (-not (Test-GcioReleaseBump -Bump 'patch' -MigrationsChanged $false -DepsChanged $true  -NodeChanged $false -Breaking $false -FeatureAdded $false).Ok) 'a patch carrying a dependency change is refused'
Check (-not (Test-GcioReleaseBump -Bump 'patch' -MigrationsChanged $false -DepsChanged $false -NodeChanged $false -Breaking $false -FeatureAdded $true).Ok)  'a patch carrying a feat is refused'
Check (-not (Test-GcioReleaseBump -Bump 'minor' -MigrationsChanged $false -DepsChanged $false -NodeChanged $false -Breaking $true  -FeatureAdded $false).Ok) 'a minor carrying a breaking change is refused'
Check     (Test-GcioReleaseBump -Bump 'minor' -MigrationsChanged $true  -DepsChanged $true  -NodeChanged $false -Breaking $false -FeatureAdded $true).Ok    'a minor may carry a migration, deps and a feat'
Check ((Test-GcioReleaseBump -Bump 'patch' -MigrationsChanged $false -DepsChanged $false -NodeChanged $false -Breaking $false -FeatureAdded $false).Artifact -eq 'patch') 'a clean patch asks for the patch artifact'
Check ((Test-GcioReleaseBump -Bump 'minor' -MigrationsChanged $false -DepsChanged $false -NodeChanged $false -Breaking $false -FeatureAdded $false).Artifact -eq 'bundle') 'a minor asks for the bundle'

# Markers.
Check     (Test-GcioBreakingMarker "feat!: drop the old endpoint") 'a bang marks breaking'
Check     (Test-GcioBreakingMarker "body`nBREAKING CHANGE: x")     'a BREAKING CHANGE footer marks breaking'
Check (-not (Test-GcioBreakingMarker "fix: mention breaking news")) 'prose mentioning breaking does not'

# Subjects only, line-anchored.
Check     (Test-GcioFeatureMarker "feat: add a thing")        'a feat subject is detected'
Check     (Test-GcioFeatureMarker "feat(ingest): add a thing") 'a scoped feat is detected'
Check (-not (Test-GcioFeatureMarker "fix: this is a great feat")) 'prose mentioning feat does not trip it'

# Notes gate.
Check     (Test-GcioReleaseNotes -Notes "## GCIO 1.6.0`nstuff" -Version '1.6.0').Ok 'a version with notes passes'
Check (-not (Test-GcioReleaseNotes -Notes "## GCIO 1.5.0`nstuff" -Version '1.6.0').Ok) 'a version with no notes section fails'

if ($fails) { exit 1 }
Write-Host 'all passed' -ForegroundColor Green
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pwsh -NoProfile -File deploy/test/preflight.test.ps1
```

- [ ] **Step 3: Implement the policy helpers**

```powershell
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
  The bump is decided by COMPATIBILITY, not by "did code change".
    - a Z bump may NOT carry a migration / dependency / Node-major change
      (those need a MINOR + full bundle), nor a breaking change (MAJOR);
    - a Y bump may NOT carry a breaking change (MAJOR).
  The feature rule lives INSIDE the patch branch on purpose: a minor carrying a
  feature is this function's success case. Do not "restore symmetry" by hoisting
  it - in DEDB that regression made an already-released version unbuildable from
  its own release commit.
#>
function Test-GcioReleaseBump {
  param(
    [string]$Bump, [bool]$MigrationsChanged, [bool]$DepsChanged,
    [bool]$NodeChanged, [bool]$Breaking, [bool]$FeatureAdded
  )
  $mk = { param($ok, $reason, $artifact) [pscustomobject]@{ Ok = [bool]$ok; Reason = "$reason"; Artifact = "$artifact" } }

  if ($Breaking -and $Bump -ne 'major') {
    return & $mk $false 'a breaking change requires a MAJOR bump and a full BUNDLE' 'bundle'
  }
  switch ($Bump) {
    'patch' {
      if ($MigrationsChanged) { return & $mk $false 'migrations changed -> bump the MINOR and ship a BUNDLE, not a patch' 'bundle' }
      if ($DepsChanged)       { return & $mk $false 'dependencies changed -> bump the MINOR and ship a BUNDLE, not a patch' 'bundle' }
      if ($NodeChanged)       { return & $mk $false 'the Node runtime major changed -> bump the MAJOR and ship a BUNDLE' 'bundle' }
      if ($FeatureAdded)      { return & $mk $false 'new functionality (feat) -> bump the MINOR and ship a BUNDLE, not a patch' 'bundle' }
      return & $mk $true 'application-only change with no schema, dependency or runtime change' 'patch'
    }
    'minor' { return & $mk $true 'new backward-compatible functionality' 'bundle' }
    'major' { return & $mk $true 'breaking change - bundle, migrate, back up first, and write upgrade notes' 'bundle' }
    'none'  { return & $mk $false 'no version bump - nothing to release' 'none' }
    default { return & $mk $false "unsupported bump '$Bump'" 'none' }
  }
}

# Scans commit BODIES: a breaking marker is often only in a footer.
function Test-GcioBreakingMarker {
  param([string]$LogBody)
  if (-not $LogBody) { return $false }
  if ($LogBody -match '(?m)^\s*BREAKING[ -]CHANGE\s*:') { return $true }
  if ($LogBody -match '(?m)^\s*(feat|fix|refactor|perf|build|chore)(\([^)]*\))?!\s*:') { return $true }
  return $false
}

<#
  Scans commit SUBJECTS only, line-anchored.

  Deliberately not bodies, unlike the breaking check: a squash-merge body quotes
  every original commit bullet, so scanning bodies would false-positive on any
  release commit that merely summarises what merged.

  This is a BACKSTOP, not a guarantee - a feature squash-merged under a
  non-conventional PR title is not detected.
#>
function Test-GcioFeatureMarker {
  param([string]$Subjects)
  if (-not $Subjects) { return $false }
  return ($Subjects -match '(?m)^\s*feat(\([^)]*\))?!?\s*:')
}

function Get-GcioNotesHeading {
  param([string]$Version) "## GCIO $Version"
}

# A release with no operator-facing notes ships silently: the host operator has
# no way to know what it contains or that they need to run it.
function Test-GcioReleaseNotes {
  param([string]$Notes, [string]$Version)
  $head = Get-GcioNotesHeading -Version $Version
  if ($Notes -and ($Notes -match ('(?m)^' + [regex]::Escape($head) + '\s*$'))) {
    return @{ Ok = $true;  Reason = "release notes present for $Version" }
  }
  return @{ Ok = $false; Reason = "deploy/RELEASE-NOTES.md has no '$head' section - write the operator-facing notes before releasing" }
}

# Most recent commit whose SUBJECT is "release X.Y.Z ...", from `git log --format=%H%x09%s`.
function Get-GcioReleaseCommitSha {
  param([string[]]$LogLines)
  foreach ($l in $LogLines) {
    $sha, $subject = "$l" -split "`t", 2
    if ($subject -match '^release\s+\d+\.\d+\.\d+(\s|$)') { return $sha }
  }
  return ''
}
```

- [ ] **Step 4: Run the test**

```bash
pwsh -NoProfile -File deploy/test/preflight.test.ps1
```

Expected: `all passed`, 20 `[ok]` lines.

- [ ] **Step 5: Write `preflight-release.ps1`**

Port `DExDashBoard/deploy/preflight-release.ps1` with GCIO's paths. `$PayloadPaths` is what a patch ships; `$DeployScriptPaths` is what `build-patch.ps1` stages beside it. **Keep them in step with `build-patch.ps1`** or the feature gate will scan the wrong things.

```powershell
#requires -version 5.1
[CmdletBinding()] param([string]$BaseRef = '', [switch]$Json)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here/lib/common.ps1"
$RepoPath = (Resolve-Path "$Here/..").Path

$PkgRel   = 'package.json'
$LockRel  = 'package-lock.json'
$MigRel   = 'server/db/migrations.js'
$VerRel   = 'deploy/versions.json'
$NotesRel = 'deploy/RELEASE-NOTES.md'

# What a patch overlay actually ships (see build-patch.ps1's staging step).
$PayloadPaths = @('server','shared','scripts','sample-data','client/src')
# What build-patch.ps1 stages beside the payload. Deliberately NOT all of deploy/:
# the build scripts, deploy/test/ and the docs never reach a host through a patch,
# so a feat touching only those must not force a minor.
$DeployScriptPaths = @('deploy/install.ps1','deploy/lib','deploy/code-update.ps1','deploy/Update-GCIO.cmd')

function Get-GcioGitText {
  param([string]$Ref, [string]$Path)
  $out = & git -C $RepoPath show "${Ref}:$Path" 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  ($out -join "`n")
}

if ([string]::IsNullOrWhiteSpace($BaseRef)) {
  $logLines = & git -C $RepoPath log --format='%H%x09%s' HEAD~1 2>$null
  $auto = Get-GcioReleaseCommitSha -LogLines $logLines
  if ([string]::IsNullOrWhiteSpace($auto)) {
    Stop-Gcio 'could not auto-detect the previous release commit (no subject matching "release X.Y.Z ..." reachable from HEAD~1). Re-run with -BaseRef <ref>.'
  }
  $BaseRef = "$auto".Trim()
  Write-GcioLog "auto-detected previous-release base ref: $BaseRef"
}
& git -C $RepoPath rev-parse --verify --quiet "$BaseRef^{commit}" 1>$null 2>$null
if ($LASTEXITCODE -ne 0) { Stop-Gcio "base ref '$BaseRef' is not a valid git commit." }

$headVer = (Get-Content -Raw (Join-Path $RepoPath $PkgRel) | ConvertFrom-Json).version
$baseVer = try { ((Get-GcioGitText -Ref $BaseRef -Path $PkgRel) | ConvertFrom-Json).version } catch { '' }
$bump = Get-GcioBumpType -BaseVersion $baseVer -HeadVersion $headVer

# Schema: compare the fingerprint, not the diff, so it matches the host gate exactly.
$headMig = Get-GcioMigrationsFingerprint (Join-Path $RepoPath $MigRel)
$baseMigText = Get-GcioGitText -Ref $BaseRef -Path $MigRel
$baseMig = ''
if ($null -ne $baseMigText) {
  $t = Join-Path ([IO.Path]::GetTempPath()) ('gcio-basemig-' + [guid]::NewGuid().ToString('N') + '.js')
  try { [IO.File]::WriteAllText($t, $baseMigText); $baseMig = Get-GcioMigrationsFingerprint $t }
  finally { Remove-Item $t -Force -ErrorAction SilentlyContinue }
}
$migrationsChanged = ($headMig -ne $baseMig)

$headDeps = Get-GcioLockDepsHash (Join-Path $RepoPath $LockRel)
$baseLockText = Get-GcioGitText -Ref $BaseRef -Path $LockRel
$baseDeps = ''
if ($null -ne $baseLockText) {
  $t = Join-Path ([IO.Path]::GetTempPath()) ('gcio-baselock-' + [guid]::NewGuid().ToString('N') + '.json')
  try { [IO.File]::WriteAllText($t, $baseLockText); $baseDeps = Get-GcioLockDepsHash $t }
  finally { Remove-Item $t -Force -ErrorAction SilentlyContinue }
}
$depsChanged = ($headDeps -ne $baseDeps)

$headNode = try { "$((Get-Content -Raw (Join-Path $RepoPath $VerRel) | ConvertFrom-Json).node.version)" } catch { '' }
$baseVersionsText = Get-GcioGitText -Ref $BaseRef -Path $VerRel
$baseNode = ''
if ($baseVersionsText) { try { $baseNode = "$(($baseVersionsText | ConvertFrom-Json).node.version)" } catch { } }
$nodeChanged = ((ConvertTo-GcioNodeMajor $headNode) -ne (ConvertTo-GcioNodeMajor $baseNode))

$breaking = Test-GcioBreakingMarker (((& git -C $RepoPath log --format=%B "$BaseRef..HEAD" 2>$null) -join "`n"))
$subjects = & git -C $RepoPath log --format=%s "$BaseRef..HEAD" -- ($PayloadPaths + $DeployScriptPaths) 2>$null
$featureAdded = Test-GcioFeatureMarker (($subjects -join "`n"))

$decision = Test-GcioReleaseBump -Bump $bump -MigrationsChanged $migrationsChanged -DepsChanged $depsChanged -NodeChanged $nodeChanged -Breaking $breaking -FeatureAdded $featureAdded

$notesBody = if (Test-Path (Join-Path $RepoPath $NotesRel)) { Get-Content -Raw (Join-Path $RepoPath $NotesRel) } else { '' }
$notes = if ($bump -in 'patch','minor','major') { Test-GcioReleaseNotes -Notes $notesBody -Version $headVer }
         else { @{ Ok = $true; Reason = 'no version bump - release notes not required' } }

# `ok` is the OVERALL verdict: release.ps1 gates the whole release on this one
# field, so a gate not folded in here is a gate that silently does nothing.
if ($Json) {
  [pscustomobject]@{
    baseRef = $BaseRef; baseVersion = $baseVer; headVersion = $headVer; bump = $bump
    migrationsChanged = $migrationsChanged; depsChanged = $depsChanged; nodeChanged = $nodeChanged
    breaking = $breaking; featureAdded = $featureAdded
    bumpOk = $decision.Ok; notesOk = $notes.Ok; ok = ($decision.Ok -and $notes.Ok)
    reason = $(if (-not $decision.Ok) { $decision.Reason } elseif (-not $notes.Ok) { $notes.Reason } else { $decision.Reason })
    artifact = $decision.Artifact
  } | ConvertTo-Json -Compress
} else {
  Write-GcioLog "base $BaseRef ($baseVer) -> HEAD ($headVer): bump = $bump"
  Write-GcioLog ("changed: migrations={0} deps={1} node={2} breaking={3} featureAdded={4}" -f $migrationsChanged, $depsChanged, $nodeChanged, $breaking, $featureAdded)
  if ($decision.Ok) {
    Write-GcioLog "PASS - $($decision.Reason)"
    Write-GcioLog "required deploy artifact: $($decision.Artifact)"
    if ($notes.Ok) { Write-GcioLog "PASS - $($notes.Reason)" }
  }
}
if (-not $decision.Ok) { Stop-Gcio "release preflight FAILED ($bump bump): $($decision.Reason)" }
if (-not $notes.Ok)    { Stop-Gcio "release preflight FAILED ($bump bump): $($notes.Reason)" }
```

- [ ] **Step 6: Seed `deploy/RELEASE-NOTES.md`**

```markdown
# GCIO release notes

Newest first. One section per released version, headed exactly `## GCIO X.Y.Z`.
Write what an operator or a user would notice — not the commit list. The deploy
tier, anything that will generate a support question, and any behaviour that
looks like a regression but is not.

`deploy/preflight-release.ps1` fails a release whose version has no section here.

## GCIO 1.5.0

Baseline. First version with a bundled release artifact; earlier versions were
deployed by copying the working tree.
```

- [ ] **Step 7: Run it against the real repo**

```bash
pwsh -NoProfile -File deploy/preflight-release.ps1 -BaseRef HEAD~1
```

It will likely fail on the missing notes section or on `bump = none` — read the message and confirm it is refusing for a reason you understand. That is the gate working.

- [ ] **Step 8: Commit**

```bash
git add deploy/preflight-release.ps1 deploy/RELEASE-NOTES.md deploy/lib/common.ps1 deploy/test/preflight.test.ps1 && git commit -m "build(deploy): gate a release on whether its bump matches what changed"
```

---

## Task 14: `release.ps1` and `RELEASING.md`

**Files:**
- Create: `deploy/release.ps1`, `RELEASING.md`

- [ ] **Step 1: Write `release.ps1`**

It adds **no policy** — it bumps, runs the preflight as the gate, and builds what the preflight names. On failure it reverts the bump.

```powershell
#requires -version 7
[CmdletBinding()] param(
  [Parameter(Mandatory)][ValidateSet('patch','minor','major')][string]$Bump,
  [Parameter(Mandatory)][string]$Summary,
  [switch]$DryRun, [switch]$NoBuild, [switch]$Tag
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$Here/lib/common.ps1"
$Repo = (Resolve-Path "$Here/..").Path

$before = (Get-Content -Raw "$Repo/package.json" | ConvertFrom-Json).version
Write-GcioLog "bumping $Bump from $before"
Push-Location $Repo
try {
  npm version $Bump --no-git-tag-version | Out-Null
  $after = (Get-Content -Raw "$Repo/package.json" | ConvertFrom-Json).version
  Write-GcioLog "version is now $after"

  $pf = & powershell -NoProfile -ExecutionPolicy Bypass -File "$Here/preflight-release.ps1" -Json
  $verdict = $pf | ConvertFrom-Json
  if (-not $verdict.ok) {
    Write-GcioWarn "preflight refused: $($verdict.reason)"
    Write-GcioWarn "reverting the bump $after -> $before"
    & git -C $Repo checkout -- package.json package-lock.json
    Stop-Gcio 'release aborted by preflight (nothing was committed)'
  }
  Write-GcioLog "preflight PASS - artifact: $($verdict.artifact)"
  if ($DryRun) { & git -C $Repo checkout -- package.json package-lock.json; Write-GcioLog 'dry run - bump reverted'; exit 0 }

  & git -C $Repo add package.json package-lock.json
  & git -C $Repo commit -m "release $after - $Summary"
  if ($Tag) { & git -C $Repo tag "v$after" }
  if ($NoBuild) { Write-GcioLog 'stopping before the build (-NoBuild)'; exit 0 }

  $script = if ($verdict.artifact -eq 'patch') { 'build-patch.ps1' } else { 'build-bundle.ps1' }
  Write-GcioLog "building with $script"
  & pwsh -NoProfile -File "$Here/$script"
  if ($LASTEXITCODE) { Stop-Gcio "build failed (exit $LASTEXITCODE) - the release commit is made; fix and rebuild" }
} finally { Pop-Location }
Write-GcioLog 'done - open the release PR; this script does not push or open it'
```

- [ ] **Step 2: Write `RELEASING.md`**

Model it on `DExDashBoard/RELEASING.md` — the tier table, the hard rule, the reset rule, the runbook, and a version-history table. State GCIO's two departures from DEDB explicitly:

1. **The schema gate hashes a whole file.** Editing a comment in `server/db/migrations.js` forces a bundle. That is the safe direction, and it is a known cost, not a bug.
2. **Migrations apply at boot, not by an operator command.** That is precisely why the schema gate is not optional: a patch overlay carrying a changed `migrations.js` would migrate a host nobody chose to migrate.

Include the tier table verbatim in spirit:

| Bump | When | Deploy tier |
|---|---|---|
| PATCH `Z` | bug fix, application code only; no schema, no dependency, no Node-major change | patch overlay, health-gated with auto-rollback |
| MINOR `Y` | new backward-compatible functionality; may add an additive, idempotent migration | full bundle |
| MAJOR `X` | breaking schema/behaviour/config, mandatory backfill, Node major, or no clean rollback | full bundle + mandatory backup + upgrade notes |

And the runbook: bump → notes → preflight → docs → **run `npm test` and the deploy suite** → build → verify → PR with subject `release X.Y.Z - <summary>`.

- [ ] **Step 3: Dry-run the whole thing**

```bash
pwsh -NoProfile -File deploy/release.ps1 -Bump patch -Summary "rehearse the release path" -DryRun
```

Expected: it bumps, the preflight either passes or refuses with a reason you understand, and **the bump is reverted either way**. Confirm with `git status` that `package.json` is unmodified afterwards.

- [ ] **Step 4: Commit**

```bash
git add deploy/release.ps1 RELEASING.md && git commit -m "docs(release): document the tier policy and add the one-command release"
```

---

## Task 15: End-to-end rehearsal

Everything above is unit-tested. None of it has been proven to actually deploy.

**Files:** none — this task produces evidence, not code.

- [ ] **Step 1: Build both artifacts for real**

```bash
pwsh -NoProfile -File deploy/build-bundle.ps1
```

```bash
pwsh -NoProfile -File deploy/build-patch.ps1
```

Record both sizes. If the patch is not far smaller, `node_modules` leaked in.

- [ ] **Step 2: Verify both**

```bash
pwsh -NoProfile -File deploy/verify-bundle.ps1 -Dir dist-bundle/gcio-bundle-1.5.0-win-x64
```

```bash
pwsh -NoProfile -File deploy/verify-patch.ps1 -Dir dist-bundle/gcio-patch-1.5.0-win-x64
```

- [ ] **Step 3: Install the bundle to a scratch directory, not `C:\gcio`**

Use `-InstallDir "$env:TEMP\gcio-rehearsal"` and a port nothing else uses. **Do not touch the live deployment on 8130.** Confirm the app starts and `/healthz` answers with the right version.

- [ ] **Step 4: Apply the patch on top and watch the gate pass**

Expect `PATCH` in `<install>\logs\deploy.log` with `health=OK`.

- [ ] **Step 5: Prove the gate actually refuses — the most important step**

Edit `server/db/migrations.js` (add a real migration, or just a comment), rebuild the patch, and apply it to the same install. It **must** refuse with `schema-changed`, print the recovery guidance, and leave the install byte-identical.

Capture the output. A gate nobody has watched refuse is a gate nobody knows works.

- [ ] **Step 6: Prove auto-rollback works**

Build a patch with a deliberately broken `server/index.js` (e.g. a syntax error), apply it, and confirm: the health gate fails, the install rolls back, `/healthz` serves the **old** version again, and `deploy.log` records `PATCH-ROLLBACK`.

- [ ] **Step 7: Clean up and report**

Remove the scratch install. Confirm the live deployment on 8130 was never touched. Report, with real numbers: both artifact sizes, the deploy.log lines, the refusal text, and the rollback evidence.

- [ ] **Step 8: Commit any fixes the rehearsal forced**

```bash
git add -A && git commit -m "fix(deploy): correct what the end-to-end rehearsal found"
```

---

## Definition of done

- `npm test` still reports **0 fail** (total rises by the Task 1 test).
- Every `deploy/test/*.test.ps1` passes.
- Both artifacts build, verify, and install to a scratch directory.
- A schema change **provably** refuses a patch, with operator guidance, changing nothing.
- A failed health check **provably** rolls back, and `deploy.log` records it.
- `RELEASING.md` states the two GCIO-specific departures from DEDB.

## Deliberately not in scope

- **Linux artifacts.** GCIO deploys to Windows + IIS, and DEDB's own build refuses to cross-build Linux on Windows because symlinks and exec bits are lost.
- **A second release line.** DEDB carries Project Tracker on its own version and artifacts; GCIO has one app.
- **Automatic re-election / failover.** Unrelated to releases; already documented as a known limitation in `docs/runbook.md`.
- **Migrating `migrations.js` to `.sql` files.** Considered and rejected for now (see Decisions). If it is ever done, `Get-GcioMigrationsFingerprint` becomes a directory hash and DEDB's version ports verbatim.
