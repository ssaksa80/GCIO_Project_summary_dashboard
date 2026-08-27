# Runbook

For whoever is reading this because something is wrong, and did not build the
thing. Every command below is labelled **[verified]** — run on this development
machine while this document was written, with its actual output shown — or
**[needs an elevated prompt — not executed]**, meaning it was never run and the
paragraph next to it says what a working run is expected to look like. Nothing
here is marked verified because it looked right.

A runbook nobody has run is worse than no runbook, because it is trusted.

---

## 1. What this is and where it runs

**GCIO Project Intelligence** is a Node.js process (`server/index.js`). One
instance is the norm; more than one may be run, in which case exactly one of
them is elected to ingest. It:

- serves the dashboard and its API on `127.0.0.1:<PORT>` (default `8123`) —
  loopback only in production; it never terminates TLS itself
- holds the portfolio in one of two stores, chosen by `STORE`:
  - `mssql` — SQL Server is the system of record (production)
  - `memory` — in-process, lost on restart (demos, local development)
- watches a **drop folder**, `data/` by default, with `chokidar`; a workbook
  copied in is ingested within about a second and pushed to every open browser
  over server-sent events
- elects **exactly one ingest leader** when `STORE=mssql`, using a SQL Server
  session-scoped advisory lock, so running more than one instance cannot
  produce two processes writing the same workbook. Followers never touch the
  drop folder; they serve reads and refresh from SQL on a timer. If the leader
  dies **nothing re-elects a replacement** — see section 8
- copies every ingested workbook into the **vault** (`VAULT_DIR`, default
  `vault/`) before parsing it, named by content hash and filed by year/month —
  the vault is what makes "replay everything through a fixed parser" and "what
  did the file actually say" both answerable later
- writes session, audit and role-mapping data to SQL Server when `STORE=mssql`,
  or to files under `AUDIT_DIR` / in-process when `STORE=memory`

In production this process runs as a **Windows service**, installed and
managed by NSSM via `deploy/install-service.ps1`. NSSM captures its stdout and
stderr under `<repo root>\logs\service-out.log` and `service-err.log`, rotated
at 10 MB. **IIS** sits in front of it with Application Request Routing,
terminates the corporate TLS certificate, and proxies everything to
`127.0.0.1:<PORT>` — see `deploy/iis-site.md`. IIS also blocks `/metrics` from
everywhere but the monitoring host.

Monitoring has three open, unauthenticated endpoints: `/healthz` (liveness),
`/readyz` (is there a portfolio to serve), and `/metrics` (Prometheus text
exposition, numbers only — see section 7). All three answer without a session
because a health check or a scraper cannot sign in.

This document was written and its verified commands were run against the
development machine `APPSRV1\SQLEXPRESS`, database `GCIO`. That machine
is **not** the target production server, and section 2 says explicitly where
that matters.

---

## 2. First deployment

Do these in order. Step 0 and every step marked elevated need an administrator
at the keyboard; nothing here was skipped because it was inconvenient — the
build machine this document was written on has no elevated shell and does not
have NSSM installed, which is the honest reason those steps could not be run
for real.

### Step 0 — install NSSM **[needs an elevated prompt — not executed]**

Download NSSM from <https://nssm.cc/download> and put `nssm.exe` on `PATH`.
There is nothing to verify here beyond `nssm --version` printing a version
once it's done — this step exists only because step 1 will otherwise fail on
it, correctly.

### Step 1 — preflight, unelevated **[verified]**

Run this before opening any elevated prompt. It changes nothing (the one
exception — creating `VAULT_DIR`/`AUDIT_DIR` if they don't exist yet — is
called out in its own output when it happens) and checks everything an
elevated install would need: Node, NSSM, the env file, the required
variables, the port, the client build, the two data directories, and the
database.

```bash
cd /path/to/GCIO_Project_summary_dashboard
powershell -NoProfile -File .\deploy\install-service.ps1 -Preflight
```

Actual output, this machine, this session:

