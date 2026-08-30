# Deploy scripts: GCIO vs DEDB — what is missing, and what it costs

**Date:** 2026-08-30
**Scope:** the scripts and library functions, not the artifacts they produce. (The artifact comparison is `bundle-validation-vs-dedb.md`.)
**Source:** `C:\dev\DExDashBoard`, read-only.

Two findings here are live gaps in GCIO, not deliberate omissions. Both are in §4.

---

## 1. Scripts

| | DEDB | GCIO |
|---|---|---|
| `deploy/*.ps1` | 21 | 10 |

**Absent from GCIO, deliberately:**

| Script | Why not |
|---|---|
| `apply-migrations.ps1` | GCIO applies migrations at boot |
| `build-pt-*`, `Install-ProjectTracker`, `pt-code-update`, `update-project-tracker`, `verify-pt-*` (7) | DEDB's second release line; GCIO is one application |
| `make-package.ps1` | the lean Node-on-target tier — needs a first-run wizard GCIO does not have |
| `Set-DedbBindHost.ps1` | GCIO does not pin a bind address (but see §4a) |
| `trust-ad-ca.ps1` | LDAPS CA trust, environment-specific |

**Absent and genuinely missing:** `Check-DedbDeployReady.ps1` — §4c.

**GCIO has one DEDB does not:** `install-service.ps1`. DEDB registers the service inside `install.ps1`; GCIO separates registration from deployment, which is why a bundle can be applied without touching the service definition.

---

## 2. Library functions

`lib/common.ps1`: **DEDB 73, GCIO 50.** After normalising the `Dedb`/`Gcio` prefixes, 33 DEDB functions have no GCIO counterpart. Grouped by why:

| Group | Functions | Applies to GCIO? |
|---|---|---|
| **Bind-host / probe resolution** | `Get-ListenHost`, `Get-LivePort`, `Get-ProbeHost`, `Get-UrlHost`, `Read-EnvBindHost`, `Read-EnvPort`, `Format-Url`, `Test-AddrMatch`, `Resolve-HealthUrl` | **partly — see §4a** |
| **HTTPS probing** | `Get-TrustAllCertsDelegate`, `Invoke-HttpGet`, `Get-HealthJson` | no — GCIO is plain HTTP behind IIS |
| **Deeper SQL checks** | `Test-SqlLogin`, `Get-SqlHostPort`, `Get-SqlSha`, `Test-TcpConnect` | no — GCIO probes with the app's own `db-check.mjs`, which validates the real configuration rather than a socket |
| **Firewall** | `Set-Firewall`, `Remove-Firewall` | no — loopback only |
| **Progress UI** | `Set-Phase`, `Complete-Progress` | no — GCIO prints numbered steps instead |
| **Project Tracker** | `Get-PtPreviousReleaseLockHash`, `Select-NewestPtArtifact` | no |
| **LDAPS** | `Export-DcCaChain` | no |
| **Service lifecycle** | `Remove-Service`, `Stop-Processes`, `Remove-EventSource`, `Wait-PortFree`, `Start-ServiceVerified` | mostly covered — see below |
| **Other** | `Backup-App`, `Get-ArtifactKind`, `Get-DataDir`, `Write-DbWarning`, `ConvertFrom-NssmOutput` | mixed |

Covered under different names:

- `Wait-PortFree`, `Stop-Processes` → `Wait-GcioCleanStop` does both, and scopes to processes under the install directory.
- `Remove-Service` → `uninstall.ps1` does it inline via nssm, falling back to `sc.exe`.
- `Remove-EventSource` → **not needed**: verified that GCIO registers no event source, so there is nothing to deregister.
- `ConvertFrom-NssmOutput` → exists, in `install-service.ps1` rather than the library.
- `Backup-App` → GCIO has only the `-AppCopy` variant, which is the one the deploy path wants (copy while still serving).

**Genuinely absent, low cost:**

