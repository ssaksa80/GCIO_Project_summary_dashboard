# GCIO Project Summary Dashboard — Engineering Specification v1.0

Enterprise-grade, 24x7 live CIO portfolio dashboard. Node.js (Express) + React (Vite) + Recharts.
Everything in this file is a CONTRACT. Do not deviate from names, paths, shapes, or tokens.

## 1. Runtime & layout

- Node >= 20, ESM everywhere (`"type": "module"`).
- Server listens on **port 8123**. Production: Express serves `client/dist` statically + API.
- File tree (fixed):

```
server/index.js            Express boot, routes, SSE, static serving
server/store.js            In-memory store + snapshot persistence (data/.cache.json)
server/ingest.js           Excel reader (SheetJS), header mapping, chokidar watcher on data/
server/summarize.js        Period rollups, KPI math, narrative engine
server/chain.js            Project hierarchy resolution (ancestors/descendants)
server/exporters/excel.js  buildExcel(payload) -> Buffer  (exceljs)
server/exporters/word.js   buildWord(payload)  -> Buffer  (docx)
server/exporters/html.js   buildHtml(payload)  -> string  (standalone HTML)
client/index.html          Vite entry
client/src/main.jsx        React mount
client/src/App.jsx         Root layout + state
client/src/themes.css      4 theme token sets (see §7)
client/src/lib/api.js      fetch helpers + SSE hook
client/src/lib/format.js   number/date/currency formatters
client/src/lib/capture.js  chart SVG -> PNG capture for exports
client/src/components/*.jsx  (see §8)
scripts/generate-sample-data.js  Sample portfolio generator
data/                      WATCHED drop-folder for live ingestion
sample-data/               Generated demo workbooks
```

## 2. Canonical Project object (normalized, server-side)

```js
{
  id: "PRJ-0001",              // string, unique, uppercased
  name: "...", description: "...",
  department: "...",            // business unit
  pillar: "...",                // strategic pillar
  program: "...",               // program grouping (may be "")
  parentId: "PRJ-0000" | null,  // hierarchy chain
  owner: "...",                 // project manager
  sponsor: "...",               // executive sponsor
  vendor: "...",
  status: "Proposed"|"Approved"|"In Progress"|"On Hold"|"Completed"|"Cancelled",
  health: "Green"|"Amber"|"Red",
  priority: "Critical"|"High"|"Medium"|"Low",
  phase: "Initiation"|"Planning"|"Execution"|"Monitoring"|"Closure",
  approvalDate: "2025-03-10"|null,   // all dates ISO yyyy-mm-dd or null
  startDate, targetEndDate, actualEndDate,
  budget: 1200000, spent: 480000, currency: "AED",
  percentComplete: 0..100,
  milestones: [{ name, dueDate, completedDate|null, status: "Pending"|"In Progress"|"Completed"|"Overdue" }],
  updates:    [{ date, author, text }],
  risks:      [{ title, severity: "Low"|"Medium"|"High"|"Critical", status: "Open"|"Mitigating"|"Closed", owner }],
  lastUpdated: "2026-08-20", sourceFile: "portfolio_master.xlsx"
}
```

## 3. Excel ingestion (server/ingest.js)

- Use SheetJS (`import * as XLSX from "xlsx"`) with `{cellDates:true}`. Accept `.xlsx .xlsm .xls .csv`.
- Sheets: a sheet whose header row matches project columns = projects sheet (usually "Projects" or the first sheet).
  Optional sheets by name (case-insensitive): "Milestones", "Updates", "Risks" — joined by Project ID.