```
Preflight checks (unelevated, no changes) for C:\dev\GCIO_Project_summary_dashboard\deploy\..\.env

  [PASS] Node on PATH, v20+ - v24.19.0 at C:\Program Files\nodejs\node.exe
  [FAIL] NSSM on PATH - nssm was not found on PATH - download from https://nssm.cc/download
  [PASS] Env file exists and parses - 16 variable(s) found
  [PASS] STORE / AUTH_MODE / DB variables present - STORE=mssql, AUTH_MODE=dev
  [FAIL] AUTH_MODE is not dev - AUTH_MODE=dev accepts any password; the install path refuses this
  [WARN] NODE_ENV is production - NODE_ENV is 'development'; the install path warns but does not refuse this
  [FAIL] Port 8123 is free - already in use by: node
  [PASS] Client build present - C:\dev\GCIO_Project_summary_dashboard\client\dist\index.html
  [PASS] VAULT_DIR writable - writable (C:\dev\GCIO_Project_summary_dashboard\vault)
  [PASS] AUDIT_DIR writable - writable (C:\dev\GCIO_Project_summary_dashboard\audit) (unused: STORE=mssql routes audit to dbo.AuditEvent, not the filesystem)
      connecting to localhost\SQLEXPRESS (sql auth as gcio_app)
      connected as: gcio_app
      Microsoft SQL Server 2025 (RTM-GDR) (KB5102333) - 17.0.1125.2 (X64)
      database GCIO: present
  [PASS] Database reachable (db-check.mjs) - exit code 0

Preflight: 3 of 11 check(s) failed.
```

Exit code was `1`.

**This is exactly the expected result on this machine, and it must not be
used as the pass/fail bar anywhere else.** The three failures here —
NSSM absent, `AUTH_MODE=dev`, port 8123 held by a leftover Node process — are
permanent features of this development box, not of a correctly prepared
server. **On the target server, every single check must pass.** Do not
compare its failure list against this one and wave through anything that
happens to match; a real server showing `AUTH_MODE=dev` at go-live is not a
coincidence to be ignored — it is exactly the condition step 4 below refuses
to install, on purpose.

Two things this preflight **cannot** tell you, because of what it runs as:

- **It checks paths as whoever is sitting at the keyboard, not as the service
  account.** A service account that cannot read the env file, or cannot write
  to `VAULT_DIR`/`AUDIT_DIR`, will pass every line above and then fail the
  moment the service actually starts. Before going further, verify by hand,
  logged on as (or impersonating) the service account:
  - it can read the env file (`Get-Content <path to .env>` should succeed,
    not prompt, not throw access denied)
  - it can create a file inside `VAULT_DIR` and inside `AUDIT_DIR`
- **Every check must pass on the target server.** A preflight run on a laptop
  or a staging box proves nothing about the machine the service will actually
  run on. Run `-Preflight` again, from an ordinary prompt, on the real server,
  with the real `.env` in place, before opening the elevated prompt in step 4.

### Step 2 — create the database

```bash
sqlcmd -S "<server>\SQLEXPRESS" -U sa -C -i scripts/db-create.sql
```

**[needs an elevated prompt — not executed]** — needs a SQL Server sysadmin
login, a different privilege boundary from an elevated PowerShell prompt, and
one this session does not hold on any server but this development box (where
the database this script would create already exists, so running it again
would only prove the idempotency guards work, not the creation path itself).
It is idempotent (`IF NOT EXISTS` throughout): safe to run again on a database
`db-create.sql` already created. Before running it for real, replace
`CHANGE_THIS_PASSWORD` inside the script and put the same value in `.env` as
`DB_PASSWORD`. Expected output: `GCIO database and gcio_app login are ready.`
Confirm with:

```bash
node scripts/db-check.mjs
```

**[verified]** — read-only (`SELECT SUSER_SNAME()` and a lookup in
`sys.databases`), and exactly what preflight step 1 above already calls
internally; its output was captured there:

```
connecting to localhost\SQLEXPRESS (sql auth as gcio_app)
connected as: gcio_app
Microsoft SQL Server 2025 (RTM-GDR) (KB5102333) - 17.0.1125.2 (X64)
database GCIO: present
```

### Step 3 — build the client

On a fresh checkout, install dependencies first with `npm ci` — ordinary,
generic to any Node project, and not re-run here against this checkout,
because another task was concurrently using this same working tree and a
full `node_modules` reinstall was not worth the risk of pulling it out from
under that work. The step actually specific to this project, and the one
verified here, is the build itself:

```bash
npm run build
```

**[verified]**, against this checkout's existing `node_modules` (font and
asset lines trimmed for length; nothing else edited):

```
> gcio-project-summary-dashboard@1.3.0 build
> vite build --config vite.config.js

✓ 805 modules transformed.
dist/index.html                    1.05 kB
  … 9 font/asset files omitted …
dist/assets/index-Cj5QNjuA.js     263.25 kB
dist/assets/index-BV3SQHd7.js     675.87 kB
✓ built in 10.77s
```

Confirms `client/dist/index.html` exists afterwards — the same file preflight
step 1 checks for.

