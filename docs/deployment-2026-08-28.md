# Deployment record — 2026-08-28, development host

First deployment of GCIO using the release bundle system, performed on the
development workstation. **This is not the target production server.** Every
command below was actually run and every output is real; nothing is
reconstructed.

**Outcome: deployed, running as a Windows service, and the whole
patch/health/rollback cycle proven against it.** GCIO 1.5.0 is serving on
`127.0.0.1:8130` under `GCIOProjectIntelligence`, started automatically, with
34 projects from SQL.

Two interruptions along the way, both recorded below rather than tidied away:
SQL Server crashed on its own partway through (event 7034, unrelated to the
deployment), and the first attempt at the rollback test proved nothing and had
to be re-run. Step 7 has both.

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

## An interruption: SQL Server crashed mid-deployment

At **23:07:12** the Windows System log recorded:

> The SQL Server (SQLEXPRESS) service terminated unexpectedly. It has done this
> 1 time(s). *(Event ID 7034)*

A crash, not a stop, and it happened while the application was only reading from
it. The next restart failed with `ECONNREFUSED 127.0.0.1:1433`.

The deployed build was proved sound rather than assumed - run against the
in-memory store it started cleanly, reported `1.5.0`, and watched the correct
directory. Only the database was missing.

`MSSQL$SQLEXPRESS` had **no failure actions configured**, so it would not have
restarted itself. Both were fixed from an elevated prompt:

```
Start-Service 'MSSQL$SQLEXPRESS'
sc.exe failure 'MSSQL$SQLEXPRESS' reset= 86400 actions= restart/60000/restart/60000/restart/60000
```

A plausible contributing factor, worth ruling in or out before treating the
crash as isolated: this SQL Express instance is shared with another project
whose test suite runs 809 tests across 26 database-backed files, and was being
run repeatedly that afternoon by another session.

---

## Step 7 - the Windows service, and the health gate

The service was installed from an elevated prompt on 2026-08-29:

```
NSSM:              C:\gcio
untime
ssm.exe
Node:              C:\gcio
untime
ode
ode.exe  (bundled)
Install directory: C:\gcio
Layout:            bundle  (entry: app\server\index.js)
Service created: GCIOProjectIntelligence
Status: Running   StartType: Automatic
Service is answering on http://127.0.0.1:8130
```

NSSM registered exactly what it should: `Application` the bundled runtime,
`AppParameters` `app\server\index.js`, `AppDirectory` `C:\gcio` so `.env`
resolves.

With a real service in place, the two things that had never been testable were
finally exercised.

### 7a. The health gate passes a good build

A clean patch, gate armed:

```
2026-08-28T23:53:16+04:00  PATCH  1.5.0 -> 1.5.0  backup=app.bak-20260828-235113  health=OK
```

`health=OK`, not `SKIPPED` - the service stopped, the overlay applied, it
restarted, and the gate polled `/healthz` and got a real answer.

### 7b. The health gate catches a bad build and rolls it back

A patch built from a `server/index.js` carrying a deliberate syntax error. It
passes all four compatibility gates by design - the schema and the lockfile are
untouched - so it reaches the health check, which is the point.

```
[gcio] patching GCIO 1.5.0 -> 1.5.0 (dependencies and schema verified; ...)
[gcio] health check (allowing time for first boot)
WARNING: [gcio] health check FAILED - rolling back to the previous version
Stop-Gcio : the patch failed its health check and was rolled back to 1.5.0
```

```
2026-08-29T00:22:04+04:00  PATCH-ROLLBACK  1.5.0 -> 1.5.0  health=FAIL
```

Verified afterwards:

| Check | Result |
| --- | --- |
| Service | Running, Automatic - recovered without intervention |
| `/healthz` | `1.5.0`, 34 projects |
| Restored code | `386ce799280b`, byte-identical to the clean build; 0 broken markers |
| `node_modules` / runtime | 243 entries, v24.19.0 - preserved through the failure |
| Drop folder / vault | untouched |

