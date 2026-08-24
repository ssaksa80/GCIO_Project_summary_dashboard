# Backend for production — design

**Date:** 2026-08-24
**Status:** approved, not yet implemented
**Supersedes nothing.** Builds on `2026-08-23-cio-section-order-design.md`.

## Why

The dashboard is verified and useful, but it is a single-process demo: no
authentication, no tests, and all state in one process's memory with a JSON
snapshot beside it. It can be piloted behind the firewall with a named group of
viewers. It cannot be the CIO's system of record until the gaps below are shut.

## Decisions taken

| Question | Decision |
| --- | --- |
| Where it runs | On-premises Windows server, behind IIS |
| Who gets in | Entra ID (Azure AD) SSO, group-mapped roles |
| How much history | Full history in PostgreSQL |
| Where data comes from | Excel stays the source of truth |

## Scope

**In scope:** authentication and authorisation, transport security, PostgreSQL
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
   │  data/     repository interface                          │
   │  adapters/ pg/  ·  memory/                               │
   │  ingest/   watcher · worker-thread parser · writer       │
   └──────────────────────────────────────────────────────────┘
                          │
              PostgreSQL — current state, history, audit
                          │
              File vault — immutable copy of every workbook
```

One box runs `ROLE=all`. The roles exist so the web tier can later be scaled or
failed over without a code change. Exactly one ingester may run: the ingest role
takes a **Postgres advisory lock** at startup and only watches the drop-folder
while it holds it. A second instance starts, fails to take the lock, and serves
web traffic only — it never double-imports.

Workbook parsing moves into a **worker thread**. A 20 MB workbook currently
blocks the event loop; after this, an upload cannot freeze other users' screens.

### Module boundaries

- `domain/` stays pure functions over plain objects, exactly as today. It must
  not import `pg`, `express`, or the config module. This is what keeps the
  ranking rules testable and unchanged.
- `data/repository.js` defines the interface the domain consumes:
  `getProjects(asOf)`, `getProject(id, asOf)`, `putIngestResult(...)`,
  `listSourceFiles()`, `appendAudit(event)`.
- Two adapters implement it: `adapters/pg` for production and
  `adapters/memory` for demos, tests, and the offline sample portfolio.
  `STORE=memory` must keep working after this work — it is how the product is
  demonstrated without a database.

## Data model

Temporal, because history was the point.

| Table | Purpose |
| --- | --- |
| `source_file` | every workbook ever ingested: name, sha256, bytes, uploaded_by, uploaded_at, vault_path |
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
6. `NOTIFY gcio_ingest` so every web instance pushes SSE to its clients.

Deletion of a watched file marks its projects' versions closed with a reason;
it must not hard-delete history.

## Authentication and authorisation

OIDC authorization-code flow with PKCE against Entra (`openid-client`).
Session cookie: `httpOnly`, `secure`, `SameSite=Lax`, encrypted, server-side
record in `app_session`, idle timeout 8 hours, absolute 24 hours.

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

- `helmet` with a Content-Security-Policy that allows only self; the client
  already ships its own fonts, so no external origins are needed.
- CSRF token on every state-changing request, paired with `SameSite=Lax`.
- Rate limits: uploads and exports per user, login attempts per IP.
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
| **P0 — safe pilot** | Entra SSO, roles, audit, helmet/CSRF/limits, upload sniffing, IIS + TLS, Windows service, health endpoints, first domain tests | An unauthenticated request gets 401; a Viewer's upload gets 403; both are covered by tests |
| **P1 — persistence** | Postgres, migrations, repository split, file vault, `STORE=memory` retained | Restarting mid-ingest loses nothing; the same summary comes out of both adapters |
| **P2 — history pays off** | Real trends, "changed since last week" in sections and exports, question ageing | The weekly brief states what changed, sourced from versions rather than file dates |
| **P3 — scale and ops** | Role split, advisory-lock election, worker-thread parsing, metrics, backup/restore drill, runbook | Two instances started together: exactly one ingests; a restore drill passes |

Each phase ships independently and leaves the product working.

## Risks

- **Entra app registration is not ours to create.** P0 cannot finish without a
  client id, tenant id, redirect URI and the three group names. Everything else
  in P0 can proceed in parallel.
- **PostgreSQL on-prem needs a host, a backup slot and a DBA contact.** If that
  approval is slow, P1 slips; P0 does not depend on it.
- **The corporate certificate and IIS access** gate the TLS work.
- **Sample-data mode must not rot.** Every phase keeps `STORE=memory` in the
  test matrix, or the demo path quietly dies.

## Open questions for the organisation

1. Entra: client id, tenant id, redirect URI, and the three group names.
2. PostgreSQL: version, host, whether the DBA team or we own migrations.
3. Retention: how long history and the vault are kept before archiving.
4. Whether audit must ship to a central SIEM as well as the local database.