### Step 4 — install the service **[needs an elevated prompt — not executed]**

From an **elevated** PowerShell prompt, in the repository root:

```powershell
.\deploy\install-service.ps1 -EnvFile C:\gcio\.env
```

Not runnable from this session — no elevated shell, and NSSM is not
installed here (see step 0). Expected behaviour, read from the script itself
rather than guessed: it refuses `AUTH_MODE=dev`, warns (does not refuse) on
`NODE_ENV` other than `production` and on `STORE=memory`, installs the
service via `nssm install`, points its stdout/stderr at
`<repo root>\logs\service-out.log` / `service-err.log`, starts it, and then
polls `http://127.0.0.1:<PORT>/readyz` for up to 30 seconds — a `200` or a
`503` (no data ingested yet, which is not a failure this early) both count as
"the service answered"; anything else after 30 seconds prints a warning
pointing at `service-err.log`.

Keep `EnvFile` **outside the repository**, ACL'd so only the service account
and administrators can read it — it holds the database password.

### Step 5 — put IIS in front for TLS **[needs an elevated prompt — not executed]**

Follow `deploy/iis-site.md` in full: enable the ARR proxy, add the
`HTTP_X_FORWARDED_PROTO` server variable, create the HTTPS site, add the
`web.config` from that document (which also blocks `/metrics` from outside —
**its `^10\.|^127\.0\.0\.1$` address pattern is a placeholder**; replace it
with the real monitoring subnet before the site goes live, or the rule either
blocks the real monitoring host or under-restricts the whole thing), and
disable ARR's response buffering so live SSE updates are not held until the
buffer fills. That document's own "Verify" section has the `curl.exe` checks
to run once it's done — they need the real TLS certificate and DNS in place,
which this development machine does not have, so they were not run here.

### Step 6 — confirm no service exists yet on this machine **[verified]**

Run before doing anything else destructive, and useful again any time a
"was it ever installed" question comes up:

```powershell
Get-Service GCIOProjectIntelligence -ErrorAction SilentlyContinue
```

Output on this machine: nothing — no such service exists here, as expected
(this development box has never had the service installed).

---

## 3. Upgrading

`deploy/install-service.ps1` is **re-runnable** and doubles as the upgrade
path: it stops and removes any existing `GCIOProjectIntelligence` service
before reinstalling, so re-running it with a newer checkout is the entire
upgrade procedure. What it preserves:

- the **env file** — it only reads it, never writes it; the same `-EnvFile`
  path is reused, so nothing about configuration needs restating
- the **database and the vault** — neither is touched by the installer; schema
  migrations run automatically at process boot (`migrate()` in
  `server/index.js`), forward-only and idempotent, so starting a newer build
  against an older schema is expected and self-healing
- **nothing about the service's log files** — `logs/service-out.log` and
  `service-err.log` are not deleted by a reinstall

What an upgrade actually is, in order: pull the new code, `npm ci && npm run
build` (verified above as step 3), then re-run the elevated install command
from step 4. The preflight from step 1 is worth running again first —
it will catch a config drift (a variable renamed, a new required one) before
the elevated step does.

---

## 4. The dashboard is stale

Someone says the numbers look old, or a workbook they dropped an hour ago
never showed up. Work through these **in this order** — each one either
answers the question or narrows where to look next.

**If more than one instance is running, first find out which one answered.**
Only the leader ingests; followers refresh from SQL every 30 seconds
(section 8), so a dashboard a few *seconds* behind is a follower waiting for
its next poll and is working as designed. Scrape each instance directly:

```bash
curl -s http://127.0.0.1:8123/metrics | grep -E "gcio_ingest_leader|gcio_read_model_age_seconds"
```

- `gcio_ingest_leader 1` — this is the leader; carry on with the steps below.
- `gcio_ingest_leader 0` with `gcio_read_model_age_seconds` climbing past 30
  and never resetting — this follower's poll is failing, not the ingest. Look
  in the log for `follower read-model refresh failed` and treat it as a
  database-reachability problem (section 5, step 4). The leader may be ingesting
  perfectly well while this instance shows nobody the result.
- **no instance reports `gcio_ingest_leader 1`** — nothing is ingesting
  anywhere. The leader process died and there is no automatic re-election.
  Restart it; the rest of this section will not find anything until you do.

### 1. `/readyz`

```bash
curl -s http://127.0.0.1:8123/readyz
```

**[verified]** (against the scratch instance used throughout this document —
substitute the real port):

```
{"ready":true,"projects":59,"lastIngestAt":"2026-08-26T05:55:02.994Z"}
```

