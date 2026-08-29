# DEDB deployment packaging — full analysis and clone gap report

**Date:** 2026-08-29
**Subject:** everything DEDB ships as part of its deployment package system, what GCIO's clone covers, and what it does not.
**Source:** `C:\dev\DExDashBoard`, read-only. No edits, builds, test runs, or database access.

The first pass at this (2026-08-28) produced GCIO's bundle/patch system and got the core right. This is the pass that asks what was *left out* — and the answer is more than expected, including one item that is a live defect rather than a missing feature.

---

## 1. DEDB ships FOUR artifact tiers, not two

The first analysis found two. There are four, plus a packaging layer above them.

| Tier | Artifact | Built by | Contains | Cloned? |
|---|---|---|---|---|
| **Full bundle** | `dedb-bundle-X.Y.Z-win-x64.zip` | `build-bundle.ps1` | app + `node_modules` + Node runtime + NSSM + installers | **yes** |
| **Patch overlay** | `dedb-patch-X.Y.Z-win-x64.zip` | `build-patch.ps1` | app subset only | **yes** |
| **Lean package** | `DEDB-Deployment-Package.zip` | `make-package.ps1` | app + vendored deps, **no runtime, no NSSM** | **no** |
| **Second release line** | `pt-bundle-*` / `pt-patch-*` | `build-pt-*.ps1` | Project Tracker, its own version line | n/a |

### The lean package is a different distribution model

`make-package.ps1` produces something the bundle/patch pair does not: a package that assumes **Node is already on the target**, ships `start.ps1`/`start.sh` instead of a service installer, comes up on **self-signed HTTPS with zero configuration**, and hands the operator a **first-run wizard** to configure SQL and AD from a browser.

Its persistence story is also different — config, keys and certs live under a `DEDB_DATA` directory *outside* the package, so "upgrade" means replacing the package folder and nothing else.

**GCIO has no equivalent and arguably should not.** It has no first-run wizard, no admin console, and no self-signed HTTPS path; it expects `.env` and IIS. Cloning this tier would mean building those first. Recorded as a deliberate non-goal, not an oversight.

### The outer package layer

Above all of this, DEDB ships **one outer zip per release** — `DEDB-1.46.1-ProjectTracker-PATCH.zip` — containing the actual artifact plus the updater and docs.

`code-update.ps1` handles the case where an operator copies that outer zip across **without unzipping it**: finding no loose artifact, it auto-extracts every `DEDB-*.zip` that is not itself an artifact, surfaces any inner `dedb-patch-*`/`dedb-bundle-*` beside itself, and lets normal detection proceed.

There is also a **patch fast-path with version arbitration**: if both a patch and a bundle are present, the bundle wins when its version is greater than or equal to the patch's. GCIO's updater instead **refuses** when it finds more than one artifact.

> **Assessment:** GCIO's refusal is defensible and arguably safer — it never guesses. But DEDB's behaviour exists because operators really do drop a whole release folder on a server. Worth revisiting only if GCIO starts shipping docs alongside artifacts.

---

## 2. Host-side scripts GCIO does not have

| DEDB script | What it does | GCIO |
|---|---|---|
| `Check-DedbDeployReady.ps1` | **Read-only** pre-deploy check run *on the host*: reads the service environment exactly as the deploy scripts do, probes the resolved health URL, reports Node ABI, inspects the served certificate's SAN against the pinned bind host, prints current versions. Changes nothing. | missing |
| `apply-migrations.ps1` | sqlcmd migration runner with a `dbo.schema_migrations` ledger, pending-file diffing, and `-I`/`-C` flags that make sqlcmd match the app's own runner | n/a — GCIO migrates at boot |
| `uninstall.ps1` | Stops and deregisters the service, removes firewall rules, optional `-Purge` of app and data | **missing** |
| `Set-DedbBindHost.ps1` | Changes the pinned bind address on an installed service | missing |
| `trust-ad-ca.ps1` | Exports and trusts the domain CA chain for LDAPS | missing |
| `Probe-DedbProduction.ps1` | Production probe | missing |

`Check-DedbDeployReady.ps1` is the interesting one. GCIO has `install-service.ps1 -Preflight`, which is close — but DEDB's runs against an **already-installed** host and reads the *service's own environment* rather than the `.env` file. Those differ once anyone edits one without the other, which is exactly when you want to know.

---

## 3. Library functions not ported — including one live defect

