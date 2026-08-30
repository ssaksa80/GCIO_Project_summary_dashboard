# GCIO bundle validation, and how it compares to DEDB's

**Date:** 2026-08-30
**Method:** built both GCIO artifacts fresh, verified them, and compared the **shipped zips** against DEDB's shipped zips — not the source that produces them. `C:\dev\DExDashBoard` read-only throughout.

Comparing artifacts rather than build scripts matters: a ship list can name a file the build never copies, which is exactly the defect found on this project twice.

---

## 1. Validation result

| | Result |
|---|---|
| `gcio-bundle-1.5.0-win-x64` | **bundle OK — 17,387 files verified** |
| `gcio-patch-1.5.0-win-x64` | **patch OK — 84 files verified** |
| Deploy suites | 13 files, all passing |
| Deployed and running | 1.5.0 on `C:\gcio`, service Running, 34 projects |

Both verify against their own `checksums.txt`, and each verifier refuses the other's tier.

---

## 2. Artifact structure, side by side

Read from the actual zips.

| Entry | DEDB bundle 1.62.0 | GCIO bundle 1.5.0 | Notes |
|---|---|---|---|
| `app/` | yes | yes | |
| `lib/` | yes | yes | |
| `runtime/` | yes | yes | Node + NSSM |
| `checksums.txt` | yes | yes | identical format |
| `VERSION` | yes | yes | |
| `versions.json` | yes | yes | |
| `install.ps1` | yes | yes | |
| `uninstall.ps1` | yes | yes | |
| `install-service.ps1` | — | **yes** | GCIO registers the service separately |
| `apply-migrations.ps1` | yes | — | GCIO migrates at boot |
| `templates/`, `install.sh`, `uninstall.sh` | yes | — | Linux; GCIO is Windows-only |
| `trust-ad-ca.ps1` | yes | — | LDAPS CA trust, environment-specific |
| `Set-DedbBindHost.ps1` | yes | — | GCIO does not pin a bind address |
| `Check-DedbDeployReady.ps1` | yes | — | **the one real remaining gap** |

Patch tier:

| Entry | DEDB patch 1.61.1 | GCIO patch 1.5.0 |
|---|---|---|
| `app/`, `lib/`, `install.ps1`, `checksums.txt`, `patch-meta.json`, `VERSION` | yes | yes |
| `apply-migrations.ps1` | yes | — (n/a) |
| `uninstall.ps1` | — | **yes** |

GCIO's patch ships `uninstall.ps1` where DEDB's does not. That is deliberate: GCIO's installer refreshes the host tooling on every apply, so the scripts on a host never lag the artifact that last touched it. DEDB's host keeps whatever its last **bundle** installed.

### Sizes

| | DEDB | GCIO |
|---|---|---|
| Bundle | 54.3 MB | 77.7 MB |
| Patch | 5.9 MB | 0.9 MB |
| Patch as % of bundle | 10.9% | **1.2%** |

GCIO's bundle is larger (Node 24 against DEDB's Node 20, different dependency closure). Its patch is far smaller — DEDB ships two SPAs plus fonts and assets in every overlay; GCIO ships one.

---

## 3. `checksums.txt` — identical

```
<sha256>  .\app\client\dist\assets\...
```

Same algorithm, same two-space separator, same `.\` relative prefix, same sort order, same exclusion of `checksums.txt` itself. A file from one project would parse correctly in the other's verifier.

---

## 4. `patch-meta.json` — the one substantive divergence

**DEDB:**

```json
{
  "kind": "patch", "version": "1.61.1", "nodeMajor": 20, "minBase": "1.61.0",
  "server": { "packageLockSha256": "52ddb8e6..." },
  "migrations": [
    { "name": "001_init.sql",       "sha256": "1b158d0a..." },
    { "name": "002_governance.sql", "sha256": "f4a7443b..." },
    ...
  ]
}
```

**GCIO:**

```json
{
  "kind": "patch", "version": "1.5.0", "nodeMajor": 24, "minBase": "1.5.0",
  "lockDepsHash": "198ef4bd...",
  "migrationsFingerprint": "89396d2e...",
  "builtFrom": "3b71747"
}
```

Three differences, each with a reason:

**`server.packageLockSha256` → `lockDepsHash`.** DEDB nests under `server` because it has three applications with separate manifests. GCIO has one, so the nesting would be empty ceremony.

**A migrations ARRAY → a single fingerprint.** This is the real one. DEDB fingerprints each `.sql` file, GCIO hashes the whole of `server/db/migrations.js` because its migrations are JavaScript objects, not files.

> **The capability GCIO gives up:** DEDB can tell an operator **which** migration changed. GCIO can only say the schema changed. On a refusal, DEDB's message could name `004_alerts.sql`; GCIO's says "migrations.js changed". Less informative — and worth revisiting if migrations ever move to `.sql` files.
>
> **The cost GCIO accepts:** whole-file hashing over-triggers. A comment edit in `migrations.js` forces a bundle. That is the safe direction, and it is pinned by a test so nobody "fixes" it later.

**`builtFrom` is populated.** GCIO records the git short SHA the artifact was built from. DEDB has the field but the shipped 1.61.1 artifact does not carry a value. Small, but it means any GCIO artifact can be traced to a commit without consulting a release log.

---

## 5. Where GCIO is stricter than DEDB

Not everything went one way.

| | DEDB | GCIO |
|---|---|---|
| Host-script ship list | `if (Test-Path)` — a renamed script silently stops shipping | **build fails** on a missing entry |
| Artifact self-check | packs whatever staged | **build fails** if the artifact would not satisfy the host's own structural test |
| Hashing | `Get-FileHash` only | falls back to .NET — a real deploy account lacked the cmdlet |
| Service control check | `IsInRole(Administrator)` | tests the **capability**, so an ACL-granted account is not refused |
| Blob reads across git refs | `git show \| Out-String` — console codepage mangles multi-byte characters | `cmd` redirection, byte-faithful |
| Host scripts | contain non-ASCII | **ASCII-checked** — a BOM-less non-ASCII `.ps1` breaks 5.1 parsing |
| Gates | tested | **mutation-tested** — each disabled in turn, confirmed to turn only its own tests red |

The ship-list difference is the one that matters most: it is how `Set-DedbBindHost.ps1` reached zero DEDB hosts across many releases, and GCIO hit the same class of defect **inside its own clone of the fix** — `uninstall.ps1` was added to the bundle's list but not the patch's, and the patch shipped silently without it. Both lists now fail loudly.

---

## 6. What is still missing

**`Check-GcioDeployReady`** — a read-only pre-deploy check run **on the host**, reading the *service's own environment* rather than `.env`. GCIO's `install-service.ps1 -Preflight` is close but reads the file, and the two diverge the moment anyone edits one without the other. This is the last item from the original gap analysis.

Deliberately not cloned, with reasons recorded: DEDB's lean Node-on-target package (needs a first-run wizard GCIO does not have), its second release line, its explicit migration runner, Linux artifacts, bind-host pinning, and LDAPS CA trust.

---

## 7. Verdict

**The clone is faithful where it matters and better where it was cheap to be.** Both tiers build, verify and install; the gates, health gate, rollback, SQL pre-check and clean-stop behave correctly against a live service; and the artifact formats are compatible enough that `checksums.txt` is byte-format identical.

The one capability genuinely lost is naming *which* migration changed on a refusal — a direct consequence of GCIO keeping migrations in JavaScript, and recoverable only by moving them to `.sql` files.

Everything else that differs, differs because GCIO is one Windows application with boot-time migrations rather than three applications with an operator-run migration step.