- `200` with `ready:true` — there is data, and `lastIngestAt` says when the
  portfolio last actually changed. Compare that timestamp to when the
  workbook was dropped.
- `503 {"ready": false, "reason": "no data has been ingested yet"}` — nothing
  has ever landed. Skip straight to "the watcher" below; there is no ingest
  history to read yet either.

### 2. `GET /api/ingest/runs` (admin only)

```bash
curl -s -b <a signed-in session cookie> http://127.0.0.1:8123/api/ingest/runs?limit=20
```

**[verified]** (against the same scratch instance as `/readyz` above,
substitute the real port) — signed in first via `POST /api/auth/login`
(`AUTH_MODE=dev` accepts any password on this scratch instance), then called
with the resulting session cookie, against `STORE=memory`:

```
{"historyEnabled":false,"count":0,"runs":[]}
```

That specific reply (`historyEnabled:false`) is expected and correct under
`STORE=memory` — there is no database to hold history, so every file's
outcome is invisible here regardless of what actually happened to it; this
whole diagnosis step only has something to say under `STORE=mssql`, which is
what production runs. There, look for the file by name in the list:

- **Present, with an outcome** — the file reached the parser. `applied` says
  how many projects changed; `unchanged` means the bytes matched what is
  already live (re-dropping the same file does nothing, correctly);
  `failed` carries the specific parse error in its `error` field — a rejected
  file **is** recorded here with outcome `failed`, it is not silently
  dropped; `removed` means the file was deleted from `data/` and its
  projects went with it. `finishedAt: null` on an old row means the process
  died mid-ingest.
- **Absent entirely** — the file never reached `ingestFile()` at all. Usually
  means its extension is not one of `.xlsx .xlsm .xls .csv`, or its name
  starts with a dot or ends `.tmp`/`.uploading` — the watcher ignores those
  before an ingest attempt is even made, so nothing is logged for them
  either. Rename and re-drop, or check the extension.

### 3. The server log's `rejected <file>` line

If the file is genuinely missing from ingest history under `STORE=mssql`
too (a database write failure while recording the rejection, for instance),
the server's own log still has the answer — `server/index.js` prints
`rejected <file>: <reason>` the moment a parse fails, independent of whether
recording that in history also succeeded. Under the Windows service this is
`<repo root>\logs\service-err.log` (rejections go through `console.error`
equivalents; check `service-out.log` too since the exact stream depends on
how the message was logged). Look for the filename.

### 4. The watcher

No log line at all, for a file that has clearly been sitting in `data/` for a
while, points at the watcher rather than the parser. Check the boot log for
`watching <path> for workbooks (24x7 live ingestion)` — if that line is
missing, the process either hasn't restarted since a config change or the
watcher failed to start. Restarting the service re-establishes it.

### 5. The drop folder's permissions

Two different permission failures look different, and it is worth telling
them apart rather than guessing:

- **The service account cannot open the specific file**, but can list the
  directory — `ingestFile()` (`server/ingest.js`) wraps its own
  `fs.readFileSync` in a `try/catch` and turns the OS error into an ordinary
  `{ ok: false, error: err.message }` result, which flows through **exactly
  like a bad workbook**: it shows up in `GET /api/ingest/runs` with outcome
  `failed` and logs a `rejected <file>: ...` line, same as steps 2 and 3
  above. The tell is the error text itself — `EACCES: permission denied` or
  `EPERM`, not a parsing complaint about the file's contents. If step 2 or 3
  already showed one of those, this is not a fifth thing to check — it is
  the answer, and the fix is the file's ACL, not the workbook.
- **The service account cannot list `data/` at all** — this is the genuinely
  silent one, because it never reaches `ingestFile()` and produces no
  ingest-run row and no `rejected` line. `chokidar`'s own `error` event is
  wired up (`watcher.on("error", ...)` in `server/ingest.js`) and does get
  logged, but as `[watch] <message>`, a different line from `rejected` — easy
  to miss if you were only grep-ing for the latter. If nothing in steps 2–4
  turned anything up for a file that has clearly been sitting there, search
  the log for `[watch]` instead, and verify by having the **service account**
  (not the interactive account that dropped the file) run `Get-ChildItem`
  against `data/`.

---

## 5. The dashboard is down

### 1. `/healthz`

```bash
curl -s http://127.0.0.1:8123/healthz
```

**[verified]** (against the same scratch instance as section 4, substitute
the real port):

```
{"status":"ok","uptimeSec":9,"version":"1.0.0"}
```