`deploy/lib/common.ps1` is 1,585 lines. GCIO's is ~600. Most of the difference is genuinely not needed. Three items are not in that category.

### 3a. `Wait-DedbCleanStop` — **this is a defect in GCIO's clone, not a missing feature**

GCIO's stop sequence, in `deploy/install.ps1`:

```powershell
function Stop-GcioService {
  try { & sc.exe stop $ServiceName 2>&1 | Out-Null } catch { }
  Start-Sleep 3
}
```

Three seconds, unconditionally, then the overlay proceeds.

DEDB instead **waits for the port to actually be released**, in 500 ms steps up to a grace period, force-kills leftover `node` processes living under the install directory, and scopes every port probe to the app's own bound IP so a co-tenant service on the same port but a different address is never mistaken for its own.

**Why this matters for GCIO specifically.** If the app takes longer than three seconds to release port 8130, the overlay writes new files *while the old process is still serving from memory*, and the health check that follows can be answered by the **old, healthy process**. The result is a patch reported `health=OK` that was never actually verified.

That is not a theoretical shape. It is precisely the ambiguity that made the first live rollback test inconclusive on 2026-08-28 — a health check that passed while the thing under test was not what answered it.

> **Recommendation: port this first.** It is the single highest-value item in this report, and the only one that makes an existing green result untrustworthy rather than merely leaving a gap.

### 3b. NSSM auto-restart suppression across the stop → overlay → start window

DEDB calls `Set-DedbNssmAutoRestart -Enabled:$false` before stopping, and guarantees restoration in a `finally` on every exit path — success, rollback, or a thrown error.

Without it, NSSM's default `AppExit=Restart` can **resurrect the old application mid-overlay**, while files are being replaced underneath it. DEDB's comment records this as a real incident on its `-Upgrade` path.

GCIO does not do this. Its `AppExit Default Restart` is set at install time and left armed throughout every patch.

**Evidence this is live on GCIO's host:** during the rollback test, `service-err.log` accumulated **15 stack traces** of the same syntax error — NSSM restarting the broken app over and over inside the health-check window. It did no harm there because the failure was terminal. A *slow-starting* app in the same window is a different story.

### 3c. `Wait-DedbServiceState` — confirm the SCM actually settled

DEDB waits for the service to reach `Stopped` rather than `STOP_PENDING` before overlaying. A stale `STOP_PENDING` can strand the later start, leaving the service stopped after an apparently successful patch.

GCIO checks neither state nor port — only the fixed sleep.

### 3d. `Test-DedbSqlReady` — a SQL pre-check before any mutation

DEDB probes SQL reachability **before** the backup and stop, and aborts if it is definitively down, with an explicit `-SkipSqlPrecheck` escape hatch. Its comment explains why a bare health gate cannot catch this: the app answers health-ish responses even with a dead database.

**GCIO has the same exposure and it is not hypothetical.** `/healthz` returns `{"status":"ok"}` from `server/app.js` without consulting the store at all — it reports process liveness, nothing more. SQL Server crashed on this host on 2026-08-28 (event 7034). A patch applied in that window would have: stopped the service, overlaid, restarted, watched the app fail to reach SQL — and then **rolled back for a reason that had nothing to do with the patch**, wasting the rollback and pointing the operator at the wrong thing.

### 3e. Smaller items

| Function | Purpose | Verdict |
|---|---|---|
| `Show-DedbFailureLog` | Prints the tail of the error log *since the deploy started* when a health check fails | worth porting — GCIO says "check the log" and leaves the operator to find it |
| `Get-DedbLogSince` / `Get-DedbLogLength` | Length markers that make the above possible | needed by the above |
| `Start-DedbServiceVerified` | Confirms the start actually took | worth porting |
| `Set-DedbFirewall` / `Remove-DedbFirewall` | Firewall rule lifecycle | GCIO is loopback-only behind IIS — not needed |
| `Export-DcCaChain` | LDAPS CA trust | environment-specific |
| `Read-DedbEnvBindHost`, `Get-DedbProbeHost`, `Get-DedbLivePort` | Resolve the probe target from the *service's* environment | needed if GCIO ever pins a bind address |

---

## 4. Test coverage

| | DEDB | GCIO |
|---|---|---|
| Deploy test files | 31 | 9 |
| Lines | ~2,100 | ~1,300 |

Like-for-like on what both systems have, GCIO's coverage is comparable and in places stronger — every gate is mutation-tested, which DEDB's suite does not appear to do systematically.

