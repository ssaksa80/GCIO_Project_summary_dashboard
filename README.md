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

With no data present, the dashboard boots in **demonstration mode** using the bundled
sample portfolio (59 projects across 4 workbooks — regenerate anytime with
`npm run sample-data`).

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

## Running 24×7 on Windows

Any of the standard options work; the server is a single Node process with no
external dependencies:

- **Task Scheduler:** create a task triggered *At startup*, action
  `"C:\Program Files\nodejs\node.exe"` with arguments `server\index.js`, start-in
  this folder, "Run whether user is logged on or not", and enable *Restart on failure*.
- **NSSM / WinSW:** wrap `node server/index.js` as a Windows service.
- **PM2:** `npm i -g pm2 && pm2 start server/index.js --name gcio && pm2 save`.

The process is hardened for continuous operation: malformed workbooks are logged and
skipped (never crash), all rejections are trapped, and the store snapshots to
`data/.cache.json` after every ingest for instant warm restarts.

## API surface (for integration)

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness, project/file counts, last ingest |
| `GET /api/summary?period=daily\|weekly\|monthly\|yearly&date=YYYY-MM-DD` | full executive summary payload |
| `GET /api/projects?department=&status=&health=&q=&sort=` | filtered portfolio rows |
| `GET /api/projects/:id` | full record + chain + computed schedule/budget analytics + timeline |
| `GET /api/meta` | filter dimensions |
| `GET /api/template` | canonical blank workbook |
| `POST /api/ingest/upload` | multipart workbook upload (field `files`) |
| `POST /api/export/pptx\|xlsx\|docx\|html` | briefing exports (`{period, date, projectIds?, images?}`) |
| `GET /api/events` | server-sent events: `ingest`, `heartbeat` |

## Layout

```
server/          Express app, ingestion engine, summarizer, chain resolver
server/exporters PowerPoint / Excel / Word / HTML briefing generators
server/sections.js  the four CIO sections (successes, questions/risks/issues, priorities, roadmap)
shared/          pptx-lite.mjs — dependency-free .pptx writer shared by server and demo
client/          React dashboard (Vite) — build output in client/dist
data/            WATCHED drop-folder (your live portfolio lives here)
sample-data/     Demonstration portfolio
scripts/         Sample-data generator, PPTX layout audit, demo & briefing builders
SPEC.md          Full engineering specification
```

Configuration: set `PORT` to change the port (default 8123). Currency is AED.