- Header matching is TOLERANT: trim, lowercase, strip non-alphanumerics, then map via synonyms:
  - id: projectid|id|prjid|projectcode|code — name: projectname|name|title
  - department: department|dept|businessunit|bu|division — pillar: strategicpillar|pillar|strategictheme|theme
  - program: program|programme|portfolio — parentId: parentprojectid|parentid|parent|parentproject
  - owner: owner|projectmanager|pm|projectowner|manager — sponsor: sponsor|executivesponsor|execsponsor
  - vendor: vendor|supplier|partner — status: status|projectstatus
  - health: health|rag|ragstatus|healthstatus|overallhealth — priority: priority|criticality
  - phase: phase|projectphase|currentphase
  - approvalDate: approvaldate|approvedon|dateapproved|approved
  - startDate: startdate|start|kickoffdate — targetEndDate: targetenddate|enddate|targetdate|plannedend|duedate|targetcompletion
  - actualEndDate: actualenddate|actualend|completiondate|completedon|dateclosed
  - budget: budget|budgetaed|approvedbudget|totalbudget — spent: spent|actualspend|spenttodate|actuals|consumed
  - percentComplete: percentcomplete|complete|completion|progress|pctcomplete
  - description: description|summary|scope|objective — lastUpdated: lastupdated|updatedon|lastmodified
- Value normalization: dates via dayjs (accept Date objects, dd/mm/yyyy, yyyy-mm-dd, Excel serials);
  health synonyms (G/A/R, on track->Green, at risk->Amber, off track/critical->Red);
  status synonyms (active/ongoing/wip->In Progress, done/closed->Completed, pending approval->Proposed);
  money: strip currency symbols/commas; percent: accept 0-1 or 0-100 (if <=1 treat as fraction).
- Rows with no id AND no name are skipped. Missing id -> derive stable slug "PRJ-" + hash of name.
- Duplicate id across files: later `lastUpdated` (fallback: later file mtime) wins; merge child arrays (dedupe by name+date).
- `ingestFile(path)` and `ingestBuffer(buf, filename)` both exported. Errors NEVER crash the server:
  return `{ok:false, file, error}` and continue; store keeps an `ingestLog` (last 50 entries).
- chokidar watches `data/` (add/change/unlink, awaitWriteFinish 500ms). unlink removes that file's projects. After any batch, recompute + emit SSE `ingest`.
- On boot: ingest every workbook already in `data/`; if store empty and `sample-data/` has files, ingest those (flag `demoMode:true`).

## 4. API contract (all JSON unless noted)

- `GET /api/health` -> `{status:"ok", uptimeSec, projectCount, fileCount, lastIngestAt, demoMode, version:"1.0.0"}`
- `GET /api/meta` -> `{departments:[], pillars:[], owners:[], sponsors:[], statuses:[], currency:"AED", asOf}`
- `GET /api/summary?period=daily|weekly|monthly|yearly&date=YYYY-MM-DD` (date optional, default today) -> §5 shape.
- `GET /api/projects?department=&pillar=&status=&health=&q=&sort=` -> `{count, projects:[ROW]}` where ROW = project minus milestones/updates/risks plus `{overdue:bool, daysToTarget:int|null, budgetUtilization:0..N}`.
- `GET /api/projects/:id` -> `{project, chain:{ancestors:[mini], children:[tree]}, computed:{scheduleStatus:"On Track"|"At Risk"|"Overdue"|"Completed", daysRemaining, durationDays, elapsedPct, budgetUtilizationPct, forecastEnd, openRisks, overdueMilestones}, timeline:[{date, type:"approval"|"start"|"milestone"|"update"|"completion", label, detail}] sorted asc}`.
  mini = `{id,name,status,health,percentComplete}`; children tree nodes = mini + `children:[]` (max depth 6, cycle-safe).
- `GET /api/template` -> downloads a blank canonical .xlsx template (Projects/Milestones/Updates/Risks sheets, styled header row).
- `POST /api/ingest/upload` multipart field `files` (1..20 workbooks) -> `{ok, ingested:[{file, projects}], errors:[]}`. Save uploads into `data/` (sanitized filename; write with `.uploading` suffix then rename so the watcher does not double-process).
- `POST /api/export/:format` format = xlsx|docx|html. Body: `{period, date, projectIds?: [], theme?: string, images?: [{id, dataUrl}]}` (images = client-captured chart PNGs, embed when given).
  Server recomputes summary; responds binary with correct Content-Type + Content-Disposition
  `GCIO_Portfolio_Brief_<period>_<date>.<ext>`. html format returns text/html.
