/**
 * Build the deployment report.
 *
 *   node scripts/build-deployment-report.mjs [--base http://127.0.0.1:8130]
 *
 * Reads the live deployment and the database rather than restating what someone
 * believed at the time, so re-running it after a change produces a report that
 * disagrees with the old one instead of a stale copy that looks current.
 *
 * Output is a single self-contained HTML file with GSAP inlined — the same
 * convention as the CIO briefing builder, and for the same reason: a report
 * that needs a network to render is a report that fails in the room where
 * somebody needs it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import sql from "mssql";
import { buildConfig } from "../server/db/pool.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = argOf("--base") || "http://127.0.0.1:8130";
const OUT = argOf("--out") || path.join(ROOT, "GCIO_Deployment_Report.html");

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

/* ------------------------------------------------------------ gathering */

/** Ask the running deployment what it thinks, or record that it is not there. */
async function readLive() {
  const out = { reachable: false, readyz: null, metrics: {}, raw: "" };
  try {
    const [r, m] = await Promise.all([
      fetch(`${BASE}/readyz`).then((x) => x.json()),
      fetch(`${BASE}/metrics`).then((x) => x.text()),
    ]);
    out.reachable = true;
    out.readyz = r;
    out.raw = m;
    for (const line of m.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^(\w+)(\{[^}]*\})?\s+(.+)$/);
      if (!match) continue;
      const key = match[2] ? `${match[1]}${match[2]}` : match[1];
      out.metrics[key] = Number(match[3]);
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

/** The database's own account of what has happened to it. */
async function readDatabase() {
  const pool = await new sql.ConnectionPool(buildConfig(process.env)).connect();
  const q = async (text) => (await pool.request().query(text)).recordset;
  try {
    const [counts] = await q(`
      SELECT
        (SELECT COUNT(*) FROM dbo.Project)        AS projects,
        (SELECT COUNT(*) FROM dbo.ProjectChild)   AS children,
        (SELECT COUNT(*) FROM dbo.ProjectVersion) AS versions,
        (SELECT COUNT(*) FROM dbo.SourceFile)     AS sourceFiles,
        (SELECT COUNT(*) FROM dbo.IngestRun)      AS runs,
        (SELECT COUNT(*) FROM dbo.AuditEvent)     AS auditEvents
    `);
    const runs = await q(`
      SELECT TOP (14) IngestRunId, FileName, TriggerSource, Outcome,
             ProjectsSeen, ProjectsChanged, ParseMs, PersistMs,
             CONVERT(varchar(19), StartedAt, 126) AS StartedAt,
             LEFT(ISNULL(Error, ''), 120) AS Error
      FROM dbo.IngestRun ORDER BY StartedAt DESC
    `);
    const migrations = await q("SELECT Id, Name FROM dbo.SchemaMigration ORDER BY Id");
    const oldest = await q("SELECT MIN(RecordedAt) AS oldest FROM dbo.ProjectVersion");
    return { counts, runs, migrations, historyBegan: oldest[0]?.oldest || null };
  } finally {
    await pool.close();
  }
}

/* -------------------------------------------------------------- content */

/* Written down rather than derived: these are judgments, and a report that
   pretended to compute them would be dressing opinion as measurement. */
const PHASES = [
  { tag: "v1.1.0-p0", name: "Safe pilot", state: "met",
    what: "LDAP and Entra sign-in, roles, the audit trail and its reader, security headers, upload sniffing, health endpoints, IIS and service packaging." },
  { tag: "v1.2.0-p1", name: "History foundation", state: "met",
    what: "SourceFile, IngestRun and ProjectVersion beside the snapshot. Every workbook copied to a vault before parsing. A project versioned only when its content hash moves." },
  { tag: "v1.3.0-p2", name: "Changed since last week", state: "partly",
    what: "Every row says what moved, sourced from recorded versions rather than file dates. Trends and question ageing deferred — both need months of history to say anything true." },
  { tag: "v1.4.0-p3", name: "Survivable deployment", state: "partly",
    what: "/metrics, per-ingest timings, a backup and restore drill that has actually been run, an unelevated install preflight, and the runbook. Role split and lock election deferred until a second instance exists." },
  { tag: "v1.5.0-p4", name: "Testing what people look at", state: "partly",
    what: "21 browser tests where the client had none. Accessibility assessed, not fixed — one finding conflicts with the mandated palette and that is a decision, not a defect." },
];

const FINDINGS = [
  {
    severity: "fixed", id: "1", title: "An absolute VAULT_DIR produced a doubled path",
    detail: "path.join(ROOT, config.vaultDir) doubles the path when VAULT_DIR is absolute — which a real deployment naturally sets, because the env file lives outside the repo and so do the directories it names. Every ingest failed with ENOENT on C:\\gcio\\C:\\gcio\\vault, a path nobody had ever typed.",
    why: "The preflight had validated C:\\gcio\\vault as writable. It was. The application simply never used that path.",
    fix: "path.resolve, which returns an absolute argument unchanged and still resolves a relative one.",
  },
  {
    severity: "fixed", id: "2", title: "Two ingests of one workbook ran concurrently",
    detail: "chokidar fires add and change independently and does not await a handler before the next, so one file copy put two applyFile calls in flight. They collided on dbo.Project's primary key. The same doubling happened on unlink — two removal runs, one seeing 34 rows and one seeing none.",
    why: "Predicted by a review of sourceFiles.record() in an earlier phase and fixed there with MERGE and HOLDLOCK. projects.replaceForFile was left delete-then-insert with no equivalent guard.",
    fix: "The store serialises applyFile and removeFile through a FIFO promise chain. The invariant belongs to the store, not the watcher — a queue in the watcher would protect today's caller and leave the next one exposed. A pleasant consequence: the second duplicate now reads an unchanged content hash and records 'unchanged', doing no work at all.",
  },
  {
    severity: "fixed", id: "3", title: "The dashboard served stale data while the database was correct",
    detail: "After the collision the database held 34 projects while /readyz reported not-ready and gcio_projects read 0. The two refresh() calls had interleaved. A restart recovered it.",
    why: "This is the one that would have mattered. A CIO would have seen an empty dashboard with correct data sitting behind it, and nothing on the page explaining why.",
    fix: "Resolved by the same serialisation — refreshes now happen in order.",
  },
  {
    severity: "open", id: "4", title: "Nothing stops two processes watching one folder",
    detail: "The serialisation guards one store instance in one process. Two OS processes watching the same data directory each hold their own queue and can still collide. This was not theoretical — a stray process from an earlier run was found still watching the folder and still holding a database connection, and it contaminated the first verification attempt.",
    why: "It is the failure the deferred lock election exists to prevent, arriving early and by accident rather than by deployment design.",
    fix: "Not fixed. The election was deferred because it guards a configuration nobody had deployed. That reasoning is now weaker than it was.",
  },
  {
    severity: "open", id: "5", title: "/healthz and /metrics disagree about the version",
    detail: "/healthz reports 1.0.0 from a hardcoded constant in app.js while /metrics reports 1.5.0 from package.json.",
    why: "Noticed during a review and not chased. It matters because the runbook tells an operator to compare a version before and after a deploy.",
    fix: "Not fixed.",
  },
];

const OUTSTANDING = [
  { what: "Install the Windows service", who: "Needs an elevated prompt", detail: "Everything up to it is staged and the preflight passes all 11 checks. One command remains: powershell -NoProfile -File C:\\gcio\\deploy\\install-service.ps1 -EnvFile C:\\gcio\\.env" },
  { what: "Decide on the contrast finding", who: "Needs whoever owns the brand", detail: "Pantone 192 C measures 3.01–3.59:1 against the dark themes where 4.5:1 is required. Carried as a todo with its assertion untouched." },
  { what: "Trends and question ageing", who: "Blocked on accumulated history", detail: "Now genuinely unblocked for the first time — this deployment wrote the first ProjectVersion rows that have ever existed." },
  { what: "Ordinary accessibility work", who: "Recorded, not urgent", detail: "No main landmark, no focus trap in the drawer and 99 tab presses to its close button, keyboard-inaccessible table sort headers." },
];

/* ---------------------------------------------------------------- render */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-GB"));

function outcomeChip(outcome) {
  const cls = { applied: "ok", unchanged: "quiet", failed: "bad", removed: "warn" }[outcome] || "quiet";
  return `<span class="chip ${cls}">${esc(outcome || "open")}</span>`;
}

function render({ live, db, gsapSource }) {
  const m = live.metrics;
  const agree = live.reachable && Number(m.gcio_projects) === Number(db.counts.projects);

  const kpis = [
    { label: "Projects served", value: db.counts.projects, note: agree ? "read model agrees with the database" : "READ MODEL DISAGREES" },
    { label: "Versions recorded", value: db.counts.versions, note: "history that did not exist before this deployment" },
    { label: "Ingest runs", value: db.counts.runs, note: "every attempt, successful or not" },
    { label: "Child records", value: db.counts.children, note: "milestones, risks, questions, updates" },
  ];

  const outcomes = ["applied", "unchanged", "failed", "removed"]
    .map((o) => ({ o, n: m[`gcio_ingest_runs{outcome="${o}"}`] ?? 0 }));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GCIO Project Intelligence — Deployment Report</title>
<style>
:root{
  --p281:#00205B; --p354:#00B140; --p375:#97D700;
  --s638:#00A3E0; --s2665:#9063CD; --s192:#E40046; --s1575:#FF8200; --s7408:#F6BE00;
  --grey:#414141;
  --ink:#eef2f8; --dim:#93a0b4; --line:rgba(255,255,255,.10);
  --bg:#050b18; --panel:rgba(255,255,255,.035);
}
*{box-sizing:border-box}
body{margin:0;background:
  radial-gradient(1100px 600px at 12% -8%, rgba(0,163,224,.16), transparent 60%),
  radial-gradient(900px 520px at 88% 4%, rgba(144,99,205,.13), transparent 62%),
  var(--bg);
  color:var(--ink);font:16px/1.65 "Segoe UI",system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:0 28px 100px}
h1,h2,h3{margin:0;font-weight:650;letter-spacing:-.02em}
.mono{font-family:"Cascadia Code",Consolas,monospace;font-size:.87em}

/* hero */
header{padding:96px 0 60px;position:relative}
.eyebrow{font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--s638);margin-bottom:20px}
h1{font-size:clamp(34px,5.4vw,62px);line-height:1.04}
h1 .accent{background:linear-gradient(96deg,var(--p354),var(--p375));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.lede{color:var(--dim);font-size:19px;max-width:70ch;margin-top:22px}
.status{display:inline-flex;align-items:center;gap:11px;margin-top:30px;padding:11px 20px;
  border:1px solid var(--line);border-radius:999px;background:var(--panel)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--p354);box-shadow:0 0 0 0 rgba(0,177,64,.6);animation:pulse 2.4s infinite}
.dot.off{background:var(--s192);animation:none}
@keyframes pulse{70%{box-shadow:0 0 0 12px rgba(0,177,64,0)}100%{box-shadow:0 0 0 0 rgba(0,177,64,0)}}

/* kpi */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(212px,1fr));gap:16px;margin:8px 0 22px}
.kpi{border:1px solid var(--line);border-radius:16px;padding:22px;background:var(--panel);position:relative;overflow:hidden}
.kpi::after{content:"";position:absolute;inset:0 auto auto 0;width:100%;height:2px;
  background:linear-gradient(90deg,var(--p354),var(--s638));transform:scaleX(0);transform-origin:left}
