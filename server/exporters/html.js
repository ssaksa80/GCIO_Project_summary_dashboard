/**
 * server/exporters/html.js — self-contained HTML briefing exporter.
 *
 * buildHtml(payload) -> string
 * Payload contract (SPEC §6):
 *   { summary, projects, detailProjects, meta, images, theme, generatedBy, asOf }
 *
 * One elegant standalone document: inline CSS only, ivory page, navy ink,
 * gold hairlines, A4 print rules, KPI grid, narrative, attention table with
 * RAG chips, portfolio table, per-project sections, embedded chart images.
 * No external requests. All interpolated strings are escaped.
 */

/* ------------------------------------------------------------------ */
/* Local formatters / guards (server/format.js not present)            */
/* ------------------------------------------------------------------ */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Escape a value for safe interpolation into HTML text/attributes. */
function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Coerce any value to a finite number (default 0). */
function num(v, fallback = 0) {
  const n = typeof v === "string" ? Number(v.replace(/[^0-9.eE+-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to a safe display string (em-dash fallback). */
function str(v, fallback = "—") {
  if (v === null || v === undefined || v === "") return fallback;
  return String(v);
}

/** Coerce to an array. */
function arr(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Compact executive money format: AED 1.24B / AED 386.0M / AED 250K / AED 950.
 * @param {number|string|null|undefined} v raw amount
 * @returns {string}
 */
function fmtMoney(v) {
  const n = num(v);
  const abs = Math.abs(n);
  if (abs >= 1e9) return `AED ${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `AED ${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `AED ${Math.round(n / 1e3)}K`;
  return `AED ${Math.round(n)}`;
}

/**
 * Executive date format: "12 Mar 2026". Returns em-dash for invalid input.
 * @param {string|Date|null|undefined} v ISO date string or Date
 * @returns {string}
 */
function fmtDate(v) {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Only allow data: image URLs through to <img src>; anything else is dropped. */
function safeDataUrl(v) {
  const s = String(v || "");
  return /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/.test(s) ? s : "";
}

/* ------------------------------------------------------------------ */
/* Small render helpers                                                */
/* ------------------------------------------------------------------ */

const RAG_CLASS = { Green: "rag-green", Amber: "rag-amber", Red: "rag-red" };
const SEVERITY_CLASS = { critical: "sev-critical", serious: "sev-serious", warning: "sev-warning" };

/** RAG chip: colored dot + text label (never color alone). */
function ragChip(health) {
  const h = String(health || "");
  const cls = RAG_CLASS[h] || "rag-none";
  return `<span class="chip ${cls}"><span class="dot"></span>${esc(h || "—")}</span>`;
}

/** Severity chip for attention items. */
function severityChip(severity) {
  const s = String(severity || "warning").toLowerCase();
  const cls = SEVERITY_CLASS[s] || "sev-warning";
  return `<span class="chip ${cls}"><span class="dot"></span>${esc(s.toUpperCase())}</span>`;
}

/** Tiny utilization/progress bar with printed % text. */
function miniBar(pct, danger) {
  const clamped = Math.max(0, Math.min(100, num(pct)));
  const over = danger && num(pct) > 100;
  return `<span class="minibar${over ? " over" : ""}"><span class="minibar-fill" style="width:${clamped.toFixed(1)}%"></span></span><span class="minibar-num">${num(pct).toFixed(0)}%</span>`;
}

/* ------------------------------------------------------------------ */
/* Section renderers                                                   */
/* ------------------------------------------------------------------ */

function renderKpis(kpis) {
  const health = kpis.health || {};
  const tiles = [
    ["Total Projects", String(num(kpis.totalProjects))],
    ["Active", String(num(kpis.active))],
    ["Completed (Period)", String(num(kpis.completedInPeriod))],
    ["Approved (Period)", String(num(kpis.approvedInPeriod))],
    ["On Hold", String(num(kpis.onHold))],
    ["Overdue", String(num(kpis.overdue))],
    ["Budget", fmtMoney(kpis.budgetTotal)],
    ["Spent", fmtMoney(kpis.spentTotal)],
    ["Utilization", `${num(kpis.budgetUtilizationPct).toFixed(1)}%`],
    ["Avg Completion", `${num(kpis.avgCompletion).toFixed(1)}%`],
    ["Health G/A/R", `${num(health.green)}/${num(health.amber)}/${num(health.red)}`],
    ["Open Risks", `${num(kpis.openRisks)} (${num(kpis.criticalRisks)} crit)`],
  ];
  return `<div class="kpi-grid">${tiles
    .map(
      ([label, value]) =>
        `<div class="kpi"><div class="kpi-label">${esc(label)}</div><div class="kpi-value">${esc(value)}</div></div>`
    )
    .join("")}</div>`;
}

function renderNarrative(narrative) {
  const bullets = arr(narrative.bullets);
  const wins = arr(narrative.wins);
  const watch = arr(narrative.risks);
  const empty = !narrative.headline && !bullets.length && !wins.length && !watch.length && !narrative.outlook;

  const list = (items) => `<ul class="bullets">${items.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;

  return `
<section class="block">
  <div class="section-label">Executive Briefing</div>
  ${narrative.headline ? `<p class="headline">${esc(narrative.headline)}</p>` : ""}
  ${bullets.length ? list(bullets) : ""}
  ${
    wins.length || watch.length
      ? `<div class="two-col">
    <div><div class="section-label">Wins</div>${wins.length ? list(wins) : '<p class="muted">None recorded.</p>'}</div>
    <div><div class="section-label">Watch-list</div>${watch.length ? list(watch) : '<p class="muted">None recorded.</p>'}</div>
  </div>`
      : ""
  }
  ${narrative.outlook ? `<div class="section-label">Outlook</div><p>${esc(narrative.outlook)}</p>` : ""}
  ${empty ? '<p class="muted">No narrative available for this period — the portfolio contains no matching data.</p>' : ""}
</section>`;
}

function renderAttention(items) {
  if (!items.length) {
    return `
<section class="block">
  <div class="section-label">Needs Executive Attention</div>
  <p class="muted">No items need executive attention in this period.</p>
</section>`;
  }
  const rows = items
    .filter((it) => it && typeof it === "object")
    .map(
      (it) => `<tr>
      <td>${severityChip(it.severity)}</td>
      <td class="mono">${esc(str(it.id, ""))}</td>
      <td><strong>${esc(str(it.name, ""))}</strong></td>
      <td>${esc(str(it.reason, ""))}</td>
    </tr>`
    )
    .join("");
  return `
<section class="block">
  <div class="section-label">Needs Executive Attention</div>
  <table>
    <thead><tr><th>Severity</th><th>ID</th><th>Project</th><th>Reason</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

/* ---------------------------------------------------------------------------
   The four CIO sections, in order. These replace the old single "Executive
   Briefing" block so the brief reads exactly like the dashboard.
   ------------------------------------------------------------------------ */

function sectionHead(n, title, sub) {
  return `<div class="cio-head"><span class="cio-n">${n}</span><h2>${esc(title)}</h2>${
    sub ? `<span class="cio-sub">${esc(sub)}</span>` : ""
  }</div>`;
}

function renderSuccesses(sec) {
  if (!sec) return "";
  const delivered = arr(sec.delivered);
  const milestones = arr(sec.milestones);
  const near = arr(sec.nearComplete);
  return `
<section class="block">
  ${sectionHead(1, "Successes", str(sec.headline, ""))}
  ${delivered.length ? `<div class="section-label">Delivered this period</div>
  <table>
    <thead><tr><th>Project</th><th>Closed</th><th>Budget outcome</th><th>Department</th></tr></thead>
    <tbody>${delivered.map((d) => `<tr>
      <td><strong>${esc(str(d.name, ""))}</strong></td>
      <td>${esc(fmtDate(d.completedOn))}</td>
      <td>${esc(str(d.note, ""))}</td>
      <td>${esc(str(d.department, ""))}</td>
    </tr>`).join("")}</tbody>
  </table>` : `<p class="muted">No projects closed inside this window.</p>`}
  <div class="two-col">
    <div>
      <div class="section-label">Milestones completed</div>
      ${milestones.length ? `<ul class="bullets">${milestones.map((m) =>
        `<li><strong>${esc(str(m.name, ""))}</strong> — ${esc(str(m.project, ""))} · ${esc(fmtDate(m.completedOn))}</li>`).join("")}</ul>`
        : `<p class="muted">None closed in this window.</p>`}
    </div>
    <div>
      <div class="section-label">On final approach (&ge;90%)</div>
      ${near.length ? `<ul class="bullets">${near.map((n) =>
        `<li><strong>${esc(str(n.name, ""))}</strong> — ${Math.round(num(n.percentComplete))}% complete, ${esc(str(n.note, ""))}</li>`).join("")}</ul>`
        : `<p class="muted">Nothing inside the last 10%.</p>`}
    </div>
  </div>
</section>`;
}

function renderQRI(sec) {
  if (!sec) return "";
  const questions = arr(sec.questions);
  const risks = arr(sec.risks);
  const issues = arr(sec.issues);
  const c = sec.counts || {};
  return `
<section class="block">
  ${sectionHead(2, "Questions, Risks & Issues",
    `${num(c.questions)} questions · ${num(c.risks)} open risks (${num(c.risksCritical)} critical) · ${num(c.issues)} live issues`)}

  <div class="section-label">Questions — decisions awaiting the CIO</div>
  ${questions.length ? `<table>
    <thead><tr><th>Urgency</th><th>Question</th><th>Project</th><th>Source</th><th>Needed by</th></tr></thead>
    <tbody>${questions.map((q) => `<tr>
      <td>${severityChip(q.severity)}</td>
      <td>${esc(str(q.text, ""))}<div class="muted">${esc(str(q.because, ""))}</div></td>
      <td>${esc(str(q.project, ""))}</td>
      <td>${q.source === "workbook" ? "PM" : "derived"}</td>
      <td>${q.neededBy ? esc(fmtDate(q.neededBy)) : "—"}</td>
    </tr>`).join("")}</tbody>
  </table>` : `<p class="muted">Nothing is waiting on an executive decision.</p>`}

  <div class="section-label">Open risks — severity ranked</div>
  ${risks.length ? `<table>
    <thead><tr><th>Severity</th><th>Risk</th><th>Project</th><th>Owner</th><th>Status</th></tr></thead>
    <tbody>${risks.slice(0, 15).map((r) => `<tr>
      <td>${severityChip(String(r.severity || "").toLowerCase())}</td>
      <td><strong>${esc(str(r.title, ""))}</strong></td>
      <td>${esc(str(r.project, ""))}</td>
      <td>${esc(str(r.owner, "—"))}</td>
      <td>${esc(str(r.status, ""))}</td>
    </tr>`).join("")}</tbody>
  </table>` : `<p class="muted">No open risks recorded.</p>`}

  <div class="section-label">Issues — already materialised</div>
  ${issues.length ? `<table>
    <thead><tr><th>Project</th><th>Issue</th><th>Type</th><th>Health</th></tr></thead>
    <tbody>${issues.slice(0, 15).map((i) => `<tr>
      <td><strong>${esc(str(i.project, ""))}</strong></td>
      <td>${esc(str(i.text, ""))}</td>
      <td>${esc(str(i.type, ""))}</td>
      <td>${ragChip(i.health)}</td>
    </tr>`).join("")}</tbody>
  </table>` : `<p class="muted">Nothing is overdue, overrun or held.</p>`}
</section>`;
}

function renderPriorities(sec) {
  if (!sec) return "";
  const items = arr(sec.items);
  if (!items.length) {
    return `<section class="block">${sectionHead(3, "Priorities", "")}<p class="muted">Nothing is active.</p></section>`;
  }
  return `
<section class="block">
  ${sectionHead(3, "Priorities", "Ranked by priority, health, schedule, risk, spend and dependency weight")}
  <table>
    <thead><tr><th>#</th><th>Project</th><th>Why it ranks here</th><th>What is needed</th><th>Score</th></tr></thead>
    <tbody>${items.map((p, i) => `<tr>
      <td class="mono">${i + 1}</td>
      <td><strong>${esc(str(p.name, ""))}</strong><div class="muted">${esc(str(p.owner, "no owner"))} · ${esc(str(p.department, ""))}</div></td>
      <td>${esc(str(p.why, ""))}</td>
      <td>${esc(str(p.ask, ""))}</td>
      <td class="mono">${num(p.score)}</td>
    </tr>`).join("")}</tbody>
  </table>
</section>`;
}

function renderRoadmap(sec) {
  if (!sec) return "";
  const inFlight = arr(sec.inFlight);
  const pipeline = arr(sec.pipeline);
  const milestones = arr(sec.upcomingMilestones);
  return `
<section class="block">
  ${sectionHead(4, "Roadmap / Planned Projects", `${fmtDate(sec.horizonStart)} — ${fmtDate(sec.horizonEnd)}`)}

  <div class="section-label">In flight — forecast against target</div>
  ${inFlight.length ? `<table>
    <thead><tr><th>Project</th><th>Owner</th><th>Complete</th><th>Target</th><th>Forecast</th><th>Slip</th></tr></thead>
    <tbody>${inFlight.map((p) => `<tr>
      <td><strong>${esc(str(p.name, ""))}</strong></td>
      <td>${esc(str(p.owner, "—"))}</td>
      <td>${Math.round(num(p.percentComplete))}%</td>
      <td>${esc(fmtDate(p.targetEndDate))}</td>
      <td>${esc(fmtDate(p.forecastEnd))}</td>
      <td>${num(p.slipDays) > 0 ? `+${num(p.slipDays)} days` : "on plan"}</td>
    </tr>`).join("")}</tbody>
  </table>` : `<p class="muted">Nothing is in flight.</p>`}

  <div class="two-col">
    <div>
      <div class="section-label">Planned pipeline</div>
      ${pipeline.length ? `<ul class="bullets">${pipeline.map((p) =>
        `<li><strong>${esc(str(p.name, ""))}</strong> — ${esc(str(p.status, ""))}, ${p.startDate ? `starts ${esc(fmtDate(p.startDate))}` : "no start date"}, ${esc(fmtMoney(p.budget))} · ${esc(str(p.readiness, ""))}</li>`).join("")}</ul>`
        : `<p class="muted">No proposed or approved projects waiting to start.</p>`}
    </div>
    <div>
      <div class="section-label">Milestones falling due</div>
      ${milestones.length ? `<ul class="bullets">${milestones.map((m) =>
        `<li><strong>${esc(str(m.name, ""))}</strong> — ${esc(str(m.project, ""))} · ${esc(fmtDate(m.dueDate))}</li>`).join("")}</ul>`
        : `<p class="muted">No milestones inside the horizon.</p>`}
    </div>
  </div>
</section>`;
}

function renderCharts(images) {
  const usable = images
    .filter((im) => im && im.dataUrl)
    .map((im) => ({ id: str(im.id, "chart"), src: safeDataUrl(im.dataUrl) }))
    .filter((im) => im.src);
  if (!usable.length) return "";
  return `
<section class="block">
  <div class="section-label">Portfolio Charts</div>
  <div class="chart-grid">${usable
    .map(
      (im) => `<figure class="chart"><img src="${im.src}" alt="${esc(im.id)}"><figcaption>${esc(im.id)}</figcaption></figure>`
    )
    .join("")}</div>
</section>`;
}

function renderPortfolio(projects) {
  if (!projects.length) {
    return `
<section class="block">
  <div class="section-label">Portfolio</div>
  <p class="muted">No projects in scope for this export.</p>
</section>`;
  }
  const rows = projects
    .filter((p) => p && typeof p === "object")
    .map(
      (p) => `<tr${p.overdue ? ' class="row-overdue"' : ""}>
      <td class="mono">${esc(str(p.id, ""))}</td>
      <td><strong>${esc(str(p.name, ""))}</strong></td>
      <td>${esc(str(p.department, ""))}</td>
      <td>${esc(str(p.owner, ""))}</td>
      <td>${esc(str(p.status, ""))}</td>
      <td>${ragChip(p.health)}</td>
      <td class="num">${esc(fmtMoney(p.budget))}</td>
      <td class="num">${esc(fmtMoney(p.spent))}</td>
      <td class="num nowrap">${miniBar(p.budgetUtilization, true)}</td>
      <td class="num nowrap">${miniBar(p.percentComplete, false)}</td>
      <td>${esc(fmtDate(p.targetEndDate))}${p.overdue ? ' <span class="overdue-flag">OVERDUE</span>' : ""}</td>
    </tr>`
    )
    .join("");
  return `
<section class="block">
  <div class="section-label">Portfolio</div>
  <table>
    <thead><tr>
      <th>ID</th><th>Project</th><th>Department</th><th>Owner</th><th>Status</th><th>Health</th>
      <th class="num">Budget</th><th class="num">Spent</th><th class="num">Utilization</th><th class="num">Complete</th><th>Target End</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderProjectSections(details) {
  if (!details.length) return "";
  return details
    .filter((p) => p && typeof p === "object")
    .map((p) => {
      const milestones = arr(p.milestones);
      const risks = arr(p.risks);
      const updates = arr(p.updates)
        .slice()
        .sort((a, b) => String((b && b.date) || "").localeCompare(String((a && a.date) || "")));
      const latest = updates[0];

      const metaPairs = [
        ["Owner", str(p.owner)],
        ["Sponsor", str(p.sponsor)],
        ["Department", str(p.department)],
        ["Pillar", str(p.pillar)],
        ["Program", str(p.program)],
        ["Vendor", str(p.vendor)],
        ["Approval", fmtDate(p.approvalDate)],
        ["Start", fmtDate(p.startDate)],
        ["Target End", fmtDate(p.targetEndDate)],
        ["Actual End", p.actualEndDate ? fmtDate(p.actualEndDate) : "—"],
        ["Budget", fmtMoney(p.budget)],
        ["Spent", fmtMoney(p.spent)],
      ];

      const milestoneRows = milestones
        .filter((m) => m && typeof m === "object")
        .map(
          (m) => `<tr>
          <td>${esc(str(m.name, ""))}</td>
          <td>${esc(fmtDate(m.dueDate))}</td>
          <td>${m.completedDate ? esc(fmtDate(m.completedDate)) : "—"}</td>
          <td${String(m.status) === "Overdue" ? ' class="text-critical"' : ""}>${esc(str(m.status, ""))}</td>
        </tr>`
        )
        .join("");

      const riskRows = risks
        .filter((r) => r && typeof r === "object")
        .map(
          (r) => `<tr>
          <td>${esc(str(r.title, ""))}</td>
          <td${String(r.severity) === "Critical" ? ' class="text-critical"' : String(r.severity) === "High" ? ' class="text-serious"' : ""}>${esc(str(r.severity, ""))}</td>
          <td>${esc(str(r.status, ""))}</td>
          <td>${esc(str(r.owner, ""))}</td>
        </tr>`
        )
        .join("");

      return `
<section class="block project-section">
  <div class="project-banner">
    <span class="mono">${esc(str(p.id, ""))}</span>
    <h2>${esc(str(p.name, "Untitled project"))}</h2>
    <div class="banner-chips">${ragChip(p.health)}<span class="chip chip-plain">${esc(str(p.status, ""))}</span><span class="chip chip-plain">${esc(str(p.priority, ""))} priority</span><span class="chip chip-plain">${esc(str(p.phase, ""))}</span></div>
  </div>
  ${p.description ? `<p class="project-desc">${esc(p.description)}</p>` : ""}
  <div class="meta-grid">${metaPairs
    .map(([k, v]) => `<div class="meta"><div class="meta-k">${esc(k)}</div><div class="meta-v">${esc(v)}</div></div>`)
    .join("")}</div>
  <div class="progress-line"><span class="section-label inline">Completion</span> ${miniBar(p.percentComplete, false)}</div>
  ${
    milestoneRows
      ? `<div class="section-label">Milestones</div>
  <table><thead><tr><th>Milestone</th><th>Due</th><th>Completed</th><th>Status</th></tr></thead><tbody>${milestoneRows}</tbody></table>`
      : ""
  }
  ${
    riskRows
      ? `<div class="section-label">Risks</div>
  <table><thead><tr><th>Risk</th><th>Severity</th><th>Status</th><th>Owner</th></tr></thead><tbody>${riskRows}</tbody></table>`
      : ""
  }
  ${
    latest
      ? `<div class="section-label">Latest Update</div>
  <p class="update"><strong>${esc(fmtDate(latest.date))} — ${esc(str(latest.author, "Unknown"))}</strong><br>${esc(str(latest.text, ""))}</p>`
      : ""
  }
</section>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the self-contained executive HTML briefing.
 *
 * @param {object} payload SPEC §6 export payload:
 *   `{summary, projects, detailProjects, meta, images, theme, generatedBy, asOf}`.
 *   Every field is optional; missing or empty data produces a valid,
 *   gracefully annotated document. All interpolated values are escaped.
 * @returns {string} Complete standalone HTML document.
 */
export function buildHtml(payload) {
  const safe = payload && typeof payload === "object" ? payload : {};
  const summary = safe.summary && typeof safe.summary === "object" ? safe.summary : {};
  const kpis = summary.kpis || {};
  const sections = summary.sections || {};
  const projects = arr(safe.projects);
  const details = arr(safe.detailProjects);
  const images = arr(safe.images);
  const generatedBy = str(safe.generatedBy, "GCIO Project Intelligence");
  const period = str(summary.period, "portfolio");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GCIO Portfolio Brief — ${esc(period)} — ${esc(fmtDate(summary.date || safe.asOf))}</title>
<style>
  :root {
    --page: #f7f5f0;
    --card: #ffffff;
    --card2: #f3f2ed;
    --ink: #14120e;
    --ink-2: #5a574f;
    --muted: #898781;
    --navy: #101828;
    --gold: #b08d3e;
    --hairline: rgba(11, 11, 11, .12);
    --good: #0ca30c;
    --warn: #b07900;
    --serious: #c2571f;
    --critical: #d03b3b;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--page);
    color: var(--ink);
    font: 14px/1.55 "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .sheet { max-width: 960px; margin: 0 auto; padding: 40px 44px 24px; }
  .masthead {
    background: var(--navy); color: #fff; border-radius: 12px;
    padding: 30px 34px 26px; margin-bottom: 28px;
  }
  .masthead h1 { margin: 0 0 6px; font-size: 30px; font-weight: 650; letter-spacing: .01em; }
  .masthead .kicker {
    color: var(--gold); font-size: 11px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .12em; margin-bottom: 10px;
  }
  .masthead .meta-line { color: rgba(255,255,255,.72); font-size: 12px; }
  .section-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em;
    color: var(--gold); border-bottom: 1px solid var(--gold);
    padding-bottom: 4px; margin: 26px 0 12px;
  }
  .section-label.inline { display: inline; border: 0; margin: 0 8px 0 0; }
  .cio-head {
    display: flex; align-items: center; gap: 11px; flex-wrap: wrap;
    border-bottom: 2px solid var(--navy); padding-bottom: 8px; margin: 30px 0 14px;
  }
  .cio-head h2 { margin: 0; font-size: 20px; font-weight: 700; }
  .cio-n {
    width: 26px; height: 26px; border-radius: 7px; background: var(--navy); color: #fff;
    display: inline-grid; place-items: center; font-weight: 700; font-size: 13px;
  }
  .cio-sub { margin-left: auto; font-size: 11.5px; color: var(--muted); }
  .block { margin-bottom: 8px; }
  .headline { font-size: 19px; font-weight: 620; line-height: 1.4; margin: 4px 0 14px; }
  .muted { color: var(--muted); font-style: italic; }
  ul.bullets { margin: 6px 0 12px; padding-left: 20px; }
  ul.bullets li { margin-bottom: 5px; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 32px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 4px 0 8px; }
  .kpi {
    background: var(--card); border: 1px solid var(--hairline); border-radius: 12px;
    padding: 12px 14px 11px;
  }
  .kpi-label {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .08em; color: var(--muted); margin-bottom: 4px;
  }
  .kpi-value { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 10px; background: var(--card); border-radius: 12px; }
  th {
    background: var(--navy); color: #fff; text-align: left;
    font-size: 11px; font-weight: 700; letter-spacing: .04em;
    padding: 8px 10px; border: 1px solid rgba(255,255,255,.12);
  }
  td { padding: 7px 10px; border: 1px solid var(--hairline); font-size: 12.5px; vertical-align: top; }
  td.num, th.num { text-align: right; }
  td.nowrap { white-space: nowrap; }
  .mono { font-family: Consolas, "Courier New", monospace; font-size: 12px; }
  .row-overdue td { background: #fdf6f4; }
  .overdue-flag { color: var(--critical); font-size: 10px; font-weight: 800; letter-spacing: .06em; }
  .text-critical { color: var(--critical); font-weight: 700; }
  .text-serious { color: var(--serious); font-weight: 700; }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--hairline); border-radius: 999px;
    padding: 2px 10px 2px 8px; font-size: 11px; font-weight: 700; white-space: nowrap;
    background: var(--card2); color: var(--ink-2);
  }
  .chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
  .chip-plain .dot { display: none; }
  .rag-green  { background: #dcefdc; color: #1e4620; } .rag-green .dot  { background: var(--good); }
  .rag-amber  { background: #fdf0d3; color: #6b4e00; } .rag-amber .dot  { background: var(--warn); }
  .rag-red    { background: #f6dada; color: #7a1f1f; } .rag-red .dot    { background: var(--critical); }
  .sev-critical { background: #f6dada; color: #7a1f1f; } .sev-critical .dot { background: var(--critical); }
  .sev-serious  { background: #fbe6db; color: #7a3a12; } .sev-serious .dot  { background: var(--serious); }
  .sev-warning  { background: #fdf0d3; color: #6b4e00; } .sev-warning .dot  { background: var(--warn); }
  .minibar {
    display: inline-block; width: 64px; height: 7px; border-radius: 4px;
    background: var(--card2); border: 1px solid var(--hairline);
    overflow: hidden; vertical-align: middle;
  }
  .minibar-fill { display: block; height: 100%; background: var(--navy); }
  .minibar.over .minibar-fill { background: var(--critical); }
  .minibar-num { font-size: 11px; margin-left: 6px; font-variant-numeric: tabular-nums; }
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  figure.chart {
    margin: 0; background: var(--card); border: 1px solid var(--hairline);
    border-radius: 12px; padding: 10px;
  }
  figure.chart img { width: 100%; max-width: 100%; height: auto; display: block; border-radius: 6px; }
  figure.chart figcaption { font-size: 11px; color: var(--muted); margin-top: 6px; text-align: center; }
  .project-section {
    background: var(--card); border: 1px solid var(--hairline); border-radius: 12px;
    padding: 22px 26px 18px; margin: 22px 0;
  }
  .project-banner { border-bottom: 2px solid var(--gold); padding-bottom: 12px; margin-bottom: 14px; }
  .project-banner h2 { margin: 2px 0 8px; font-size: 21px; font-weight: 650; color: var(--navy); }
  .project-banner .mono { color: var(--muted); }
  .banner-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .project-desc { color: var(--ink-2); margin: 0 0 14px; }
  .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 18px; margin-bottom: 14px; }
  .meta-k { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  .meta-v { font-size: 13px; font-weight: 600; }
  .progress-line { margin: 6px 0 4px; }
  .update { background: var(--card2); border-left: 3px solid var(--gold); padding: 10px 14px; border-radius: 0 8px 8px 0; }
  footer.brief-footer {
    margin-top: 34px; padding-top: 12px; border-top: 1px solid var(--gold);
    color: var(--muted); font-size: 11px; text-align: center;
    text-transform: uppercase; letter-spacing: .08em;
  }
  @media (max-width: 700px) {
    .kpi-grid, .meta-grid { grid-template-columns: repeat(2, 1fr); }
    .two-col, .chart-grid { grid-template-columns: 1fr; }
    .sheet { padding: 20px 16px; }
  }
  @page { size: A4; margin: 16mm 14mm; }
  @media print {
    body { background: #fff; }
    .sheet { max-width: none; padding: 0; }
    .project-section { page-break-inside: avoid; break-inside: avoid; }
    .block { page-break-inside: auto; }
    section.block + section.project-section { page-break-before: always; break-before: page; }
    table { page-break-inside: auto; }
    tr { page-break-inside: avoid; }
    figure.chart { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="sheet">
  <header class="masthead">
    <div class="kicker">${esc(period)} Executive Briefing · Confidential</div>
    <h1>GCIO Portfolio Brief</h1>
    <div class="meta-line">
      Period ${esc(fmtDate(summary.rangeStart))} — ${esc(fmtDate(summary.rangeEnd))}
      &nbsp;·&nbsp; Generated ${esc(fmtDate(summary.generatedAt || safe.asOf))}
      &nbsp;·&nbsp; As of ${esc(fmtDate(safe.asOf))}
      &nbsp;·&nbsp; Currency ${esc(str(summary.currency, "AED"))}
    </div>
  </header>

  <section class="block">
    <div class="section-label">Key Performance Indicators</div>
    ${renderKpis(kpis)}
  </section>

  ${renderSuccesses(sections.successes)}
  ${renderQRI(sections.qri)}
  ${renderPriorities(sections.priorities)}
  ${renderRoadmap(sections.roadmap)}
  ${renderCharts(images)}
  ${renderPortfolio(projects)}
  ${renderProjectSections(details)}

  <footer class="brief-footer">Generated by ${esc(generatedBy)} · ${esc(fmtDate(safe.asOf))}</footer>
</div>
</body>
</html>`;
}