The gap is in tests for behaviour GCIO does not implement:

- `clean-stop.test.ps1` (197 lines) — the largest single test file in DEDB's suite, guarding exactly the defect in §3a
- `nssm-stop-guard.test.ps1`, `service-start.test.ps1` — the service-lifecycle behaviour of §3b/§3c
- `sqlready.test.ps1` (105 lines) — the pre-check of §3d
- `updater-autoextract.test.ps1` — the outer package of §1
- `nssm-env-decode.test.ps1` — the UTF-16 trap (GCIO handles this, in `Test-GcioHealthBody` and `ConvertFrom-NssmOutput`, but does not test the decode directly)
- 8 × `pt-*` — the second release line, not applicable

---

## 5. What GCIO does that DEDB does not

Not everything went one way.

- **The host-script allow-list fails loudly.** DEDB guards each copy with `if (Test-Path)`, so a renamed or mistyped script silently stops shipping — which is how `Set-DedbBindHost.ps1` reached zero hosts across many releases. GCIO's build stops.
- **Blob reads are byte-faithful.** GCIO's preflight materialises git blobs through `cmd` redirection. DEDB's provenance gate used `git show | Out-String`, which decodes through the console code page; four em dashes in one file made a correctly-built artifact report as "NOT built from this commit" (their PR #338, found independently the same day).
- **Host scripts are ASCII-checked.** A non-ASCII character in a BOM-less `.ps1` breaks PowerShell 5.1 parsing in a way that reports an unterminated string dozens of lines away.
- **Every gate is mutation-tested.** Each of the four compatibility gates was disabled in turn and confirmed to turn exactly its own tests red.
- **The build self-checks the artifact** against the host's own structural test before packing, so a malformed artifact fails the build rather than the deploy.

---

## 6. Ranked recommendations

### Port now — correctness

1. **`Wait-GcioCleanStop`** (§3a). Wait for the port to actually free; force-kill stragglers under the install directory. Without it a patch can be health-checked against the process it was supposed to replace. **This makes an existing green result untrustworthy.**
2. **NSSM auto-restart suppression** across stop → overlay → start, restored in a `finally` on every path (§3b).
3. **`Wait-GcioServiceState`** — confirm `Stopped`, not `STOP_PENDING`, before overlaying (§3c).

Together these are one coherent change to `Stop-GcioService` and the patch path, plus a `clean-stop` test file.

### Port next — operability

4. **SQL pre-check before mutation** (§3d), with a `-SkipSqlPrecheck` escape hatch. Turns "the patch failed and rolled back" into "SQL is down; nothing was changed" — a materially better answer at 2am, and one this host would already have needed once.
5. **`Show-GcioFailureLog`** — print the error-log tail *since this deploy began* when a health check fails (§3e). GCIO currently tells the operator a file path.
6. **`uninstall.ps1`** — there is no supported way to remove GCIO.

### Consider

7. **`Check-GcioDeployReady.ps1`** — a read-only pre-deploy check that reads the *service's* environment rather than `.env`.
8. **Outer package + auto-extract**, if GCIO ever ships docs beside artifacts.

### Deliberate non-goals

9. **The lean Node-on-target package.** Requires a first-run wizard and self-signed HTTPS that GCIO does not have.
10. **A second release line.** GCIO is one application.
11. **Firewall and LDAPS CA helpers.** Environment-specific; GCIO is loopback-only behind IIS.

---

## 7. Honest summary

The clone got the **hard, load-bearing half** right: the four compatibility gates, the fingerprints that feed them, the two-tier artifact model, checksums and tier enforcement, the release-time preflight sharing helpers with the host gate, and the health-gate-plus-rollback shape. Those were validated against a live service and behaved correctly.

What it missed is concentrated in one place: **the stop half of the stop → overlay → start window.** DEDB has three separate mechanisms guarding it and roughly 370 lines of tests. GCIO has `Start-Sleep 3`.

That is not a coincidence of effort. Those mechanisms exist in DEDB because each one is a scar. They are the least visible part of the system when reading it and the least likely to fail during a test where everything works — which is exactly why they were the part that did not survive the port.

**Nothing here invalidates the deployed system.** GCIO 1.5.0 is serving correctly and its gates demonstrably work. But a patch applied to a slow-stopping instance can currently be verified against the wrong process, and that should be fixed before this system is trusted on a server nobody is watching.
