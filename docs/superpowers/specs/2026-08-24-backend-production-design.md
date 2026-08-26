# Backend for production — design

**Date:** 2026-08-24
**Status:** Phase 3 delivered, tagged `v1.4.0-p3`. The SQL Server path is now
proven against a live instance (SQL Server 2025): migrations apply and re-apply
cleanly, a real workbook persists and reads back, the section engine runs over
SQL data unchanged, and dropping a workbook into the watched folder reaches the
database.
**Amended 2026-08-24:** the stack changed after this was approved. DExDashBoard
(DEDB) and FMD already run this organisation's dashboards in production on
**SQL Server with LDAP and Entra SSO**, so GCIO mirrors that rather than
introducing PostgreSQL and a second OIDC library. The original decisions are
kept below, struck through, so the change of mind is visible rather than
quietly rewritten.

Builds on `2026-08-23-cio-section-order-design.md`.

## Why

The dashboard is verified and useful, but it is a single-process demo: no
authentication, no tests, and all state in one process's memory with a JSON
snapshot beside it. It can be piloted behind the firewall with a named group of
viewers. It cannot be the CIO's system of record until the gaps below are shut.

## Decisions taken

| Question | Decision | Amended |
| --- | --- | --- |
| Where it runs | On-premises Windows server, behind IIS | unchanged |
| Who gets in | Group-mapped roles | LDAP **and** Entra SSO, both mirrored from DEDB, either usable |
| Database | ~~PostgreSQL~~ | **SQL Server**, the engine DEDB and FMD already run |
| Driver | ~~`pg`~~ | `mssql`, with DEDB's pool / executor / repository layering |
| Auth library | ~~`openid-client`~~ | `ldapts` + `jose`, as DEDB uses |
| How much history | Full history | unchanged in intent; the temporal model is **not yet built** — see Phase 1 |
| Where data comes from | Excel stays the source of truth | unchanged |

## Scope

**In scope:** authentication and authorisation, transport security, SQL Server
persistence with full history, audit, ingestion hardening and a file vault,
observability, backups, an automated test suite, and Windows service packaging.

**Out of scope, deliberately:** write-back editing from the UI, connectors to
SharePoint / Project Online / Jira, multi-tenancy, mobile apps, and any change
to the four-section reading order or the ranking rules — those are settled and
must behave identically after this work.

## Sizing assumptions

≤300 named users, ≤5,000 projects, ≤50 workbooks a day, one site, AED
throughout. Anything an order of magnitude past this invalidates the "one box"
shape below, not the layering.

## Architecture

```
                         IIS  (TLS, corporate certificate)
                          │   reverse proxy → 127.0.0.1:8123
                          ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Node service — ROLE = web | ingest | all                │
   │                                                          │
   │  http/     routes · auth · validation · rate limits      │
   │  domain/   sections · summarize · chain   (pure, unchanged)│
   │  repos/    projects · posture · sessions · roleMapping   │
   │            · audit    (Executor interface, DEDB style)   │
   │  db/       pool · executor · migrations                  │
   │  ingest/   watcher · parser · writer                     │
   └──────────────────────────────────────────────────────────┘
                          │
              SQL Server — current state, history, audit
                          │
              File vault — immutable copy of every workbook
```

One box runs `ROLE=all`. The roles exist so the web tier can later be scaled or
failed over without a code change. Exactly one ingester may run: the ingest role
takes a **SQL Server application lock** (`sp_getapplock`, owner `Session`) at
startup and only watches the drop-folder while it holds it. A second instance starts, fails to take the lock, and serves
web traffic only — it never double-imports.

Workbook parsing moves into a **worker thread**. A 20 MB workbook currently
blocks the event loop; after this, an upload cannot freeze other users' screens.

### Module boundaries

- `domain/` stays pure functions over plain objects, exactly as today. It must
  not import `mssql`, `express`, or the config module. This is what keeps the
  ranking rules testable and unchanged.
- Repositories are factories over an **Executor** (`query` / `tx`), as DEDB
  writes them. The executor accepts a pool *getter*, so a reconnect is picked up
  without rebuilding every repository, and a dead pool raises a clean 503.
- `SqlStore` presents the same synchronous read surface as the in-memory
  `Store`: SQL is the system of record and a read model is refreshed after each
  ingest. The section engine stays synchronous and untouched, and a database
  outage degrades to the last known portfolio rather than a blank page.
- `STORE=memory` must keep working — it is how the product is demonstrated
  without a database, and every API test uses it.

## Data model

Temporal, because history was the point.