`service-err.log` carries the ESM compile failure, which is the evidence that
the broken build really did run rather than being rejected earlier by something
else.

**One false start worth recording.** The first attempt at 7b reported
`health=OK`. That was not a false pass: the installed `index.js` was
byte-identical to the clean build and no backup contained the broken marker, so
the broken code never reached the install - the artifact was staged in one step
and run in another, and which bytes the installer actually read could not be
proved afterwards. Re-run with a hash check immediately before invoking, it
failed and rolled back as designed. An assertion that cannot be tied to the
thing under test proves nothing, which is the same discipline the unit tests are
held to.

---

## Step 8 - removing the old repo tree, and proving a clean start

A bundle deployed over the older repo-shape install leaves the old files in
place. Two complete copies of the application in one directory is a hazard, not
untidiness: which one runs depends entirely on the service configuration.

Removed on 2026-08-29 after confirming NSSM points at `app\server\index.js`
with the bundled runtime, and that every path in the service environment
resolves to `C:\gcio\{data,vault,audit}` rather than the old tree:

```
server  client  shared  scripts  sample-data  package.json  package-lock.json
deploy  node_modules
```

About 161 MB, of which `node_modules` was 159 MB. Backed up first to
`C:\gcio-oldrepo-backup-20260829` (2.3 MB, everything except `node_modules`,
which is regenerable). Loose logs and the old deployment report were moved to
`logsrchive` rather than deleted.

**A running service is not proof.** The process kept serving throughout the
removal, uptime unbroken - but a running process does not re-read the
filesystem, so that shows nothing about whether it can START without those
files. The service is set to Automatic, so an undiscovered dependency would
surface at the next reboot, which is the worst possible time to find it.

Restarted deliberately:

```
[gcio 10:03:58] schema is current
[gcio 10:03:59] loaded 34 projects from SQL
[gcio 10:03:59] elected ingest leader (lock "gcio-ingest:c:/gcio/data") -- watching the drop folder
[gcio 10:03:59] GCIO Project Intelligence listening on http://127.0.0.1:8130
[gcio 10:03:59] watching C:\gcio\data for workbooks (24x7 live ingestion)
```

`{"status":"ok","uptimeSec":5,"version":"1.5.0"}` - a genuine cold start with
the old tree gone.

### A trap left in service-err.log

`C:\gcio\logs\service-err.log` contains **15 stack traces** of the
`SyntaxError: Unexpected identifier 'is'` from the deliberately broken patch -
NSSM restarted the failing application repeatedly during the rollback test at
00:22 before the health gate gave up and rolled back.

They are historical and the application has been healthy since. But anyone who
tails that file while diagnosing a future problem will find a syntax error in
`app/server/index.js` that has not existed for hours, and it looks exactly like
a live fault. The file was left alone rather than truncated because NSSM holds
it open; NSSM's own rotation (`AppRotateFiles`, 10 MB) will eventually clear it.
**Check the timestamps before believing that trace.**

---

## What was NOT tested, and why

Stated plainly so nobody reads this record as more complete than it is.

1. **IIS and TLS.** `deploy/iis-site.md`, unexecuted. The service listens on
   `127.0.0.1:8130` with no TLS in front of it.
2. **The backup and restore drill.** Runbook section 6, unexecuted.
3. **A cross-version upgrade.** Every patch applied here was 1.5.0 to 1.5.0.
   The version arithmetic in the gates is unit-tested but has never moved a real
   host between two different versions.
4. **LDAP sign-in.** `AUTH_MODE=ldap` against a directory this machine cannot
   reach, so no user has actually signed in to the deployed instance.

## A security change made during this work

To let the assistant session run the rollback test without an elevated prompt,
the operator granted the interactive account start/stop/pause rights on this one
service:

```
sc.exe sdset GCIOProjectIntelligence "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWRPWPDTLOCRRC;;;<user-sid>)"
```

It grants no admin rights and cannot create or delete services, but it is a
permanent widening of access and **should be reverted before this host is
treated as anything like production**. The original descriptor:

```
D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)
```

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