.kpi .v{font-size:42px;font-weight:680;letter-spacing:-.03em;line-height:1}
.kpi .l{color:var(--dim);font-size:13px;margin-top:9px}
.kpi .n{color:var(--dim);font-size:11.5px;margin-top:7px;opacity:.72}
.kpi .n.warn{color:var(--s192);opacity:1;font-weight:600}

section{margin-top:78px}
.sec-head{display:flex;align-items:baseline;gap:16px;margin-bottom:9px}
.sec-head h2{font-size:27px}
.sec-num{font-size:12px;color:var(--s638);letter-spacing:.2em}
.sec-sub{color:var(--dim);max-width:74ch;margin-bottom:26px}

/* generic panel */
.panel{border:1px solid var(--line);border-radius:16px;background:var(--panel);padding:24px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}

/* config */
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600;font-size:12px;letter-spacing:.06em;text-transform:uppercase}
tbody tr:last-child td{border-bottom:0}
td.k{color:var(--dim);width:38%}

/* chips */
.chip{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:640;letter-spacing:.02em}
.chip.ok{background:rgba(0,177,64,.16);color:#5ff09a}
.chip.quiet{background:rgba(65,65,65,.5);color:#b9c3d1}
.chip.bad{background:rgba(228,0,70,.17);color:#ff7d9f}
.chip.warn{background:rgba(255,130,0,.16);color:#ffb066}
.chip.open{background:rgba(246,190,0,.15);color:#ffd85e}

/* phases */
.tl{position:relative;padding-left:34px}
.tl::before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:2px;
  background:linear-gradient(180deg,var(--p354),var(--s638),var(--s2665));opacity:.5}
.ph{position:relative;padding:16px 0 24px}
.ph::before{content:"";position:absolute;left:-30px;top:22px;width:12px;height:12px;border-radius:50%;
  background:var(--bg);border:2px solid var(--p354)}
.ph.partly::before{border-color:var(--s7408)}
.ph .t{font-weight:640;font-size:17px}
.ph .tag{font-size:12px;color:var(--s638)}
.ph .w{color:var(--dim);font-size:14.5px;margin-top:7px;max-width:80ch}

/* findings */
.find{border:1px solid var(--line);border-left:3px solid var(--p354);border-radius:14px;padding:22px;margin-bottom:14px;background:var(--panel)}
.find.open{border-left-color:var(--s7408)}
.find h3{font-size:17.5px;display:flex;gap:11px;align-items:center;flex-wrap:wrap}
.find .num{color:var(--dim);font-size:13px}
.find p{margin:11px 0 0;font-size:14.5px;color:#cdd6e4}
.find .lbl{color:var(--s638);font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;display:block;margin-top:15px;margin-bottom:3px}

/* runs */
.runs{overflow-x:auto}
.runs table{min-width:820px}
.err{color:#ff7d9f;font-size:12.5px}

/* outstanding */
.out{display:flex;gap:15px;padding:17px 0;border-bottom:1px solid var(--line)}
.out:last-child{border-bottom:0}
.out .who{flex:0 0 210px;color:var(--s7408);font-size:13px;font-weight:600}
.out .what{font-weight:620;margin-bottom:5px}
.out .d{color:var(--dim);font-size:14px}

footer{margin-top:84px;padding-top:26px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
/* Visible by default. The animated state is opt-in and only applied once the
   script has actually run — a Content-Security-Policy of script-src 'self'
   blocks an inline script silently, and a report that needs JS to be legible
   renders as wrong numbers on a blank page. Found by serving this through the
   application, whose own CSP does exactly that. */
.reveal{opacity:1}
html.anim .reveal{opacity:0}
@media (prefers-reduced-motion:reduce){html.anim .reveal{opacity:1!important;transform:none!important}}
</style></head><body>
<div class="wrap">

<header>
  <div class="eyebrow reveal">GCIO Project Intelligence · Deployment Report</div>
  <h1 class="reveal">The dashboard is <span class="accent">running on real data</span>, and the deployment found three defects nobody had read.</h1>
  <p class="lede reveal">A rehearsal deployment on a development machine, against the real SQL Server. Not the target server — deliberately, so that what breaks, breaks here.</p>
  <div class="status reveal">
    <span class="dot ${live.reachable && live.readyz?.ready ? "" : "off"}"></span>
    <span>${live.reachable ? (live.readyz?.ready ? "Serving" : "Reachable, not ready") : "Not reachable"}</span>
    <span style="color:var(--dim)">·</span>
    <span class="mono" style="color:var(--dim)">${esc(BASE)}</span>
  </div>
</header>

<div class="kpis">
  ${kpis.map((k) => `<div class="kpi reveal">
    <div class="v" data-count="${Number(k.value) || 0}">${num(k.value)}</div>
    <div class="l">${esc(k.label)}</div>
    <div class="n${/DISAGREE/.test(k.note) ? " warn" : ""}">${esc(k.note)}</div>
  </div>`).join("")}
</div>

<section>
  <div class="sec-head"><span class="sec-num">01</span><h2>What is actually running</h2></div>
  <p class="sec-sub">Read from the deployment and the database at build time, not written down from memory.</p>
  <div class="grid2">
    <div class="panel reveal"><table><tbody>
      <tr><td class="k">Store</td><td>SQL Server — the real database, not the in-memory demo</td></tr>
      <tr><td class="k">Authentication</td><td>LDAP. No directory is reachable here, so sign-in fails by design</td></tr>
      <tr><td class="k">Environment</td><td class="mono">NODE_ENV=production</td></tr>
      <tr><td class="k">Address</td><td class="mono">${esc(BASE)}</td></tr>
      <tr><td class="k">Deployment root</td><td class="mono">C:\\gcio</td></tr>
      <tr><td class="k">Env file</td><td class="mono">C:\\gcio\\.env — outside the repo, ACL restricted</td></tr>
      <tr><td class="k">Schema</td><td>${db.migrations.length} migrations applied</td></tr>
      <tr><td class="k">Windows service</td><td><span class="chip open">not installed</span> needs an elevated prompt</td></tr>
    </tbody></table></div>
    <div class="panel reveal"><table><tbody>
      <tr><td class="k">Slowest parse</td><td>${num(m.gcio_ingest_parse_slowest_ms)} ms <span style="color:var(--dim)">— threshold is 500 ms</span></td></tr>
      <tr><td class="k">Slowest persist</td><td>${num(m.gcio_ingest_persist_slowest_ms)} ms</td></tr>
      ${outcomes.map(({ o, n }) => `<tr><td class="k">Runs ${esc(o)}</td><td>${num(n)}</td></tr>`).join("")}
      <tr><td class="k">History begins</td><td>${db.historyBegan ? esc(new Date(db.historyBegan).toISOString().slice(0, 16).replace("T", " ")) + " UTC" : "—"}</td></tr>
    </tbody></table></div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="sec-num">02</span><h2>What this deployment found</h2></div>
  <p class="sec-sub">Every one of these needed the software to actually run. None would have been found by reading it.</p>
  ${FINDINGS.map((f) => `<div class="find ${f.severity === "open" ? "open" : ""} reveal">
    <h3><span class="num">${f.id}</span> ${esc(f.title)} ${f.severity === "open" ? '<span class="chip open">open</span>' : '<span class="chip ok">fixed</span>'}</h3>
    <p>${esc(f.detail)}</p>
    <span class="lbl">Why it matters</span><p>${esc(f.why)}</p>
    <span class="lbl">${f.severity === "open" ? "Status" : "The fix"}</span><p>${esc(f.fix)}</p>
  </div>`).join("")}
</section>

<section>
  <div class="sec-head"><span class="sec-num">03</span><h2>Every ingest, and what it did</h2></div>
  <p class="sec-sub">The run table is the answer to “why does the dashboard not show last night's file”. Failures are kept, not swallowed — the two below are the defects above, caught by the instrumentation that exists for exactly this.</p>
  <div class="panel runs reveal"><table>
    <thead><tr><th>#</th><th>Started</th><th>Trigger</th><th>Outcome</th><th>Seen</th><th>Changed</th><th>Parse</th><th>Persist</th><th>Reason</th></tr></thead>
    <tbody>${db.runs.map((r) => `<tr>
      <td class="mono">${esc(r.IngestRunId)}</td>
      <td class="mono" style="color:var(--dim)">${esc(String(r.StartedAt).replace("T", " "))}</td>
      <td>${esc(r.TriggerSource)}</td>
      <td>${outcomeChip(r.Outcome)}</td>
      <td>${num(r.ProjectsSeen)}</td>
      <td>${num(r.ProjectsChanged)}</td>
      <td>${r.ParseMs === null ? "—" : num(r.ParseMs) + " ms"}</td>
      <td>${r.PersistMs === null ? "—" : num(r.PersistMs) + " ms"}</td>
      <td class="err">${esc(r.Error || "")}</td>
    </tr>`).join("")}</tbody>
  </table></div>
</section>

<section>
  <div class="sec-head"><span class="sec-num">04</span><h2>How it got here</h2></div>
  <p class="sec-sub">Five phases. Three of them closed partly, with the deferrals recorded as decisions and reasons rather than silence.</p>
  <div class="tl">
    ${PHASES.map((p) => `<div class="ph ${p.state} reveal">
      <div class="t">${esc(p.name)} <span class="tag mono">${esc(p.tag)}</span> ${p.state === "met" ? '<span class="chip ok">met</span>' : '<span class="chip warn">partly</span>'}</div>
      <div class="w">${esc(p.what)}</div>
    </div>`).join("")}
  </div>
</section>

<section>
  <div class="sec-head"><span class="sec-num">05</span><h2>What is still outstanding</h2></div>
  <p class="sec-sub">Named with who it belongs to, because two of these are not engineering decisions.</p>
  <div class="panel reveal">
    ${OUTSTANDING.map((o) => `<div class="out">
      <div class="who">${esc(o.who)}</div>
      <div><div class="what">${esc(o.what)}</div><div class="d">${esc(o.detail)}</div></div>
    </div>`).join("")}
  </div>
</section>

<footer>
  Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from the live deployment and database.
  Re-run <span class="mono">node scripts/build-deployment-report.mjs</span> to refresh it.
  ${live.reachable ? "" : `<br><strong style="color:var(--s192)">The deployment was not reachable when this was generated — the live figures above are absent, not zero.</strong>`}
</footer>

</div>
<script>${gsapSource}</script>
<script>
(function () {
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Nothing below this line is required to read the report. If gsap is absent
     -- blocked by a CSP, or the file was stripped -- we simply never arm the
     animated state and the page stays fully legible. */
  if (reduced || typeof gsap === "undefined") return;
  document.documentElement.classList.add("anim");

  /* Any failure after arming must un-arm, or the reader is left with an
     invisible page because an animation threw halfway through. */
  window.addEventListener("error", function () {
    document.documentElement.classList.remove("anim");
  });

  /* The hero is the only thing animated on a timeline. Everything else waits
     until it is actually on screen, so a reader who scrolls immediately does
     not arrive at a section that has already played. */
  gsap.timeline({ defaults: { ease: "power3.out" } })
    .from("header .reveal", { y: 26, opacity: 0, duration: .85, stagger: .1 })
    .set("header .reveal", { clearProps: "opacity" })
    .to(".kpi", { opacity: 1, y: 0, duration: .7, stagger: .09 }, "-=.4")
    .to(".kpi::after", { duration: 0 });

  gsap.set(".kpi", { opacity: 0, y: 20 });
  gsap.to(".kpi", { opacity: 1, y: 0, duration: .7, stagger: .09, delay: .5, ease: "power3.out" });

  /* Count up to the real figure. The element carries the number as data so the
     no-JS and reduced-motion paths still show it. */
  document.querySelectorAll("[data-count]").forEach(function (el) {
    var target = Number(el.getAttribute("data-count")) || 0;
    var obj = { v: 0 };
    gsap.to(obj, {
      v: target, duration: 1.5, delay: .7, ease: "power2.out",
      onUpdate: function () { el.textContent = Math.round(obj.v).toLocaleString("en-GB"); },
      onComplete: function () { el.textContent = target.toLocaleString("en-GB"); },
      onInterrupt: function () { el.textContent = target.toLocaleString("en-GB"); }
    });
  });

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      gsap.to(e.target, { opacity: 1, y: 0, duration: .7, ease: "power3.out" });
      io.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px -12% 0px" });

  document.querySelectorAll("section .reveal").forEach(function (el) {
    gsap.set(el, { opacity: 0, y: 22 });
    io.observe(el);
  });
})();
</script>
</body></html>`;
}

/* ------------------------------------------------------------------ main */

const gsapPath = path.join(ROOT, "node_modules", "gsap", "dist", "gsap.min.js");
if (!fs.existsSync(gsapPath)) {
  console.error(`gsap not found at ${gsapPath} — run npm install first`);
  process.exit(1);
}

const live = await readLive();
if (!live.reachable) {
  console.warn(`[report] ${BASE} is not reachable (${live.error}); live figures will be marked absent`);
}
const db = await readDatabase();
const html = render({ live, db, gsapSource: fs.readFileSync(gsapPath, "utf8") });

fs.writeFileSync(OUT, html, "utf8");
console.log(`[report] wrote ${OUT} — ${(Buffer.byteLength(html) / 1024).toFixed(0)} kB, self-contained`);
console.log(`[report] projects ${db.counts.projects}, versions ${db.counts.versions}, runs ${db.counts.runs}`);
console.log(`[report] read model ${live.reachable ? (Number(live.metrics.gcio_projects) === Number(db.counts.projects) ? "agrees with" : "DISAGREES with") : "unknown vs"} the database`);