| Table | Purpose |
| --- | --- |
| `Project` / `ProjectChild` | **built.** Current portfolio state, children as JSON payloads read and written whole per project |
| `PostureDomain` | **built.** Section 5, replaced per source workbook |
| `Sessions`, `RoleMapping`, `AuditEvent` | **built.** Server-side sessions, group-to-role map, audit trail |
| `source_file` | *planned.* every workbook ever ingested: name, sha256, bytes, uploaded_by, uploaded_at, vault_path |
| `ingest_run` | one per file event: source_file_id, started_at, finished_at, outcome, projects_seen, projects_changed, rows_rejected, error |
| `project_version` | a row **only when the project's content hash changes**: project_id, ingest_run_id, valid_from, valid_to, all project fields, content_hash |
| `milestone`, `update_note`, `risk`, `question` | children of a `project_version` |
| `question_asked` | every question surfaced to the CIO — workbook or derived — with first_seen, last_seen, resolved_at |
| `audit_event` | actor, action, subject, at, ip, user_agent |
| `app_session` | server-side session records for the cookie store |

Current state is `project_version WHERE valid_to IS NULL`. A named index on
`(project_id, valid_to)` and one on `(valid_from, valid_to)` carry the
as-of queries.

**Why versions rather than a change log:** the CIO's period views ask "what was
true during this window", which a temporal table answers with one predicate.
A change log answers "what changed" but forces replay to reconstruct a week.

**What history unlocks** (built in P2, not before): "Red for six weeks" instead
of "Red today"; a *changed since last week* block in every section and export;
and question ageing — "asked three weeks running, still unanswered", which the
current design cannot express because it has no memory of what it asked.

## Ingestion

1. Watcher (or upload) sees a file.
2. Hash it. If the sha256 matches the newest `source_file` for that name,
   record a no-op run and stop — re-saving a file must not create versions.
3. Copy the bytes to the **file vault** (`vault/YYYY/MM/<sha256>.xlsx`) before
   parsing. The vault is the recovery story: any period can be re-derived from
   scratch, and a bad parse can be replayed after a fix.
4. Parse in a worker thread. Malformed rows are rejected individually with a
   reason, never aborting the file — as today.
5. Write inside one transaction: close changed `project_version` rows
   (`valid_to = now()`), insert the new ones, refresh children, upsert
   `question_asked`, finish the `ingest_run`.
6. Refresh the read model and push SSE to connected clients. One instance owns
   ingestion today, so this is in-process; a scaled web tier needs a shared
   channel (Service Broker, or polling `ingest_run`) before that holds.

Deletion of a watched file marks its projects' versions closed with a reason;
it must not hard-delete history.

## Authentication and authorisation

Two routes in, both mirrored from DEDB:

- **LDAP** — bind as the user, so verifying a credential needs no service-account
  password, then read `memberOf`.
- **Entra SSO** — the browser obtains an ID token and posts it to
  `/api/auth/sso`; issuer, audience, signature, expiry and the `mfa` claim are
  all checked before a session exists. A token signed by an unknown key means
  Entra rotated, so the key set is refetched once and the token retried.

Either way the role is resolved server-side from directory groups. The session
cookie is `httpOnly`, `secure` in production, **`SameSite=Strict`**, and carries
only an opaque id; the record lives in `dbo.Sessions` with absolute expiry and
the idle window both enforced in the WHERE clause.

| Role | Granted by Entra group | May |
| --- | --- | --- |
| Viewer | `GCIO-Dashboard-Viewers` | read all views, run exports, download the template |
| PM | `GCIO-Dashboard-PMs` | everything a Viewer may, plus upload workbooks |
| Admin | `GCIO-Dashboard-Admins` | everything, plus read the audit log and ingest diagnostics |

Group names are placeholders until the directory team confirms them; they live
in config, not in code. No role may delete history through the API.

Every export, upload, sign-in and project view writes an `audit_event`. Exports
name the format and the period, because "who took the portfolio out of the
building" is the question an auditor actually asks.

## Hardening

- Dependency-free security headers, as DEDB does it: nosniff, `X-Frame-Options:
  DENY`, no-referrer, a self-only CSP, HSTS behind TLS. The client ships its own
  fonts, so no external origin is allowed.
- **No CSRF token.** DEDB carries none and the reasoning holds here: the session
  cookie is `SameSite=Strict`, the app is same-origin with no CORS, and every
  state-changing route requires that cookie, so a cross-site post arrives
  unauthenticated and is refused. Recorded in
  `server/middleware/securityHeaders.js` so it is not rediscovered as a gap.
- In-memory per-IP throttle on the credential endpoints, and a separate cap on
  exports.