No response at all (connection refused, timeout) means the process is not
listening where you're asking — check IIS is proxying to the right port
first, since `NODE_ENV=production` binds Node to loopback only and IIS is the
only thing that can reach it from outside. A response like the one above
(this route's own `VERSION` constant, currently `"1.0.0"` and **distinct
from** `gcio_build_info`'s `package.json`-derived version on `/metrics` — see
section 7; the two numbers are not the same thing and are not expected to
match) means the process itself is fine; the problem is downstream (database,
or the client bundle failing to serve).

### 2. Service state

```powershell
Get-Service GCIOProjectIntelligence
```

**[verified]** — but only in the sense of confirming what it prints when the
service does not exist, which is all this development machine can show: no
service has ever been installed here (section 2, step 6). Actual output:

```
Get-Service: Cannot find any service with service name 'GCIOProjectIntelligence'.
```

On a server where the service **is** installed, this instead prints a
`Status` of `Running` or `Stopped` — that part was not seen for real and is
stated from NSSM's own documented behaviour, not from a run. `Stopped` with
recent restarts is a crash loop — NSSM is configured to restart the process
on exit (`AppExit Default Restart`, five-second delay), so a service that
keeps going Stopped → Running → Stopped is dying on startup, almost always a
configuration or database problem rather than a one-off. `Running` but still
not answering `/healthz` points at the network path (IIS, firewall, the
wrong port in the env file) rather than the process.

### 3. The log

`<repo root>\logs\service-err.log` first, then `service-out.log`. A process
that never got past boot will have a stack trace near the end of
`service-err.log` — most commonly a configuration problem (`loadConfig`
throws with every missing variable named in one message) or a database the
process could not reach at startup (`getPool`/`migrate` throwing before the
app is even created, when `STORE=mssql`).

### 4. The database

If `STORE=mssql` and the log shows a connection failure: confirm the SQL
Server service is running on its host, and re-run
`node scripts/db-check.mjs` from the application's own directory with its own
`.env` — it uses the exact same `buildConfig` the app uses, so a failure here
is the same failure the app is having, not a different one that merely looks
similar. A database that goes away **after** the process is already up does
not crash it — `server/db/executor.js` treats a dead connection as a clean
503 (`dbUnavailable`) and drops the pool so the next request reconnects,
rather than wedging every request behind a dead socket. If the dashboard is
returning intermittent 503s rather than being fully down, that degradation
path is very likely what you're seeing, and the fix is "why did the database
become unreachable," not "why is the process stuck."

---

## 6. Backup and restore

**The drill and a real recovery are not the same procedure**, and the
difference matters enough that a runbook that only describes one of them is
dangerous. The drill (`scripts/backup-restore-drill.mjs`) proves the backup
and restore machinery works, safely, beside the live system. A real recovery
overwrites the live system on purpose, because it is already broken.

### The drill **[needs an elevated prompt — not executed]**

```bash
node scripts/backup-restore-drill.mjs [--to DIR] [--as NAME] [--keep] [--drop]
```

What it does, in order: counts rows in every history table in the source
database; takes a `COPY_ONLY` backup (so it never disturbs the real backup
chain — a differential taken later stays relative to the last *real* backup,
not to this one); restores that backup under a different database name;
compares row counts table by table; confirms every workbook the restored
copy's `SourceFile` rows point at is actually present in the vault; and
cleans up. It exits non-zero if anything mismatches. **This was not run as
part of writing this document.** Two reasons, not one: its first-ever run
against a fresh server needs the one-time administrator provisioning step
below before `gcio_app` can use it at all, which is the same kind of
privileged, one-off action as an elevated install; and on *this* database
specifically, another task had just finished proving the drill clean, so
running it again here was avoided as redundant risk for no new evidence, per
this task's own instructions. Everything below is read from the script's own
file header, which itself records what running it for real, on 2026-08-26,
actually found.

**Three facts the drill discovered by being run, not by being written.
Carry all of them; do not soften them:**

- **`gcio_app` is not a member of `dbcreator` and has no `CREATE ANY
  DATABASE` permission**, contrary to what this project's own earlier notes
  assumed. It has `db_owner` on `GCIO`, which is enough to
  back up, but not enough to restore to a database that does not already
  exist: `RESTORE FILELISTONLY` fails with error 262
  ("CREATE DATABASE permission denied in database 'master'") even though it
  reads nothing and creates nothing. The drill therefore needs a **one-time
  provisioning step**, run once by an administrator, before its first ever
  run:

  ```sql
  CREATE DATABASE [GCIO_DrillRestore];
  ALTER AUTHORIZATION ON DATABASE::[GCIO_DrillRestore] TO [gcio_app];
  ```

  After that the drill is repeatable unattended as the application login,
  which is why it **leaves the scratch database in place by default** and
  only tears it down when passed `--drop`. Dropping it every run would make
  the next run need an administrator again — not something you can put on a
  schedule.