- **`Start-ServiceVerified`** — DEDB confirms the start actually took before falling through to the health gate. GCIO calls `sc.exe start` and goes straight to health. Practically covered: `Wait-GcioHealthy` bails after five consecutive `Stopped` readings, so a failed start is caught in ~10 s rather than 120 s. The difference is a clearer message, not a missed failure.
- **`Write-DbWarning`** — DEDB warns after a successful deploy if the app is up but has no database. GCIO's verify step prints `/readyz`, which shows `ready:false` in that case, so an operator sees it — but it is not called out as a warning.

---

## 3. Tests

**DEDB 31 files, GCIO 13.** Excluding DEDB's 8 Project Tracker files, 23 comparable against 13.

Most of the difference is naming, not coverage:

| DEDB | GCIO equivalent |
|---|---|
| `fingerprint-eol` | `fingerprint` |
| `verify-patch` | `verify` |
| `preflight-release`, `release-notes-gate` | `preflight` |
| `port-free`, `ports`, `nssm-stop-guard`, `service-start` | `clean-stop` |
| `patch-fileops`, `fileop-retry` | `overlay` |

GCIO has areas DEDB does not: `patch-refusal`, `failure-log`, `uninstall`, `common-basics`.

**Genuinely uncovered — see §4b:** `updater-autoextract`, `nssm-env-decode`.

Not applicable: `apply-migrations`, `progress-extract`, `bundle-no-pt`, `bundle-ships-precheck`, `bindhost-env` (the last only because of §4a).

---

## 4. The live gaps

### 4a. The co-tenancy guard is built, tested — and never wired

`Wait-GcioCleanStop` takes a `-BindAddr` parameter that scopes its port probe to one bound address. It is documented, and there is a test asserting the address reaches the probe.

**Nothing passes it.** Grepping every script and the library, the only occurrence outside tests is the parameter declaration itself:

```
deploy/lib/common.ps1:729:    [string]$BindAddr = '',
```

So every port probe today is unscoped. That is currently harmless — GCIO binds `127.0.0.1` — but it is a trap in two directions:

1. It **looks** wired. A reader sees the parameter, the comment and the passing test, and reasonably concludes co-tenancy is handled.
2. The moment `HOST` in `.env` is set to a pinned IP — which is exactly what this host family does, running several applications on one port behind different addresses — the guard silently does not apply, and a deploy can see a neighbour's listener and conclude its own stop has not finished.

DEDB resolves this properly with the nine-function bind-host cluster in §2. GCIO needs only the small part: read `HOST` from `.env`, resolve it if it is a name, and pass it.

**This is the most substantive finding in this report.** It is not a missing feature — it is an existing feature that is not connected.

### 4b. The outer-package auto-extract is implemented and untested

`code-update.ps1` expands a `GCIO-*.zip` that is not itself an artifact and surfaces any inner artifact beside it. It was ported from DEDB, it is in the shipped updater, and **there is no test for it**. DEDB has `updater-autoextract.test.ps1` (63 lines).

It has also never run in anger: every deploy on this host used a loose artifact.

Second, smaller: DEDB's `nssm-env-decode.test.ps1` tests the UTF-16 NUL-stripping directly. GCIO handles NULs in `Test-GcioHealthBody` and `ConvertFrom-NssmOutput` and tests the *health matcher*, but never the decode of real `nssm get` output.

### 4c. `Check-GcioDeployReady` still absent

Carried from the earlier gap analysis. A read-only pre-deploy check that reads the **service's own environment** rather than `.env`. GCIO's `install-service.ps1 -Preflight` reads the file; the two diverge the moment anyone edits one without the other, which is precisely when you want to know.

---

## 5. Summary

| Finding | Severity | Effort |
|---|---|---|
| §4a `-BindAddr` never passed — guard inert | **highest** — looks wired, is not | small: read `HOST` from `.env` and pass it |
| §4b outer-package extract untested | medium — shipped, unexercised | small: one test file |
| §4b `nssm get` decode untested | low — handled, just untested | small |
| §4c `Check-GcioDeployReady` | low | medium |
| `Start-ServiceVerified` | very low — health gate covers it in ~10 s | small |
| `Write-DbWarning` | very low — `/readyz` shows it | small |

Everything else that differs, differs because GCIO is one Windows application, on loopback behind IIS, with boot-time migrations and no second release line.

The headline: **the scripts are a faithful port, and the one thing to fix is a parameter nobody connected.**