- Upload validation: extension **and** magic bytes (`.xlsx`/`.xlsm` must be a
  ZIP container, `.xls` an OLE2 one), size cap, count cap, filename sanitised
  as today.
- Node binds `127.0.0.1` only; IIS terminates TLS with the corporate
  certificate; `X-Forwarded-*` trusted only from localhost.
- Secrets (client secret, DB password, cookie key) come from environment
  variables loaded by the service wrapper, never from a file in the repo. Boot
  fails loudly if any required variable is missing or obviously a placeholder.

## Observability and operations

- `pino` JSON logs to rotating files, plus errors to the Windows Event Log.
  Every request carries a correlation id; log lines never include row contents.
- `/healthz` — process alive.
  `/readyz` — database reachable **and** the last successful ingest is inside
  its expected window. Monitoring can alert on this without a human watching.
- `/metrics` (Prometheus text) behind the Admin role: ingest duration, rows
  rejected, export counts, SSE client count.
- Backups: nightly `pg_dump` plus the file vault. A restore drill is part of
  the definition of done for P3, not a later intention.
- Windows service via NSSM, auto-start, restart on failure.

## Testing

`node:test` — no new framework.

| Layer | What is tested |
| --- | --- |
| Domain | frozen fixtures: a project 54 days overdue scores exactly what it scores; derived questions fire on exactly the right states |
| Ingest | deliberately awful workbooks — banner rows, merged cells, `AED 1.2M`, `0.72` vs `72`, blank IDs, a `.txt` renamed `.xlsx` |
| Repository | both adapters against the same contract suite; the pg one against a scratch schema |
| API | `supertest`: a Viewer cannot upload; an anonymous request cannot read; CSRF rejects a forged post |
| Exports | every format produces a valid file; `scripts/pptx-audit.mjs` must report zero problems |

`npm test` must pass before a release. CI runs locally (`local-ci-fallback`)
until GitHub Actions minutes are available.

## Rollout

| Phase | Delivers | Done when |
| --- | --- | --- |
| **P0 — safe pilot** | LDAP + Entra SSO, roles, audit and audit reader, security headers and throttles, upload sniffing, IIS + service packaging, health endpoints, 102 hermetic tests plus 10 live SQL tests | **Met.** An unauthenticated request gets 401 and a Viewer's upload 403; the SQL path is verified end to end against SQL Server 2025 |
| **P1 — history foundation** | `SourceFile`, `IngestRun`, `ProjectVersion`, content-hash idempotency, the file vault; `STORE=memory` retained | **Met.** Re-ingesting an unchanged workbook records `unchanged` and manufactures no history; a changed project appends exactly one version; the in-memory store is untouched |
| **P2 — history pays off** | "Changed since last week" in sections and exports, sourced from `ProjectVersion` | **Partly met.** The brief states what moved and where it cannot know. **Trend lines and question ageing are outstanding** — deferred because both need months of accumulated history to say anything true, not because they were forgotten |
| **P3 — a survivable first deployment** | `/metrics`, ingest timing, a backup/restore drill that has been executed, an unelevated install preflight, the runbook | **Partly met.** The drill runs as the application login and its comparison is proven able to fail; the preflight names what is missing before anyone opens an elevated prompt. **The role split and lock election are deferred, and worker-thread parsing was replaced by measurement** — see below |
| **P4 — testing the thing people actually look at** | A real-browser test suite for the client (`puppeteer-core` + `node:test`, gated behind `UI_LIVE=1 npm run test:ui`): the five report sections and KPI strip render with real content in the CIO's specified order, the four change-badge states and their computed colours, the sign-in gate, the project drawer, and the all-projects table filter; an `axe-core` accessibility pass against the sign-in page, the dashboard, and an open drawer; a written assessment (`docs/accessibility-assessment.md`) covering what automation cannot see too (keyboard operation, focus management, zoom); `README.md` documents how to run it and what it deliberately does not cover | **Partly met.** The suite runs and catches exactly the class of defect a server test cannot — rendering and computed colour. **One accessibility finding conflicts with a mandated brand colour and is deliberately left unresolved**: `--critical` (Pantone 192 C) fails WCAG text contrast on every dark theme's surface, carried in the suite as `todo` — visible on every run, not a silently dropped test or a red gate — pending a brand-owner decision (see Risks below). **Several ordinary accessibility defects are recorded but not fixed** — no `<main>` landmark, the drawer's missing focus trap and 99-tab-stop distance from its own trigger, the all-projects table's mouse-only sort and row-open — per this phase's explicit scope of assessing, not remediating |

Each phase ships independently and leaves the product working.