- **The drill cannot delete its own backup files.** They are written by the
  SQL Server *service account* into its backup directory, and neither
  `gcio_app` nor an ordinary interactive user can delete — or even `stat` —
  what it wrote there. The script reports this as a warning rather than a
  failure. Stale `.bak` files need a **periodic purge by a sysadmin**, e.g.
  with `xp_delete_file`, or by hand.
- **For the same reason, the script reads the backup's size and logical file
  names from `msdb.dbo.backupset`/`backupmediafamily`/`backupfile`, not from
  the filesystem or from `RESTORE FILELISTONLY`.** A drill that `stat`s the
  file it just wrote fails on any Windows deployment where the backup
  directory belongs to the service account — which is the default.

To check the first fact against any server without running the drill itself,
this read-only query is safe to run any time:

```bash
sqlcmd -S "<server>\SQLEXPRESS" -d GCIO -U gcio_app -P "$DB_PASSWORD" -C -W \
  -Q "SELECT IS_ROLEMEMBER('db_owner') AS db_owner, IS_SRVROLEMEMBER('dbcreator') AS dbcreator, SUSER_SNAME() AS who"
```

**[verified]** — run against this development machine's `gcio_app` login
while writing this document:

```
db_owner dbcreator who
-------- --------- ---
1        0         gcio_app

(1 rows affected)
```

Matches the finding above exactly: `db_owner`, not `dbcreator`.

**How often:** before anything anyone is nervous about (a schema migration, a
parser change going to production) and on a standing schedule otherwise —
weekly is reasonable given it is `COPY_ONLY` and does not disturb the real
backup chain. It refuses to run at all against `NODE_ENV=production` without
an explicit `--i-mean-it`, and refuses to target the source database's own
name under `--as`, so it is safe to schedule without much second-guessing.

### A real restore **[needs an elevated prompt — not executed]**

This is not the drill run without `--drop`. A real restore happens because
the live database is gone or corrupt, and it **goes over the top of the
source database on purpose**:

1. Stop the service (`Stop-Service GCIOProjectIntelligence`) — nothing should
   be writing to `GCIO` during the restore.
2. Restore the database from the most recent good backup, over the existing
   `GCIO`:
   ```sql
   RESTORE DATABASE [GCIO] FROM DISK = N'<path to .bak>' WITH REPLACE, RECOVERY;
   ```
   Because `GCIO` already exists and `gcio_app` already holds `db_owner` on
   it (from `scripts/db-create.sql`), this does **not** need `dbcreator` —
   the drill's finding above is specifically about restoring onto a name
   that does not exist yet, which a real recovery does not do. It is still
   worth doing this step as a DBA/sysadmin login: a real recovery usually
   also needs `ALTER DATABASE [GCIO] SET SINGLE_USER WITH ROLLBACK
   IMMEDIATE` first to force out any lingering connections, and that does
   need elevated database rights.
3. **Restore `VAULT_DIR` alongside it, from its own separate backup, to the
   same point in time as the database backup.** The database and the vault
   are backed up separately (the vault is a plain filesystem tree, not
   inside SQL Server) and a mismatch between them is a real recovery failure
   mode of its own: a `SourceFile` row pointing at a vault path from *after*
   the vault's last backup, restored from a database backup that is
   *older*, is consistent; restoring the database from a *newer* backup than
   the vault leaves rows pointing at files that were never saved. Restore
   both from backups taken close together, and prefer restoring the vault
   from a point at or after the database's backup time, never before.
4. Start the service, then check `/readyz` and `GET /api/health` for a
   plausible project count, and open a handful of specific projects to
   confirm they show real data and not a stale or empty state.

**Not run against this machine's live database**, for the same reason the
drill was not re-run: this is the destructive procedure the drill exists to
avoid ever performing untested. Practising it for real means practising it
against a throwaway instance, not the shared one another task just finished
proving clean.

---

## 7. What the metrics mean

`GET /metrics` is Prometheus text exposition, open at the application (like
`/healthz`/`/readyz`) and blocked at the proxy for everything but the
monitoring host (`deploy/iis-site.md` — replace its placeholder address range
before relying on that block). It answers `200` with `gcio_up 1` even when
the store or the ingest history is unreadable; only the series that need
those to compute are omitted, never the whole response.

