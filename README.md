# GCIO Project Intelligence

A 24×7 live executive portfolio dashboard for the CIO and C-suite. Ingests project
data from Excel (single or bulk), summarizes it into daily / weekly / monthly / yearly
executive briefings, offers full drill-down into any project's chain and history, and
exports boardroom-grade briefs to **PowerPoint**, **Excel**, **Word**, and **HTML**.

Everything is presented in the CIO's reading order:

1. **Successes**
2. **Questions, Risks & Issues**
3. **Priorities**
4. **Roadmap / Planned Projects**

## Quick start

```
npm install          # once
npm run build        # once (builds the web client)
npm start            # serves http://localhost:8123
```

Or double-click **start-dashboard.cmd**.

Out of the box this runs in development mode: the in-memory store with the
bundled sample portfolio, and a sign-in screen that accepts any password and
grants the role in `DEV_ROLE` (admin by default). See
[Running it for real](#running-it-for-real) for a real deployment — both
shortcuts are refused when `NODE_ENV=production`.

With no data present, the dashboard boots in **demonstration mode** using the bundled
sample portfolio (59 projects across 4 workbooks — regenerate anytime with
`npm run sample-data`).

> **The demonstration data is entirely fictional.** Every project, person, budget,
> date, risk and status in `sample-data/`, in the screenshots under `docs/`, and in
> the bundled demo pages is invented for illustration. The names come from fixed
> made-up pools in `scripts/generate-sample-data.js`; they are not real people, and
> the figures are not any organisation's real portfolio. Vendor names are real
> companies used only as plausible placeholders — their appearance implies no
> relationship of any kind.

## Feeding it real data — two ways, both live

1. **Drop-folder (24×7):** copy `.xlsx` / `.xls` / `.xlsm` / `.csv` files into `data/`.
   The watcher ingests them within ~1 second and pushes the update to every open
   browser via server-sent events — no refresh needed. Deleting a file removes its
   projects. Updating a file re-syncs them.
2. **Upload button:** drag-and-drop up to 20 workbooks at once in the UI; they are
   validated, stored into `data/`, and take effect immediately.

### Workbook format

Download the canonical template from the upload dialog (or `GET /api/template`).
Column headers are matched **intelligently** — `PM`, `Project Manager`, and `Owner`
all map to the same field; `RAG`, `Health Status`, `G/A/R`, `On Track / At Risk` are
all understood; dates accept ISO, `dd/mm/yyyy`, Excel serials; money accepts
`AED 1,200,000`, `1.2M`, plain numbers; percent accepts `0–1` or `0–100`.

Optional sheets **Milestones**, **Updates**, **Risks**, and **Questions** (joined by
Project ID) enrich the drill-down. `Parent Project ID` builds the program→project
chain shown in the drawer.

The **Questions** sheet feeds section 2 directly:

| Project ID | Question | Asked By | Raised | Needed By | Decision Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| P-1042 | Approve the 6-week re-baseline, or hold the date and de-scope? | S. Rahman | 2026-08-20 | 2026-08-29 | CIO | Open |

A single `Open Question` column on the Projects sheet works too. Where a workbook
carries neither, the dashboard **derives** questions from portfolio state — projects
held with no restart date, missing owner or sponsor, approved but unfunded, forecast
past target, overspent, or silent for more than 30 days. Derived questions are
labelled `derived` and always state the evidence behind them.

## What the CIO sees

A slim KPI strip (portfolio size, health mix, committed spend, deliveries, overdue,
open questions), then the four sections in order, then a collapsed all-projects table.

**1 · Successes** — projects delivered in the period with their budget outcome,
milestones closed, work on final approach (≥90%), projects meaningfully ahead of their
burn line, and the delivery trend.

**2 · Questions, Risks & Issues** — questions first, because they are the only part
that needs a decision in the room: each carries its urgency, its source (PM-authored or
derived), the evidence behind it, and who owns the decision. Then the severity-ranked
risk register with health by department, then issues that have already materialised
(overdue, behind the burn line, overrun, milestones slipped, held).

**3 · Priorities** — a ranked call list. Each row shows an urgency score, the reasons
that add up to it, and a **Needed:** line stating what the CIO must actually decide.
Below it, a watch list of what is next in line.

**4 · Roadmap / Planned Projects** — in-flight work on a forecast timeline (target
marked, slip hatched), the planned pipeline with a readiness flag, milestones falling
due, and committed spend by strategic pillar.

Clicking any project name anywhere opens the full record: owner, sponsor, approval and
delivery dates, budget burn, forecast finish, milestone timeline, risk register, update
feed, and the parent/child project chain.

### Exports

One click from the top bar. **PPT** builds the deck immediately; the **Export brief**
menu also offers Excel, Word and HTML.

| Format | Contents |
| --- | --- |
| PowerPoint | Six 16:9 slides — cover with KPIs, then one slide per section (questions and risks/issues split across two) |
| Excel | `Executive Summary`, then `1 Successes`, `2 Questions Risks Issues`, `3 Priorities`, `4 Roadmap`, then `Portfolio` and `Projects Detail` |
| Word | Cover page, KPI table, the four sections, chart images, per-project briefs |
| HTML | Self-contained page — email or print ready, no assets folder |

Single-project briefs export from inside the drawer.

### Look and feel

Four identities — Obsidian, Platinum, Sapphire, Emerald — all built from the mandated
brand palette (40% Pantone 281 C, 40% 354 C, 15% 375 C, and 5% secondaries used only
for status marks and chart series). The interface typeface switches between **Arial**
and **Aptos** from the top bar. Both choices are remembered per user.

Motion is GSAP-driven — sections reveal on scroll, KPI numbers count up, bars grow,
and the live indicator pulses on ingest. All of it collapses to the correct static
state when the viewer prefers reduced motion.

### URL controls

Any view can be linked, printed or captured exactly:

| Parameter | Effect |
| --- | --- |
| `?snapshot=1` | settled, non-live render — disables the event stream so the page reaches a stable load state (printing, screen capture, kiosk) |
| `?theme=sapphire` | open in a specific identity (`obsidian`, `platinum`, `sapphire`, `emerald`) |
| `?font=aptos` | open in a specific typeface (`arial`, `aptos`) |
| `?project=PRJ-1003` | open straight into a project's record |
| `?table=1` | expand the all-projects reference table |

## Running it for real

The dashboard runs unauthenticated with an in-memory store for demonstrations,
and behind directory sign-in with SQL Server for real use. The difference is
configuration, not a different build.

### Deploying

1. **Configure.** Copy `.env.example` to `.env` and fill it in. Keep it outside
   the repository on a server, ACL'd to the service account: it holds the
   database password. `NODE_ENV=production` refuses the two shortcuts that must
   never reach a server — `AUTH_MODE=dev` (any password is accepted) and, by
   default, an in-memory store.
2. **Create the database.** `scripts/db-create.sql` creates `GCIO` and the
   application login. It needs a SQL sysadmin; the application itself only ever
   touches its own tables. Schema migrations are applied at boot.
   Check the connection with `node scripts/db-check.mjs`.
3. **Build.** `npm ci && npm run build`
4. **Install the service.** From an elevated prompt:
   `.\deploy\install-service.ps1 -EnvFile C:\gcio\.env`
   It refuses to install a development configuration, waits for the service to
   answer, and is safe to re-run as the upgrade path.
5. **Put IIS in front for TLS.** Follow `deploy/iis-site.md`. Node binds
   loopback only in production, so IIS is how anyone reaches it.

### Who can do what

Roles come from directory group membership, mapped in `dbo.RoleMapping`:

| Role | May |
| --- | --- |
| Viewer | read every view, run exports, download the template |
| PM | everything a viewer may, plus upload workbooks |
| Admin | everything, plus read the audit trail |

An account in no mapped group has no access at all — there is no default role.
On a **fresh database** set `SEED_ADMIN_GROUP` so the first administrator can
get in; it installs one mapping and is ignored once any mapping exists.

Sign-in is by directory password (LDAP) and, when `SSO_ENABLED=true`, by Entra
single sign-on. Both resolve the role server-side. Sessions live in SQL, so
signing out is real and access can be withdrawn.

Every sign-in, upload, export and audit read is recorded. Administrators can
read the trail at `/api/audit`; with `STORE=mssql` it lives in `dbo.AuditEvent`,
otherwise in dated JSONL files under `AUDIT_DIR`.

### Local development

```bash
STORE=memory AUTH_MODE=dev DEV_ROLE=pm npm start
```

No SQL Server and no directory needed: the bundled sample portfolio loads, any
password is accepted, and the role comes from `DEV_ROLE`. Both switches are
refused when `NODE_ENV=production`.

### Continuous operation

The process is built to stay up: malformed workbooks are logged and skipped
rather than crashing the server, all rejections are trapped, a dead database
connection surfaces as a clean 503 and is reconnected rather than wedging the
pool, and with `STORE=memory` the store snapshots to `data/.cache.json` after
every ingest for warm restarts. `/healthz` reports liveness and `/readyz`
reports whether there is data to serve — point monitoring at `/readyz`.

## API surface (for integration)

All `/api` routes require a session except `/api/me` and `/api/auth/*`;
`/healthz` and `/readyz` are open so monitoring does not need credentials.
Role requirements are noted where they apply.

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | liveness — open |
| `GET /readyz` | readiness: is there data to serve — open, and what monitoring should watch |
| `POST /api/auth/login` | directory sign-in (`{username, password}`), throttled per IP |
| `POST /api/auth/sso` | Entra sign-in (`{idToken, nonce}`), when `SSO_ENABLED=true` |
| `POST /api/auth/logout` | end the session |
| `GET /api/me` | who is signed in, and which sign-in methods this server offers |
| `GET /api/audit?limit=&action=` | audit trail — **admin only**, and the read is itself audited |
| `GET /api/health` | project/file counts, last ingest |
| `GET /api/summary?period=daily\|weekly\|monthly\|yearly&date=YYYY-MM-DD` | full executive summary payload |
| `GET /api/projects?department=&status=&health=&q=&sort=` | filtered portfolio rows |
| `GET /api/projects/:id` | full record + chain + computed schedule/budget analytics + timeline |
| `GET /api/meta` | filter dimensions |
| `GET /api/template` | canonical blank workbook |
| `POST /api/ingest/upload` | multipart workbook upload (field `files`) — **pm or admin** |
| `POST /api/export/pptx\|xlsx\|docx\|html` | briefing exports (`{period, date, projectIds?, images?}`) |
| `GET /api/events` | server-sent events: `ingest`, `heartbeat` |

## Licence

MIT — see [LICENSE](LICENSE).

## Layout

```
server/          Express app, ingestion engine, summarizer, chain resolver
server/exporters PowerPoint / Excel / Word / HTML briefing generators
server/sections.js  the four CIO sections (successes, questions/risks/issues, priorities, roadmap)
shared/          pptx-lite.mjs — dependency-free .pptx writer shared by server and demo
client/          React dashboard (Vite) — build output in client/dist
data/            WATCHED drop-folder (your live portfolio lives here)
sample-data/     Demonstration portfolio
scripts/         Sample-data generator, PPTX layout audit, demo & briefing builders, DB setup
deploy/          Windows service installer and the IIS TLS runbook
SPEC.md          Full engineering specification
```

Configuration: set `PORT` to change the port (default 8123). Currency is AED.