**P3's three departures, all decisions rather than omissions.** The ingest/web
role split and the `sp_getapplock` election guard a failure that requires two
running instances, and there is one — an election that has never elected
anything, cannot be meaningfully tested, and protects a configuration nobody has
deployed is motion rather than progress. When a second instance is genuinely
planned this becomes the first thing to build, and `gcio_ingest_runs` plus the
last-ingest timestamp are what would reveal a double ingest in the meantime.
Worker-thread parsing was replaced by measurement: the workbooks are 14-27 kB and
parse in 8-65 ms, measured across all four, so a worker pool would add real
complexity to the ingest path for a load that does not exist. `ParseMs` is now
recorded per ingest and warned on past 500 ms, which is an order of magnitude
above steady state and below the point where a request served during an ingest
would fail rather than merely feel slow — so the deferral gets revisited on
evidence rather than on anyone's say-so.

Two notes on the table above, both written before decisions that outlived the
wording. The store is **SQL Server**, not Postgres — the P1 row said Postgres
because it predates the DEDB stack decision recorded in the amendment at the top
of this document. And P1 as delivered keeps `dbo.Project` as the current
snapshot and adds history beside it, rather than replacing it with the
`valid_from`/`valid_to` temporal table this spec originally described: the read
path, the store and the live tests all worked already, and a defect in a
brand-new history writer must not be able to break the dashboard everyone
depends on. The cost — the newest `ProjectVersion` duplicates what `Project`
holds — was accepted deliberately. `question_asked` ageing moved to P2, where it
belongs with the other things history makes possible.

## Risks

- **Entra app registration is not ours to create.** P0 cannot finish without a
  client id, tenant id, redirect URI and the three group names. Everything else
  in P0 can proceed in parallel.
- **The service has still never been installed.** Until it is, "deployed" means
  a process someone started by hand. NSSM is not on the build machine and the
  install needs an elevated prompt, so Phase 3 delivered a preflight that runs
  unelevated and names everything missing rather than a deployment. The
  remaining step is genuinely one command, but it has not been run.
- **`gcio_app` is not in `dbcreator`**, contrary to what this document
  previously assumed. It has `db_owner` on `GCIO` — enough to back up, not enough
  to restore to a database that does not already exist. The backup drill
  therefore needs a one-time `CREATE DATABASE` and `ALTER AUTHORIZATION` by an
  administrator, and it cannot delete its own backup files, which the SQL Server
  service account owns. Both are recorded in `docs/runbook.md`.
- **SQL Server access is the live blocker.** The instance on the build machine
  has `sa` disabled and no other sysadmin, so the database cannot be created
  without recovering administrative access. Everything else in Phase 0 is done;
  the SQL path is tested against a fake pool and has never touched a live
  instance.
- **The corporate certificate and IIS access** gate the TLS work.
- **Sample-data mode must not rot.** Every phase keeps `STORE=memory` in the
  test matrix, or the demo path quietly dies.
- **The client had no automated tests at all until Phase 4.** Every rendering
  defect this project has actually hit in production use — the PPTX cover
  running two lines together, a badge painted the wrong colour because it had
  four states and the code handled three, a colour rule scoped under the
  wrong parent class doing nothing — was found by hand, after the fact,
  because nothing exercised `client/src` before now. That is a fact about how
  P0 through P3 were actually verified — entirely at the server boundary and
  by eye, never in a browser — not just a historical note, and it belongs on
  the record rather than left implicit.
- **`--critical` (Pantone 192 C) fails text contrast on three of four
  dashboard themes, and needs a brand-owner decision.** Used verbatim as
  chip and inline text on the obsidian, sapphire, and emerald themes, it
  measures as low as 2.58:1 against their surfaces where WCAG requires
  4.5:1 (3:1 even for large text) — confirmed and reproduced in
  `docs/accessibility-assessment.md`, Finding 1. No fix keeps the literal
  mandated hex while reaching threshold on any of the dark grounds derived
  from Pantone 281 C; platinum already sidesteps this with its own derived
  red rather than the raw hex, which shows the fix exists but not without
  moving off the fixed colour. `test/ui/accessibility.test.js` carries this
  as an explicit `todo`, not a passing test and not a deleted one, so it
  stays visible until whoever owns the palette decides.

## Open questions for the organisation

1. Entra: client id, tenant id, redirect URI, and the three group names.
2. SQL Server: which instance, which service account, and whether the DBA team
   or we own migrations. Note that the `mssql` driver's default transport does
   not implement Windows Integrated auth from `trustedConnection` alone — see
   `server/db/pool.js`.
3. Retention: how long history and the vault are kept before archiving.
4. Whether audit must ship to a central SIEM as well as the local database.