| Series | Meaning |
| --- | --- |
| `gcio_up` | Constant `1` if the process answered the scrape at all. |
| `gcio_build_info{version="…"}` | The deployed build's version, from `package.json`, as a label on a constant `1`. **The release process must bump `package.json` alongside the git tag**, or this stops being able to answer "did the fix land" — a tag moving without the version bumping means this metric silently goes stale. |
| `gcio_uptime_seconds` | Seconds since the process started. |
| `gcio_ready` | `1` when there is a portfolio to serve — the same condition `/readyz` uses. See the limitation below before alerting on this alone. |
| `gcio_demo_mode` | `1` when serving the bundled sample portfolio rather than real workbooks. |
| `gcio_projects` / `gcio_source_files` | Portfolio size, and how many workbooks are contributing to it. |
| `gcio_last_ingest_timestamp_seconds` | When the portfolio last changed — **always emitted**, `0` if it never has. Deliberately not omitted on a database with no history yet: the natural alert, `time() - gcio_last_ingest_timestamp_seconds > 86400`, evaluates to an empty result against a *missing* series (the standard Prometheus `absent()` trap) and would never fire for the one case most worth catching — a server that has never ingested anything. `0` reads as maximally stale under that same comparison, which is the truth. |
| `gcio_ingest_runs{outcome="applied\|unchanged\|failed\|removed"}` | Ingest attempts by outcome, all-time, all four labels always present even at zero (`STORE=mssql` only — there is no history under `STORE=memory`). |
| `gcio_ingest_parse_slowest_ms` / `gcio_ingest_persist_slowest_ms` | Slowest recorded parse/persist in the last 7 days. Omitted (not zeroed) when there is nothing to report yet. |
| `gcio_ingest_leader` | `1` when this process holds the ingest lock and is watching the drop folder, `0` when another instance holds it (`STORE=mssql` only; always `1` under `STORE=memory`, which has nothing to contend over). Summed across every instance this should be exactly `1` — see the alerts below. |
| `gcio_read_model_age_seconds` | Seconds since **this instance's** read model last refreshed from SQL. On a leader that is time since its last ingest, so **large and steady is normal on a quiet portfolio** — it means nothing has changed, not that anything is broken. On a follower it should reset roughly every 30 seconds; large and climbing there means its poll is failing. Do not alert on this without separating leaders from followers first, or every quiet weekend will page someone. Omitted entirely (not zeroed) under `STORE=memory`, which has no separate read model to go stale. |

**[verified]** — started on a scratch port to avoid the instance already
running on 8123 on this machine, then scraped:

```bash
STORE=memory AUTH_MODE=dev DEV_ROLE=admin PORT=8196 node server/index.js &
curl -s http://127.0.0.1:8196/metrics
```

Actual reading (`# HELP`/`# TYPE` comment lines trimmed for length; every
value line is exact and in the order returned):

```
gcio_up 1
gcio_build_info{version="1.5.0"} 1
gcio_uptime_seconds 2
gcio_ready 1
gcio_demo_mode 1
gcio_ingest_leader 1
gcio_projects 59
gcio_source_files 4
gcio_last_ingest_timestamp_seconds 1787829237
```

Three things are absent from that reading, all expected rather than bugs.
`gcio_ingest_runs` and `gcio_ingest_parse_slowest_ms` need the `ingestRuns`
repository, which `STORE=memory` does not have; `gcio_read_model_age_seconds`
needs a read model that refreshes separately from ingest, which `STORE=memory`
also does not have. All three are present under `STORE=mssql`.
`gcio_ingest_leader` **is** present and reads `1`: a single in-memory process
is trivially its own only possible ingester.

### Alert on these three or four

1. **`time() - gcio_last_ingest_timestamp_seconds > 86400`** (adjust the
   threshold to how often real data is expected to change) — catches a
   **stale portfolio**: the watcher died, the drop folder's permissions
   broke, or nobody has fed it real data since a fresh deploy. Because the
   series is always present, this fires correctly even on a server that has
   never ingested anything, which is exactly the silent-failure mode a
   missing series would hide.
2. **`increase(gcio_ingest_runs{outcome="failed"}[1h]) > 0`** — catches a
   **failed ingest**: a workbook was dropped and rejected. Pairs directly
   with section 4's diagnosis path — the same `outcome="failed"` rows are
   what `GET /api/ingest/runs` shows with the specific error.