- `GET /api/events` -> SSE (`Content-Type: text/event-stream`). Events: `ingest` `{files, projectCount, at}`, `heartbeat` every 30s. Set headers to disable buffering; clean up on close.
- Errors: JSON `{error: "message"}` with 400/404/500. Global express error handler; server must NEVER exit on bad input (24x7).

## 5. Summary payload (server/summarize.js)

Period windows (dayjs): daily = that day; weekly = ISO week Mon-Sun containing date; monthly = calendar month; yearly = calendar year.

```js
{
  period, date, rangeStart, rangeEnd, generatedAt, currency: "AED",
  kpis: {
    totalProjects, active,            // active = Approved|In Progress|On Hold
    completedInPeriod, approvedInPeriod, startedInPeriod,
    onHold, overdue,                  // overdue: targetEnd < today && !Completed/Cancelled
    milestonesDueInPeriod, milestonesOverdue,
    budgetTotal, spentTotal, budgetUtilizationPct,   // spent/budget*100 (1dp)
    avgCompletion,                    // mean percentComplete of active (1dp)
    health: {green, amber, red}, openRisks, criticalRisks
  },
  narrative: { headline, bullets:[string], wins:[string], risks:[string], outlook: string },
  charts: {
    statusBreakdown:    [{label, value}],                       // fixed status order from §2
    healthByDepartment: [{department, green, amber, red}],      // sorted red desc
    budgetByDepartment: [{department, budget, spent}],          // sorted budget desc, top 8 + "Other"
    completionTrend:    [{bucket, completed, approved, started}], // daily: last 14 days · weekly: 12 wks · monthly: 12 mo · yearly: that year by month; bucket = short label
    spendByPillar:      [{pillar, spent, budget}],
    topProjects:        [{id, name, department, budget, spent, percentComplete, health, targetEndDate}] // top 10 by budget among active
  },
  attention: [{id, name, reason, severity:"critical"|"serious"|"warning"}]  // max 8: Red health, overdue, budget>100%, critical open risks
}
```

Narrative engine = deterministic rules, C-suite tone, numbers always formatted (AED 12.4M). Examples:
headline: "Portfolio of 54 projects (41 active) is 72% healthy; AED 386M committed with 61% consumed."
bullets cover: period completions/approvals by name (<=3 each), health shifts, overdue milestones count, top budget overruns, department with weakest health. wins/risks = named projects. outlook = 1-2 sentences on next period (upcoming milestones, projects due).
Money format helper: >=1e9 "AED 1.24B", >=1e6 "AED 386M" (1dp), >=1e3 "AED 250K", else integer.

## 6. Exporters — signatures fixed

Each receives the SAME payload: `{summary, projects, detailProjects, meta, images, theme, generatedBy:"GCIO Project Intelligence", asOf}`
(projects = ROW list in scope; detailProjects = full objects when projectIds requested, else attention + topProjects, max 10).
- excel.js `buildExcel(payload)->Promise<Buffer>`: exceljs. Sheets: "Executive Summary" (title block, KPI grid with styled cells, narrative), "Portfolio" (frozen header, autofilter, RAG conditional fills, AED number formats, column widths), "Attention Items", "Projects Detail" (one section per detail project incl milestones), optional "Charts" sheet embedding provided PNG images. Brand styling: dark header rows #101828, white bold text, health fills Green #dcefdc / Amber #fdf0d3 / Red #f6dada with dark ink.
- word.js `buildWord(payload)->Promise<Buffer>`: docx lib. Cover page (title, period, date, confidential footer), Executive Summary heading + narrative, KPI table (2-col grid), Attention table, per-project brief pages (H2 name, meta table: owner/sponsor/dates/budget, milestone table, latest update), embedded chart images when provided (ImageRun, width ~600px). Styles: headings navy #101828, accent rule gold #b08d3e, body 11pt.
- html.js `buildHtml(payload)->string`: single self-contained document, inline CSS only, print-friendly A4, same content as word + embedded images (data URLs). Elegant executive styling (ivory page, navy ink, gold hairlines). No external requests.

