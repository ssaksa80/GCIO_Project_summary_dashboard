# Deployment record — 2026-08-28, development host

First deployment of GCIO using the release bundle system, performed on the
development workstation. **This is not the target production server.** Every
command below was actually run and every output is real; nothing is
reconstructed.

**Outcome:** the deployment itself succeeded completely. The application is
installed, correct, and runnable. It is **not currently serving**, because SQL
Server crashed independently partway through and restarting it needs an
elevated prompt this session does not have. Details in "Where it stands".

---

## What was deployed

| | |
| --- | --- |
| Artifact | `gcio-bundle-1.5.0-win-x64.zip`, 77.7 MB, 17,386 files |
| Built from | `451b161` |
| Install directory | `C:\gcio` |
| Previous state | Repo-shape install running **1.0.0** code, 34 projects |
| Deployed version | **1.5.0** |

---

## Step 0 — baseline

Captured before touching anything:

- Install shape: **repo** (`C:\gcio\server\index.js` present, no `app\`).
- Serving: `{"status":"ok","uptimeSec":43690,"version":"1.0.0"}`, 34 projects.
- `VAULT_DIR=C:\gcio\vault` — already absolute.
- **`DATA_DIR` absent.** The drop folder held one workbook; the vault held five
  files.

That missing `DATA_DIR` is the hazard recorded as Task 6A: a bundle installs the
app under `C:\gcio\app`, so a relative default would have resolved the drop
folder to `C:\gcio\app\data` and orphaned the real one — silently, with the
watcher sitting on an empty directory and `/healthz` still green.

## Step 1 — back up the irreplaceable state

```bash
cp -r /c/gcio/{.env,data,vault,audit} /c/gcio-predeploy-backup-20260828/
```

Backup at `C:\gcio-predeploy-backup-20260828`: 1 workbook, 5 vault files, the
env file (`sha256 9f09e463…`), and the previous service logs. The database was
not backed up — a bundle deploy does not touch it beyond the idempotent
boot-time migrations.

## Step 2 — stop the running instance

PID 43612, up since 10:32. Stopped; `8130` confirmed down before proceeding.

## Step 3 — add the missing `DATA_DIR`

`.env` copied to `.env.pre-bundle` first, then appended:

```
DATA_DIR=C:\gcio\data
```

Verified both state paths are absolute (2/2). No other line changed; 30 lines
to 36, the difference being this setting and its comment.

## Step 4 — deploy, using the real operator command

Artifacts copied to `C:\gcio-release` as an operator would receive them —
the zip plus `code-update.ps1` and `Update-GCIO.cmd`, which ship *beside* the
archive because they are what expands it.

```
Update-GCIO.cmd
```

Actual output:

```
[gcio] found gcio-bundle-1.5.0-win-x64.zip -> BUNDLE
[gcio] expanding to C:\gcio-release\gcio-bundle-1.5.0-win-x64
[gcio] verifying with verify-bundle.ps1
bundle OK: C:\gcio-release\gcio-bundle-1.5.0-win-x64 (17386 files verified)
[gcio] applying: install.ps1 -InstallDir C:\gcio -SkipHealthGate -Bundle
[gcio] installing the full bundle into C:\gcio (from none)
[gcio] installed 1.5.0
```

`-SkipHealthGate` because **no Windows service is registered on this host**, so
there is nothing for the gate to stop and start. That is a real limitation of
this rehearsal, not a shortcut — see "What was not tested".

Post-install checks:

- Host tooling installed: `install.ps1`, `install-service.ps1`, `VERSION`,
  `versions.json`, `lib\common.ps1` — all present. This is the `cd3b635` fix;
  without it rollback would be impossible.
- Bundled runtime: `node v24.19.0`, runs.
- State preserved: 1 workbook, 5 vault files, **no `app\data`**.

## Step 5 — start it

Started with the working directory at the **install root** and the script path
`app\server\index.js`, per `RELEASING.md`:

```
[gcio] schema is current
[gcio] loaded 34 projects from SQL
[gcio] elected ingest leader (lock "gcio-ingest:c:/gcio/data") -- watching the drop folder
[gcio] GCIO Project Intelligence listening on http://127.0.0.1:8130
[gcio] store: mssql · auth: ldap
[gcio] watching C:\gcio\data for workbooks (24x7 live ingestion)
```

`{"status":"ok","uptimeSec":0,"version":"1.5.0"}` — **1.5.0 in production for
the first time**; the host had been reporting `1.0.0` from a hardcoded literal.

`watching C:\gcio\data`, not `C:\gcio\app\data`. Task 6A holds on a real deploy.

Metrics all present, including the gauges added this cycle:

```
gcio_build_info{version="1.5.0"} 1     gcio_ingest_leader 1
gcio_projects 34                        gcio_read_model_age_seconds 12
gcio_ingest_runs{outcome="applied"} 7   gcio_demo_mode 0
```

`gcio_build_info` and `/healthz` now agree — they disagreed before this release.

---

## Step 6 — testing the gates against the live install

### 6a. A schema change must be refused

Built a patch from a modified `server/db/migrations.js` and applied it to the
running host:

```
WARNING: [gcio] PATCH REFUSED - NOTHING has been changed on this host.
WARNING: [gcio]   installed: 1.5.0
WARNING: [gcio]   patch:     1.5.0 (requires at least 1.5.0)
WARNING: [gcio]   reason:    schema-changed
WARNING: [gcio]   This patch changes the database schema (server/db/migrations.js). GCIO
                  applies migrations at boot, so an overlay would migrate this host
                  without anyone having chosen to.
WARNING: [gcio]   Recovery: install the full bundle instead -
```

Verified afterwards:

| Check | Result |
| --- | --- |
| App tree digest | `0a9ccf52f5abe9a1` — **identical** before and after |
| Still serving | yes, uptime 302s — never restarted |
| `deploy.log` | unchanged — a refusal is not a deploy |
| Backup taken | none — there was nothing to undo |

A dangerous patch was refused against a live, serving install without
disturbing it at all.

### 6b. A clean patch must apply

Planted `// DEPLOY-TEST-MARKER` in the installed `app\server\index.js`, then
applied a clean patch:

- Marker gone — the overlay replaced the file.
- `app\node_modules` still 243 entries, runtime still v24.19.0 — **preserved**,
  which is the entire point of the patch tier.
- Backup taken at `app.bak-20260828-230719`.
- `deploy.log` records the PATCH.
- Drop folder and vault untouched.

### 6c. Rollback must restore exactly

```
[gcio] rolling back to app.bak-20260828-230719
[gcio] rolled back -> 1.5.0
```

The marked file came back byte-identical (`2588dac4f66a5e52`), and `deploy.log`
recorded the ROLLBACK. This ran from the installer **on the host**, with no
artifact involved — which is the situation after a bad deploy, once the release
folder is gone.

Final `deploy.log`:

```
2026-08-28T22:58:56+04:00  BUNDLE    none -> 1.5.0
2026-08-28T23:09:31+04:00  PATCH     1.5.0 -> 1.5.0  backup=app.bak-20260828-230719
2026-08-28T23:10:43+04:00  ROLLBACK  1.5.0 -> 1.5.0
```

---

## Where it stands

**The application is not currently serving, and the deployment is not the
reason.**

At **23:07:12** the Windows System log recorded:

> The SQL Server (SQLEXPRESS) service terminated unexpectedly. It has done this
> 1 time(s). *(Event ID 7034)*

That is a crash, and it happened *before* the patch tests. The application had
already been running against it happily for eight minutes, only reading. The
restart afterwards then failed with `ECONNREFUSED 127.0.0.1:1433`.

The deployed code is fine, and that was proved rather than assumed — running the
installed build against the in-memory store starts cleanly, reports
`{"status":"ok","version":"1.5.0"}`, and watches the correct directory. Only the
database is missing.

**`MSSQL$SQLEXPRESS` has no failure actions configured, so it will not restart
itself.** Starting it needs elevation:

```
Start-Service 'MSSQL$SQLEXPRESS'
```

Then restart the application. A plausible contributing factor: this SQL Express
instance is shared with the Security Dashboard project, whose test suite runs
809 tests across 26 database-backed files and was being run repeatedly this
afternoon by another session. That is load this instance was not sized for, and
worth ruling in or out before treating the crash as isolated.

---

## What was NOT tested, and why

Stated plainly so nobody reads this record as more complete than it is.

1. **The health gate's success and failure paths.** Both need a registered
   Windows service for `install.ps1` to stop and start. Every apply here used
   `-SkipHealthGate`. The **refusal** path of the compatibility gates was
   tested thoroughly; the *health* gate was not, and neither was the automatic
   rollback that depends on it. Rollback itself is proven — but it was triggered
   by hand, not by a failed health check.
2. **The Windows service install.** `deploy/install-service.ps1` needs an
   elevated prompt. It also predates the `app\` layout and does not yet set the
   working directory and script path a bundle install requires.
3. **IIS and TLS.** `deploy/iis-site.md`, unexecuted.
4. **The backup and restore drill.** Runbook section 6, unexecuted.

---

## Cleanup still owed

The old repo-shape files are still in `C:\gcio` alongside the new `app\` and
`runtime\` — `server\`, `client\`, `node_modules\`, `package.json`, `scripts\`,
`shared\`. The bundle install does not remove them, and nothing currently reads
them.

**This is a hazard, not just untidiness:** two complete copies of the
application now sit in one directory, and which one runs depends entirely on
how the service is configured. Remove them once the service is installed and
verified against `app\server\index.js`, not before.

## Rolling this back entirely

The pre-deployment state is at `C:\gcio-predeploy-backup-20260828` (env file,
drop folder, vault, audit, previous logs). The repo-shape install it belongs to
is still in place and was never deleted, so reverting is: stop the app, restore
`.env` from `.env.pre-bundle`, and start `server\index.js` from `C:\gcio` as
before.