3. **`gcio_demo_mode == 1`** — catches a **demo-mode dashboard left running
   in production**: the bundled fictional sample portfolio being shown to
   real executives is a shipped-wrong-config failure, not a data problem,
   and this is the one series that says so directly.

4. **`sum(gcio_ingest_leader) == 0`** (multi-instance deployments only) —
   catches **nobody is ingesting**: the leader died and, because there is no
   automatic re-election (section 8), no follower took over. This is distinct
   from alert 1 and worth having alongside it: a stale portfolio may simply
   mean nobody dropped a file, whereas this says the machinery to accept one
   is not running anywhere. Its mirror, `sum(gcio_ingest_leader) > 1`, should
   be impossible — if that ever fires, the lock is not doing its job and two
   processes are racing on the same drop folder, which is the exact failure
   the election exists to prevent.

`gcio_up` absent from a scrape (rather than present and `0`, which never
happens — the process either answers with `1` or does not answer) is the
classic dead-man's-switch case: alert on the scrape itself going missing,
not on a value, since the process cannot report its own absence.

---

## 8. Known limitations

- **A dead ingest leader is not replaced until someone restarts it.** When
  `STORE=mssql`, each instance tries at boot to take a SQL Server
  session-scoped advisory lock (`sp_getapplock`, `server/db/leaderElection.js`)
  named after the drop folder. Exactly one wins and watches the folder;
  the rest log `follower: another instance holds the ingest lock` and serve
  reads without ever ingesting. `gcio_ingest_leader` says which is which.
  **There is no automatic re-election.** Kill the leader and no follower takes
  over: the survivors keep serving reads, correctly and within the staleness
  window below, but nothing new is ingested until a leader process is started
  again. This was verified by killing a live leader and watching no failover
  happen — it is not an untested assumption. It is also deliberate. Failover
  that mis-fires and briefly elects two leaders reintroduces the exact
  primary-key collision the election exists to prevent, and a portfolio that
  is visibly an hour old is a better failure than one that is quietly wrong.
  Alert on `sum(gcio_ingest_leader) == 0` (section 7); that, rather than a
  stale-portfolio alert, is what distinguishes "nobody is ingesting" from
  "nobody has dropped a file."
- **A follower's portfolio can be up to 30 seconds behind the leader's.** A
  follower never calls the ingest path, and that path is the only place the
  read model is otherwise refreshed — so it re-reads from SQL on a timer
  instead (`FOLLOWER_REFRESH_INTERVAL_MS`, `server/readModelRefresh.js`). Two
  people on two instances can therefore see different numbers for up to that
  long after a workbook lands. `gcio_read_model_age_seconds` is how far behind
  each instance actually is. The interval is a constant, not configuration:
  nobody has yet had a reason to change it, and a knob nobody tunes is not a
  feature. A *leader* that loses its lock mid-run (a dropped connection, say)
  demotes itself, starts this same poll from that moment, and stays a follower
  — correct, but never a leader again without a restart.
- **Parsing happens on the event loop, not in a worker thread — watch
  `gcio_ingest_parse_slowest_ms`.** Today's workbooks are 14–27 kB and parse
  in single-digit milliseconds, so moving parsing off the event loop was
  judged to be complexity added for a load that does not exist. The
  application itself warns in its log once a single parse takes 500 ms or
  more (`SLOW_PARSE_MS` in `server/repos/ingestRuns.js`) — that threshold,
  not a round number picked for this document, is what should trigger
  revisiting the decision. `gcio_ingest_parse_slowest_ms` is the same number,
  exposed for a graph instead of a log line.
- **The endpoint-comparison limit from Phase 2.** Change markers compare a
  project's state at exactly two points — the start and end of the selected
  period — not the path between them. A project that was Red at the start,
  recovered, and slid back to Red by the end shows as no change, because
  both endpoints are Red; the dashboard is reporting where the period began
  and ended, not asserting the project was stable throughout. Answering "how
  long has this actually been Red" needs trend history this phase does not
  build.
- **`gcio_ready` cannot tell "no data yet" from "broken."** It reports the
  same condition `/readyz` does: is there at least one project to serve. For
  the SQL store specifically, a freshly deployed instance — connected to a
  real, working database that is simply empty because nothing has been
  ingested yet — reports `gcio_ready 0`, identically to an instance that
  cannot reach its database at all. Someone will alert on `gcio_ready == 0`
  sooner or later; when they do, pair it with `gcio_up` (still `1` on a
  merely-empty deployment) or with `gcio_last_ingest_timestamp_seconds`
  before paging anyone, or a brand-new, correctly-working deployment will
  generate its first incident on day one.
