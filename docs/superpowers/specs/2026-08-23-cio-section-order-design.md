# GCIO dashboard — CIO section order

**Date:** 2026-08-23
**Status:** implemented

## Requirement

The CIO reads the portfolio in a fixed sequence. The dashboard, and every
artefact it produces, must present that sequence and nothing before it:

1. **Successes**
2. **Questions, Risks & Issues**
3. **Priorities**
4. **Roadmap / Planned Projects**

## Decisions taken

| Question | Decision |
| --- | --- |
| Where do "Questions" come from? | Both: an optional `Questions` sheet (or an `Open Question` column) in the workbook, plus questions derived from portfolio state. Derived ones are labelled so the CIO can tell them apart. |
| How much of the old layout survives? | A slim KPI strip stays pinned above section 1. Charts and the project table fold into the relevant sections; the full table becomes a collapsed reference block at the end. |
| Do exports follow? | Yes — Word, Excel, HTML and the new PowerPoint deck all follow the same four-part order. |
| Brand | Themes rebuilt on the mandated palette: 40% Pantone 281 C, 40% 354 C, 15% 375 C, 5% secondaries. Arial is the default interface font, Aptos a switch. |

## Architecture

### Server

- **`server/sections.js`** (new) — pure builders, one per section, over the
  store's projects. All ranking is deterministic and explainable:
  - `buildSuccesses` — completions in window, milestones closed, ≥90% projects,
    projects meaningfully ahead of their burn line, budget returned.
  - `buildQRI` — questions (workbook-authored first, then derived), open risks
    ranked by severity, and issues that have already materialised.
  - `buildPriorities` — urgency score as a visible sum: priority weight +
    health + schedule slip + risk + overrun + hold + dependency count. Each row
    carries `why` (the components) and `ask` (what the CIO must decide).
  - `buildRoadmap` — in-flight forecast lanes, planned pipeline with a
    readiness flag, upcoming milestones, committed spend per pillar.
- **`server/ingest.js`** — reads a `Questions` / `Decisions` sheet
  (`Project ID, Question, Asked By, Raised, Needed By, Decision Owner, Status`)
  and an inline `Open Question` column.
- **`server/summarize.js`** — exposes the four sections at `summary.sections`.
  KPIs, charts and the legacy narrative are untouched.
- **`shared/pptx-lite.mjs`** (new) — dependency-free OOXML + store-only ZIP
  writer. Runs in Node (server export) and in the browser (demo file).
- **`server/exporters/pptx.js`** (new) — six-slide deck in section order.
- Word, Excel and HTML exporters re-cut to the same order. Excel gains one
  sheet per section (`1 Successes`, `2 Questions Risks Issues`, `3 Priorities`,
  `4 Roadmap`), replacing the old Attention sheet.

### Client

- `App.jsx` — TopBar → KPI strip → sticky section nav → the four sections →
  collapsed all-projects table.
- One component per section, plus `KpiStrip`, `SectionNav`, and `charts.jsx`
  (charts distributed into the sections that need them).
- `lib/motion.jsx` — GSAP layer: reveal-on-scroll stagger, count-up numbers,
  bar growth, live-ingest pulse, scroll spy. Every effect degrades to the
  correct final state under `prefers-reduced-motion`.
- `themes.css` — four identities, all derived from the brand palette.
- URL controls for deterministic views: `?snapshot=1` (non-live render),
  `?theme=`, `?font=`, `?project=`, `?table=1`.

## Constraints that shaped the code

- **Charts:** `getComputedStyle` returns custom properties unresolved, and
  Recharts writes colours into SVG presentation attributes where `var()` is
  meaningless — the token reader follows the chain to a literal colour. Recharts'
  own entry animation is disabled so captures and prints are never half-drawn.
- **Counts vs lists:** section counts describe the whole portfolio; the lists
  are the top slice, and the UI says so.
- **Never invent urgency:** derived questions state the evidence that produced
  them; a project at 7% complete is not reported as "ahead of plan".

## PowerPoint layout

PowerPoint wraps text at render time, so the writer has to predict height before
placing the next row — the first version advanced by a fixed row height and
produced overlapping sentences. The writer now measures each run (Arial metrics,
deliberately over-counting), advances by the measured height, and spills what
does not fit onto a `(cont.)` slide. Tag pills are measured with an uppercase
metric and drawn no-wrap; long money values in KPI tiles step down a size.

`scripts/pptx-audit.mjs <file.pptx>` re-opens a finished deck, re-measures every
text shape, and reports OVERFLOW (text needs more room than its box) and
COLLISION (two text boxes overlap). It exits non-zero, so it can gate a build.

## Verification performed

- `npm run build` green; server boots and ingests the 59-project sample set.
- All four sections render in order against live data (headless capture).
- `POST /api/export/{pptx,xlsx,docx,html}` all return 200 with correct MIME
  types; the deck opens in PowerPoint (6 slides, 16:9), the workbook in Excel
  (7 sheets in section order), the document in Word (7 pages, headings ordered).
- The standalone demo builds its PowerPoint in-browser; the resulting file was
  extracted and opened in PowerPoint (6 slides), and audits clean.
- `pptx-audit` on the pre-fix deck reported 15 collisions; the current deck
  reports 0 across daily, weekly, monthly and yearly.
- Theme screenshots re-shot from the running app for the CIO briefing, which is
  rebuilt by `scripts/build-briefing.mjs`.