## 7. Design system (client/src/themes.css)

Base font: Inter Variable (`@fontsource-variable/inter`), display headings: Fraunces Variable (`@fontsource-variable/fraunces`) — imported in main.jsx. Charts/text inside charts use Inter/system only.
Theme applied as `data-theme="<key>"` on `<html>`. Tokens (CSS custom properties) — every theme defines ALL of:
`--page --surface --card --card2 --ink --ink-2 --muted --hairline --accent --accent-2 --good --warn --serious --critical --chart-surface --shadow`

| token | obsidian (default, dark) | platinum (light) | sapphire (dark) | emerald (dark) |
|---|---|---|---|---|
| --page      | #0a0c10 | #f7f6f2 | #081124 | #0e1211 |
| --surface   | #12151c | #fcfcfb | #0d1830 | #151b19 |
| --card      | #161a23 | #ffffff | #122040 | #1a211f |
| --card2     | #1b2029 | #f3f2ed | #16264a | #202826 |
| --ink       | #f2f4f8 | #14120e | #eef2fb | #eef4f1 |
| --ink-2     | #b6bdc9 | #5a574f | #a9b6d6 | #a8b5af |
| --muted     | #7e8695 | #898781 | #7487ad | #75837c |
| --hairline  | rgba(255,255,255,.08) | rgba(11,11,11,.09) | rgba(255,255,255,.10) | rgba(255,255,255,.08) |
| --accent    | #4f8ff7 | #1c5cab | #d4af5a | #2bd48f |
| --accent-2  | #8b7bff | #b08d3e | #3987e5 | #7cc5ff |
| --chart-surface | #161a23 | #fcfcfb | #122040 | #1a211f |

Status tokens (all themes, fixed hexes): --good #0ca30c, --warn #fab219, --serious #ec835a, --critical #d03b3b (icon + text label ALWAYS accompany status color, never color alone).
Chart series palette (fixed order, never cycled) — dark themes: 1 #3987e5, 2 #d95926, 3 #199e70, 4 #c98500, 5 #d55181, 6 #008300, 7 #9085e9, 8 #e66767. platinum: 1 #2a78d6, 2 #eb6834, 3 #1baf7a, 4 #eda100, 5 #e87ba4, 6 #008300, 7 #4a3aa7, 8 #e34948. Expose as `--series-1..8` per theme.
Chart chrome — gridlines: `color-mix(in srgb, var(--ink) 10%, transparent)`, axis text var(--muted) 11px, tooltips on var(--card2) with hairline border + 8px radius.
RAG mapping: Green->--good, Amber->--warn, Red->--critical everywhere.

Dataviz rules (MANDATORY): one y-axis per chart (never dual-axis); bars thin with 4px rounded data-end only; lines 2px; 2px gaps between stacked segments (Recharts: stroke=var(--chart-surface), strokeWidth=2); legend whenever >=2 series; direct labels selective, never every point; text in ink tokens never series colors; sequential = blue ramp only; donut allowed for statusBreakdown (55% inner radius, center total).

Aesthetic: "quiet luxury" executive. Generous whitespace, 12px card radius, hairline borders, subtle shadows (--shadow), NO gradients on data marks (a subtle aurora glow on the page background is allowed at <8% opacity), uppercase 11px letterspaced .08em section labels in --muted, hero numbers 28-34px font-weight 620 tabular-nums.

## 8. Frontend components (client/src/components/)

- `TopBar.jsx` — brand "GCIO · Project Intelligence" (Fraunces), period tabs (Daily/Weekly/Monthly/Yearly), date picker (native input, styled), LIVE indicator (pulsing dot, shows lastIngestAt, SSE-driven), theme switcher (4 swatch buttons), Export menu (Excel/Word/HTML -> POST /api/export, downloads blob; captures chart PNGs first via lib/capture.js), Upload button.
- `KpiRow.jsx` — 6 stat tiles: Active Projects, Portfolio Health % (green share), Budget vs Spent (AED, utilization bar), Completed (period), Overdue, Open Risks. Tile = label (uppercase micro), hero number, delta/subtext.
- `NarrativePanel.jsx` — "Executive Briefing": headline sentence large (Fraunces 20px), bullets, Wins / Watch-list two-column, outlook line. This is the CIO summary.
- `ChartsGrid.jsx` — 2x2: StatusDonut, CompletionTrend (line/area), BudgetByDepartment (grouped thin bars), HealthByDepartment (stacked horizontal RAG bars). Recharts, ResponsiveContainer, custom tooltips on --card2. Each chart wrapper carries `data-export-chart="<id>"`.
- `AttentionList.jsx` — "Needs Executive Attention" rows: severity icon+chip, project name (click -> drawer), reason.
- `ProjectTable.jsx` — sortable, filter row above (department, status, health selects + search input), RAG chips, budget utilization mini-bar, % complete mini-bar, click row -> ProjectDrawer.
- `ProjectDrawer.jsx` — slide-over (560px) full drill-down: header (name, chips), meta grid (owner, sponsor, department, pillar, vendor, approval/start/target/actual dates, budget/spent with utilization bar, phase, priority), CHAIN section (ancestors breadcrumb -> this -> children tree, each node clickable to navigate), milestone timeline (vertical, done/pending/overdue icons), risks table, updates feed, computed panel (schedule status, days remaining, forecast). Export-this-project buttons (docx/html/xlsx with projectIds=[id]).
- `UploadPanel.jsx` — modal: drag-drop or browse multiple .xls/.xlsx/.csv, per-file result list, link to `GET /api/template`.
- `EmptyState.jsx` — when no data: elegant onboarding card ("Drop workbooks into /data or upload").
- App state: `{period, date, theme, summary, meta, drawerId}`; refetch summary on period/date change AND on SSE `ingest`; persist theme in localStorage.
- lib/capture.js — `captureCharts()` finds `[data-export-chart]` SVG nodes, serializes -> canvas @2x -> PNG dataURLs `[{id, dataUrl}]`.

## 9. Sample data generator (scripts/generate-sample-data.js)

Seeded RNG (mulberry32, seed 20260823) — deterministic output. Realistic GCIO healthcare/enterprise IT portfolio, "as of" 2026-08-23:
- `sample-data/GCIO_Portfolio_Master.xlsx` (exceljs, styled headers): 34 projects + Milestones + Updates + Risks sheets.
- `sample-data/Dept_DigitalHealth.xlsx` (10), `sample-data/Dept_Cybersecurity.xlsx` (8), `sample-data/Dept_Infrastructure.xls` (7, legacy BIFF8 via SheetJS write, projects sheet only) — bulk-ingestion demo, different header spellings per file (PM vs Project Manager, RAG vs Health) to prove tolerant mapping.
- Content: departments [Digital Health, Cybersecurity, Cloud & Infrastructure, Data & AI, ERP & Corporate Systems, Patient Experience, Network & Telecom]; pillars [Digital Transformation, Operational Excellence, Patient-Centric Care, Intelligent Enterprise, Resilience & Security]; 4 programs each with parent project + 3-6 children (chain demo); owners/sponsors Emirati + international names; budgets AED 0.4M-45M; statuses ~55% In Progress, 15% Completed (several completing Aug 2026 so daily/weekly views populate), 10% Approved (some approved this week), rest Proposed/On Hold/Cancelled; health ~60/25/15 G/A/R; every project 3-6 milestones, 2-5 updates (some dated 2026-08-20..23), 0-4 risks. Dates span 2024-01 .. 2027-06.
- Run: `node scripts/generate-sample-data.js` prints a manifest table.

## 10. Quality bar

- Zero unhandled rejections; try/catch on every ingest/export path; server logs concise single-line events.
- All user-visible numbers formatted (AED compact, %, dates "12 Mar 2026").
- Empty/partial data never crashes UI (defensive defaults, EmptyState).
- No TODO comments, no dead code, no console noise in client (console.error allowed on fetch failure).
- JSDoc on every exported function. Small pure functions. No global mutable state outside store.js.
