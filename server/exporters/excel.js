/**
 * server/exporters/excel.js — Excel briefing exporter (exceljs).
 *
 * buildExcel(payload) -> Promise<Buffer>
 * Payload contract (SPEC §6):
 *   { summary, projects, detailProjects, meta, images, theme, generatedBy, asOf }
 *
 * Sheets: "Executive Summary", "Portfolio", "Attention Items",
 * "Projects Detail", and "Charts" (only when payload.images is non-empty).
 */

import ExcelJS from "exceljs";

/* ------------------------------------------------------------------ */
/* Brand palette                                                       */
/* ------------------------------------------------------------------ */

const NAVY = "FF101828";
const GOLD = "FFB08D3E";
const INK = "FF14120E";
const INK_SOFT = "FF5A574F";
const IVORY = "FFF7F5F0";
const CARD = "FFF3F2ED";
const WHITE = "FFFFFFFF";
const RAG_FILL = { Green: "FFDCEFDC", Amber: "FFFDF0D3", Red: "FFF6DADA" };
const RAG_INK = { Green: "FF1E4620", Amber: "FF6B4E00", Red: "FF7A1F1F" };
const SEVERITY_INK = { critical: "FFD03B3B", serious: "FFEC835A", warning: "FF9A6E00" };

const MONEY_FMT = '"AED" #,##0';
const PCT_FMT = "0.00%";

/* ------------------------------------------------------------------ */
/* Local formatters / guards (server/format.js not present)            */
/* ------------------------------------------------------------------ */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Coerce any value to a finite number (default 0). */
function num(v, fallback = 0) {
  const n = typeof v === "string" ? Number(v.replace(/[^0-9.eE+-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Coerce to a safe display string. */
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

/** Extract raw base64 from a data URL (or pass through raw base64). */
function base64FromDataUrl(dataUrl) {
  const s = String(dataUrl || "");
  const idx = s.indexOf("base64,");
  return idx >= 0 ? s.slice(idx + 7) : s;
}

/**
 * Change text for a section item, or "" when it did not move (or there is no
 * history to say). Never mutate `change` — the same object is shared across
 * every section that names this project.
 */
function changeText(change) {
  if (!change) return "";
  if (change.trackedSince) return ` (new since ${fmtDate(change.trackedSince)})`;
  const arrow = change.worst === "worse" ? "▲" : change.worst === "better" ? "▼" : "•";
  return ` (${arrow} ${str(change.headline, "")})`;
}

/**
 * The client's honest-cold-start line: a workbook with no change markers must
 * say why, because it is read and forwarded with nobody present to explain
 * the absence — without this a reader infers a stable portfolio, which is
 * exactly the wrong inference when the truth is "we cannot know". Suppressed
 * outright when history IS available: a period where nothing moved is a real
 * answer and gets no apology.
 */
function noHistoryLine(summary) {
  if (summary?.sections?.historyAvailable) return null;
  return summary?.historyStartedAt
    ? `No change history before ${fmtDate(summary.historyStartedAt)}.`
    : "No change history yet — it begins with the next upload.";
}

/* ------------------------------------------------------------------ */
/* Style helpers                                                       */
/* ------------------------------------------------------------------ */

function solidFill(argb) {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function thinBorder(argb = "FFD8D3C4") {
  const side = { style: "thin", color: { argb } };
  return { top: side, left: side, bottom: side, right: side };
}

const BOX_BORDER = thinBorder("FFD8D3C4");

/** Style a header row: navy fill, white bold text. */
function styleHeaderRow(row) {
  row.eachCell((cell) => {
    cell.fill = solidFill(NAVY);
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: WHITE } };
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
    cell.border = thinBorder("FF3A4356");
  });
  row.height = 22;
}

/* ------------------------------------------------------------------ */
/* Sheet builders                                                      */
/* ------------------------------------------------------------------ */

/** Executive Summary sheet: title block, KPI grid 3x4, narrative. */
function buildExecutiveSummarySheet(wb, payload) {
  const { summary = {}, generatedBy, asOf } = payload;
  const kpis = summary.kpis || {};
  const narrative = summary.narrative || {};
  const health = kpis.health || {};

  const ws = wb.addWorksheet("Executive Summary", {
    properties: { defaultRowHeight: 16 },
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  for (let c = 1; c <= 8; c++) ws.getColumn(c).width = 16;

  // ---- Title block (merged) ----
  ws.mergeCells("A1:H2");
  const title = ws.getCell("A1");
  title.value = "GCIO Portfolio Brief";
  title.font = { name: "Calibri", size: 24, bold: true, color: { argb: WHITE } };
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  title.fill = solidFill(NAVY);
  ws.getRow(1).height = 26;
  ws.getRow(2).height = 26;

  ws.mergeCells("A3:H3");
  const sub = ws.getCell("A3");
  const period = str(summary.period, "portfolio").toUpperCase();
  sub.value = `${period} EXECUTIVE BRIEFING · ${fmtDate(summary.rangeStart)} — ${fmtDate(summary.rangeEnd)}`;
  sub.font = { name: "Calibri", size: 10, bold: true, color: { argb: GOLD } };
  sub.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  sub.fill = solidFill(NAVY);
  ws.getRow(3).height = 20;

  ws.mergeCells("A4:H4");
  const gen = ws.getCell("A4");
  gen.value = `Generated ${fmtDate(summary.generatedAt || asOf)} by ${str(generatedBy, "GCIO Project Intelligence")} · As of ${fmtDate(asOf)}`;
  gen.font = { name: "Calibri", size: 9, italic: true, color: { argb: INK_SOFT } };
  gen.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(4).height = 16;

  // ---- No-history line, reusing the blank spacer row above the KPI grid so
  // the grid's own fixed start row (6) never has to move for it. ----
  const noHistory = noHistoryLine(summary);
  if (noHistory) {
    ws.mergeCells("A5:H5");
    const note = ws.getCell("A5");
    note.value = noHistory;
    note.font = { name: "Calibri", size: 9, italic: true, color: { argb: INK_SOFT } };
    note.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(5).height = 16;
  }

  // ---- KPI grid: 3 rows x 4 columns (label cell above value cell) ----
  const kpiDefs = [
    ["Total Projects", num(kpis.totalProjects)],
    ["Active", num(kpis.active)],
    ["Completed (Period)", num(kpis.completedInPeriod)],
    ["Approved (Period)", num(kpis.approvedInPeriod)],
    ["On Hold", num(kpis.onHold)],
    ["Overdue", num(kpis.overdue)],
    ["Budget", fmtMoney(kpis.budgetTotal)],
    ["Spent", fmtMoney(kpis.spentTotal)],
    ["Utilization", `${num(kpis.budgetUtilizationPct).toFixed(1)}%`],
    ["Avg Completion", `${num(kpis.avgCompletion).toFixed(1)}%`],
    ["Health G / A / R", `${num(health.green)} / ${num(health.amber)} / ${num(health.red)}`],
    ["Open Risks", `${num(kpis.openRisks)} (${num(kpis.criticalRisks)} critical)`],
  ];

  let rowIdx = 6;
  for (let gridRow = 0; gridRow < 3; gridRow++) {
    const labelRow = ws.getRow(rowIdx);
    const valueRow = ws.getRow(rowIdx + 1);
    labelRow.height = 16;
    valueRow.height = 26;
    for (let gridCol = 0; gridCol < 4; gridCol++) {
      const def = kpiDefs[gridRow * 4 + gridCol];
      const colStart = gridCol * 2 + 1; // A,C,E,G
      ws.mergeCells(rowIdx, colStart, rowIdx, colStart + 1);
      ws.mergeCells(rowIdx + 1, colStart, rowIdx + 1, colStart + 1);
      const labelCell = labelRow.getCell(colStart);
      const valueCell = valueRow.getCell(colStart);
      labelCell.value = def[0].toUpperCase();
      labelCell.font = { name: "Calibri", size: 8, bold: true, color: { argb: INK_SOFT } };
      labelCell.alignment = { vertical: "bottom", horizontal: "left", indent: 1 };
      labelCell.fill = solidFill(CARD);
      valueCell.value = def[1];
      valueCell.font = { name: "Calibri", size: 14, bold: true, color: { argb: INK } };
      valueCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      valueCell.fill = solidFill(IVORY);
      // Border the full 2x2 block
      for (const cellRow of [rowIdx, rowIdx + 1]) {
        for (const c of [colStart, colStart + 1]) {
          ws.getCell(cellRow, c).border = BOX_BORDER;
        }
      }
    }
    rowIdx += 2;
  }

  // ---- Narrative section ----
  rowIdx += 1;
  const writeSectionLabel = (text) => {
    ws.mergeCells(rowIdx, 1, rowIdx, 8);
    const cell = ws.getCell(rowIdx, 1);
    cell.value = text.toUpperCase();
    cell.font = { name: "Calibri", size: 9, bold: true, color: { argb: GOLD } };
    cell.border = { bottom: { style: "thin", color: { argb: GOLD } } };
    ws.getRow(rowIdx).height = 18;
    rowIdx += 1;
  };
  const writeWrapped = (text, { bold = false, bullet = false } = {}) => {
    ws.mergeCells(rowIdx, 1, rowIdx, 8);
    const cell = ws.getCell(rowIdx, 1);
    cell.value = bullet ? `•  ${text}` : text;
    cell.font = { name: "Calibri", size: bold ? 12 : 10, bold, color: { argb: INK } };
    cell.alignment = { vertical: "top", horizontal: "left", wrapText: true };
    ws.getRow(rowIdx).height = Math.max(16, Math.ceil(String(text).length / 110) * 15 + 4);
    rowIdx += 1;
  };

  const sections = summary.sections || {};
  const successes = sections.successes || {};
  const qri = sections.qri || {};
  const counts = qri.counts || {};
  const priorities = sections.priorities || {};
  const roadmap = sections.roadmap || {};

  writeSectionLabel("1 · Successes");
  writeWrapped(str(successes.headline, "No completions recorded in this window."), { bold: true });
  for (const d of arr(successes.delivered).slice(0, 6)) {
    writeWrapped(`${str(d.name, "")}${changeText(d.change)} — closed ${fmtDate(d.completedOn)}, ${str(d.note, "")}`, { bullet: true });
  }

  rowIdx += 1;
  writeSectionLabel("2 · Questions, Risks & Issues");
  writeWrapped(
    `${num(counts.questions)} open questions (${num(counts.questionsCritical)} needing a decision now) · ` +
    `${num(counts.risks)} open risks (${num(counts.risksCritical)} critical) · ${num(counts.issues)} live issues.`,
    { bold: true }
  );
  for (const q of arr(qri.questions).slice(0, 5)) {
    writeWrapped(`${str(q.text, "")} — ${str(q.project, "")}${changeText(q.change)}`, { bullet: true });
  }

  rowIdx += 1;
  writeSectionLabel("3 · Priorities");
  arr(priorities.items).slice(0, 5).forEach((item, i) => {
    writeWrapped(`${i + 1}. ${str(item.name, "")}${changeText(item.change)} (urgency ${num(item.score)}) — needed: ${str(item.ask, "")}`, { bullet: true });
  });

  rowIdx += 1;
  writeSectionLabel("4 · Roadmap / Planned Projects");
  writeWrapped(
    `${arr(roadmap.inFlight).length} in flight · ${arr(roadmap.pipeline).length} planned · ` +
    `${fmtMoney(num(roadmap.committedAhead))} committed ahead · horizon to ${fmtDate(roadmap.horizonEnd)}.`,
    { bold: true }
  );
  for (const item of arr(roadmap.pipeline).slice(0, 5)) {
    writeWrapped(`${str(item.name, "")}${changeText(item.change)} — ${str(item.status, "")}, starts ${fmtDate(item.startDate)}, ${fmtMoney(num(item.budget))}`, { bullet: true });
  }
}

/* ---------------------------------------------------------------------------
   One sheet per CIO section, numbered so the tab order is the reading order.
   ------------------------------------------------------------------------ */

/** Shared sheet scaffold: title band, header row, data rows. */
function sectionSheet(wb, name, title, headers, rows, widths) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 2 }] });
  ws.mergeCells(1, 1, 1, Math.max(1, headers.length));
  const banner = ws.getCell(1, 1);
  banner.value = title;
  banner.font = { name: "Calibri", size: 13, bold: true, color: { argb: WHITE } };
  banner.fill = solidFill(NAVY);
  banner.alignment = { vertical: "middle" };
  ws.getRow(1).height = 26;

  const header = ws.addRow(headers);
  styleHeaderRow(header);
  for (const row of rows) ws.addRow(row);
  ws.columns.forEach((col, i) => {
    col.width = (widths && widths[i]) || 22;
    col.alignment = { vertical: "top", wrapText: true };
  });
  ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: headers.length } };
  return ws;
}

function buildPostureSheet(wb, payload) {
  const sec = ((payload.summary || {}).sections || {}).posture || {};
  if (!sec.available) return null;

  const rows = arr(sec.domains).map((d) => [
    str(d.domain, "") + changeText(d.change), str(d.control, ""), str(d.status, ""),
    d.status === "Not Assessed" ? null : num(d.score) / 100,
    num(d.target) / 100,
    num(d.openFindings), num(d.criticalFindings),
    str(d.owner, "—"), fmtDate(d.lastAssessed), fmtDate(d.nextReview),
    d.reviewOverdue ? `overdue by ${num(d.reviewOverdueDays)} days` : "",
    d.linkedProject ? str(d.linkedProject.name, "") : "",
    str(d.notes, ""),
  ]);

  const ws = sectionSheet(wb, "5 Security Posture",
    `5 · Security Posture — ${str(sec.headline, "")}`,
    ["Domain", "Control", "Status", "Score", "Target", "Open findings", "Critical",
     "Owner", "Last assessed", "Next review", "Review state", "Remediation project", "Notes"],
    rows.length ? rows : [["—", "", "No posture data provided", null, null, 0, 0, "", "", "", "", "", ""]],
    [28, 30, 15, 9, 9, 13, 10, 20, 15, 14, 20, 34, 50]);
  ws.getColumn(4).numFmt = "0%";
  ws.getColumn(5).numFmt = "0%";
  return ws;
}

function buildSuccessesSheet(wb, payload) {
  const sec = ((payload.summary || {}).sections || {}).successes || {};
  const rows = [
    ...arr(sec.delivered).map((d) => ["Delivered", str(d.name, "") + changeText(d.change), str(d.department, ""), fmtDate(d.completedOn), num(d.budget), num(d.spent), str(d.note, "")]),
    ...arr(sec.milestones).map((m) => ["Milestone closed", str(m.name, ""), str(m.project, "") + changeText(m.change), fmtDate(m.completedOn), null, null, ""]),
    ...arr(sec.nearComplete).map((n) => ["Near complete", str(n.name, "") + changeText(n.change), "", fmtDate(n.targetEndDate), null, null, `${Math.round(num(n.percentComplete))}% — ${str(n.note, "")}`]),
  ];
  const ws = sectionSheet(wb, "1 Successes", `1 · Successes — ${str(sec.headline, "")}`,
    ["Type", "Name", "Project / Department", "Date", "Budget", "Spent", "Note"],
    rows.length ? rows : [["—", "Nothing recorded in this window", "", "", null, null, ""]],
    [16, 40, 26, 14, 16, 16, 52]);
  ws.getColumn(5).numFmt = MONEY_FMT;
  ws.getColumn(6).numFmt = MONEY_FMT;
  return ws;
}

function buildQRISheet(wb, payload) {
  const sec = ((payload.summary || {}).sections || {}).qri || {};
  const counts = sec.counts || {};
  const rows = [
    ...arr(sec.questions).map((q) => [
      "Question",
      q.severity === "critical" ? "Decision now" : "Decision soon",
      str(q.text, ""),
      str(q.project, "") + changeText(q.change),
      q.source === "workbook" ? "PM" : "derived",
      q.neededBy ? fmtDate(q.neededBy) : "—",
      str(q.because, ""),
    ]),
    ...arr(sec.risks).map((r) => ["Risk", str(r.severity, ""), str(r.title, ""), str(r.project, "") + changeText(r.change), str(r.owner, "—"), str(r.status, ""), ""]),
    ...arr(sec.issues).map((i) => ["Issue", str(i.health, ""), str(i.text, ""), str(i.project, ""), str(i.type, ""), "", ""]),
  ];
  return sectionSheet(wb, "2 Questions Risks Issues",
    `2 · Questions, Risks & Issues — ${num(counts.questions)} questions · ${num(counts.risks)} risks · ${num(counts.issues)} issues`,
    ["Kind", "Severity", "Detail", "Project", "Owner / Source", "Needed by / Status", "Evidence"],
    rows.length ? rows : [["—", "", "Nothing outstanding", "", "", "", ""]],
    [12, 15, 62, 30, 18, 18, 40]);
}

function buildPrioritiesSheet(wb, payload) {
  const sec = ((payload.summary || {}).sections || {}).priorities || {};
  const rows = arr(sec.items).map((p, i) => [
    i + 1, str(p.name, "") + changeText(p.change), num(p.score), str(p.health, ""), str(p.priority, ""),
    str(p.owner, "—"), num(p.budget), Math.round(num(p.percentComplete)) / 100,
    str(p.why, ""), str(p.ask, ""),
  ]);
  const ws = sectionSheet(wb, "3 Priorities", "3 · Priorities — ranked call list",
    ["#", "Project", "Score", "Health", "Priority", "Owner", "Budget", "% Complete", "Why it ranks here", "What is needed"],
    rows.length ? rows : [[1, "Nothing active", 0, "", "", "", 0, 0, "", ""]],
    [5, 36, 8, 10, 11, 20, 16, 12, 52, 52]);
  ws.getColumn(7).numFmt = MONEY_FMT;
  ws.getColumn(8).numFmt = "0%";
  return ws;
}

function buildRoadmapSheet(wb, payload) {
  const sec = ((payload.summary || {}).sections || {}).roadmap || {};
  const rows = [
    ...arr(sec.inFlight).map((p) => ["In flight", str(p.name, "") + changeText(p.change), str(p.owner, "—"), Math.round(num(p.percentComplete)) / 100,
      fmtDate(p.targetEndDate), fmtDate(p.forecastEnd), num(p.slipDays) > 0 ? `+${num(p.slipDays)} days` : "on plan", null, ""]),
    ...arr(sec.pipeline).map((p) => ["Planned", str(p.name, "") + changeText(p.change), str(p.sponsor, "—"), 0,
      fmtDate(p.startDate), fmtDate(p.targetEndDate), str(p.status, ""), num(p.budget), str(p.readiness, "")]),
    ...arr(sec.upcomingMilestones).map((m) => ["Milestone due", str(m.name, ""), str(m.project, "") + changeText(m.change), null,
      fmtDate(m.dueDate), "", "", null, ""]),
  ];
  const ws = sectionSheet(wb, "4 Roadmap",
    `4 · Roadmap / Planned — horizon ${fmtDate(sec.horizonStart)} to ${fmtDate(sec.horizonEnd)}`,
    ["Kind", "Name", "Owner / Project", "% Complete", "Start / Target", "Forecast / Due", "Status", "Budget", "Readiness"],
    rows.length ? rows : [["—", "Nothing scheduled", "", null, "", "", "", null, ""]],
    [14, 40, 26, 12, 16, 16, 16, 16, 14]);
  ws.getColumn(4).numFmt = "0%";
  ws.getColumn(8).numFmt = MONEY_FMT;
  return ws;
}

/** Portfolio sheet: frozen header, autofilter, RAG fills, AED formats. */
function buildPortfolioSheet(wb, payload) {
  const projects = arr(payload.projects);
  const ws = wb.addWorksheet("Portfolio", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const columns = [
    { header: "ID", key: "id", width: 12 },
    { header: "Project", key: "name", width: 38 },
    { header: "Department", key: "department", width: 22 },
    { header: "Pillar", key: "pillar", width: 22 },
    { header: "Program", key: "program", width: 20 },
    { header: "Owner", key: "owner", width: 20 },
    { header: "Sponsor", key: "sponsor", width: 20 },
    { header: "Status", key: "status", width: 14 },
    { header: "Health", key: "health", width: 10 },
    { header: "Priority", key: "priority", width: 10 },
    { header: "Phase", key: "phase", width: 13 },
    { header: "Start", key: "startDate", width: 13 },
    { header: "Target End", key: "targetEndDate", width: 13 },
    { header: "Budget (AED)", key: "budget", width: 16 },
    { header: "Spent (AED)", key: "spent", width: 16 },
    { header: "Utilization", key: "budgetUtilization", width: 12 },
    { header: "% Complete", key: "percentComplete", width: 12 },
    { header: "Overdue", key: "overdue", width: 10 },
  ];
  ws.columns = columns;
  styleHeaderRow(ws.getRow(1));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };

  for (const p of projects) {
    if (!p || typeof p !== "object") continue;
    const row = ws.addRow({
      id: str(p.id, ""),
      name: str(p.name, ""),
      department: str(p.department, ""),
      pillar: str(p.pillar, ""),
      program: str(p.program, ""),
      owner: str(p.owner, ""),
      sponsor: str(p.sponsor, ""),
      status: str(p.status, ""),
      health: str(p.health, ""),
      priority: str(p.priority, ""),
      phase: str(p.phase, ""),
      startDate: fmtDate(p.startDate),
      targetEndDate: fmtDate(p.targetEndDate),
      budget: num(p.budget),
      spent: num(p.spent),
      budgetUtilization: num(p.budgetUtilization) / 100,
      percentComplete: num(p.percentComplete) / 100,
      overdue: p.overdue ? "Yes" : "No",
    });
    row.font = { name: "Calibri", size: 10, color: { argb: INK } };
    row.alignment = { vertical: "middle" };

    row.getCell("budget").numFmt = MONEY_FMT;
    row.getCell("spent").numFmt = MONEY_FMT;
    row.getCell("budgetUtilization").numFmt = PCT_FMT;
    row.getCell("percentComplete").numFmt = PCT_FMT;

    const healthCell = row.getCell("health");
    const rag = String(p.health || "");
    if (RAG_FILL[rag]) {
      healthCell.fill = solidFill(RAG_FILL[rag]);
      healthCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: RAG_INK[rag] } };
    }
    if (p.overdue) {
      row.getCell("overdue").font = { name: "Calibri", size: 10, bold: true, color: { argb: SEVERITY_INK.critical } };
    }
  }

  if (!projects.length) {
    const row = ws.addRow({ id: "—", name: "No projects in scope for this export." });
    row.font = { name: "Calibri", size: 10, italic: true, color: { argb: INK_SOFT } };
  }
}

/** Attention Items sheet. */
function buildAttentionSheet(wb, payload) {
  const items = arr(payload.summary && payload.summary.attention);
  const ws = wb.addWorksheet("Attention Items");
  ws.columns = [
    { header: "Severity", key: "severity", width: 12 },
    { header: "ID", key: "id", width: 12 },
    { header: "Project", key: "name", width: 40 },
    { header: "Reason", key: "reason", width: 70 },
  ];
  styleHeaderRow(ws.getRow(1));
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 4 } };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const severity = String(it.severity || "warning").toLowerCase();
    const row = ws.addRow({
      severity: severity.toUpperCase(),
      id: str(it.id, ""),
      name: str(it.name, ""),
      reason: str(it.reason, ""),
    });
    row.font = { name: "Calibri", size: 10, color: { argb: INK } };
    row.alignment = { vertical: "top", wrapText: true };
    row.getCell("severity").font = {
      name: "Calibri",
      size: 10,
      bold: true,
      color: { argb: SEVERITY_INK[severity] || INK },
    };
  }
  if (!items.length) {
    const row = ws.addRow({ severity: "", id: "—", name: "No items need executive attention in this period." });
    row.font = { name: "Calibri", size: 10, italic: true, color: { argb: INK_SOFT } };
  }
}

/** Projects Detail sheet: banner + meta rows + milestones per project. */
function buildProjectsDetailSheet(wb, payload) {
  const details = arr(payload.detailProjects);
  const ws = wb.addWorksheet("Projects Detail");
  ws.getColumn(1).width = 24;
  ws.getColumn(2).width = 46;
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 16;
  ws.getColumn(5).width = 16;

  let r = 1;
  if (!details.length) {
    const cell = ws.getCell(r, 1);
    cell.value = "No project detail requested for this export.";
    cell.font = { name: "Calibri", size: 10, italic: true, color: { argb: INK_SOFT } };
    return;
  }

  for (const p of details) {
    if (!p || typeof p !== "object") continue;

    // Banner
    ws.mergeCells(r, 1, r, 5);
    const banner = ws.getCell(r, 1);
    banner.value = `${str(p.id, "")}  ·  ${str(p.name, "Untitled project")}`;
    banner.fill = solidFill(NAVY);
    banner.font = { name: "Calibri", size: 13, bold: true, color: { argb: WHITE } };
    banner.alignment = { vertical: "middle", indent: 1 };
    ws.getRow(r).height = 24;
    r += 1;

    // Meta rows
    const meta = [
      ["Department / Pillar", `${str(p.department)} · ${str(p.pillar)}`],
      ["Owner / Sponsor", `${str(p.owner)} · ${str(p.sponsor)}`],
      ["Status / Health / Priority", `${str(p.status)} · ${str(p.health)} · ${str(p.priority)}`],
      ["Phase / % Complete", `${str(p.phase)} · ${num(p.percentComplete).toFixed(0)}%`],
      ["Start → Target End", `${fmtDate(p.startDate)} → ${fmtDate(p.targetEndDate)}`],
      ["Budget / Spent", `${fmtMoney(p.budget)} / ${fmtMoney(p.spent)}`],
      ["Vendor", str(p.vendor)],
    ];
    if (p.description) meta.push(["Description", str(p.description)]);
    for (const [label, value] of meta) {
      const labelCell = ws.getCell(r, 1);
      labelCell.value = label;
      labelCell.font = { name: "Calibri", size: 9, bold: true, color: { argb: INK_SOFT } };
      labelCell.alignment = { vertical: "top" };
      ws.mergeCells(r, 2, r, 5);
      const valCell = ws.getCell(r, 2);
      valCell.value = value;
      valCell.font = { name: "Calibri", size: 10, color: { argb: INK } };
      valCell.alignment = { vertical: "top", wrapText: true };
      r += 1;
    }

    // Milestones mini-table
    const milestones = arr(p.milestones);
    if (milestones.length) {
      r += 1;
      const head = ["Milestone", "", "Due", "Completed", "Status"];
      head.forEach((h, i) => {
        const cell = ws.getCell(r, i + 1);
        cell.value = h;
        cell.fill = solidFill("FF2A3244");
        cell.font = { name: "Calibri", size: 9, bold: true, color: { argb: WHITE } };
        cell.border = thinBorder("FF3A4356");
      });
      ws.mergeCells(r, 1, r, 2);
      r += 1;
      for (const m of milestones) {
        if (!m || typeof m !== "object") continue;
        ws.mergeCells(r, 1, r, 2);
        const cells = [
          [1, str(m.name, "")],
          [3, fmtDate(m.dueDate)],
          [4, m.completedDate ? fmtDate(m.completedDate) : "—"],
          [5, str(m.status, "")],
        ];
        for (const [c, v] of cells) {
          const cell = ws.getCell(r, c);
          cell.value = v;
          cell.font = { name: "Calibri", size: 9, color: { argb: INK } };
          cell.border = thinBorder("FFE4E0D4");
        }
        if (String(m.status) === "Overdue") {
          ws.getCell(r, 5).font = { name: "Calibri", size: 9, bold: true, color: { argb: SEVERITY_INK.critical } };
        }
        r += 1;
      }
    }
    r += 2; // gap before next project
  }
}

/** Charts sheet: embed captured PNGs in a 2-column grid. */
function buildChartsSheet(wb, payload) {
  const images = arr(payload.images).filter((im) => im && im.dataUrl);
  if (!images.length) return;

  const ws = wb.addWorksheet("Charts");
  ws.getCell("A1").value = "Captured dashboard charts";
  ws.getCell("A1").font = { name: "Calibri", size: 12, bold: true, color: { argb: INK } };

  const IMG_W = 560;
  const IMG_H = 315; // 16:9 at 560 wide
  const COLS_PER_SLOT = 9;
  const ROWS_PER_SLOT = 18;

  images.forEach((img, i) => {
    try {
      const imageId = wb.addImage({
        base64: base64FromDataUrl(img.dataUrl),
        extension: "png",
      });
      const gridCol = i % 2;
      const gridRow = Math.floor(i / 2);
      const anchorCol = gridCol * COLS_PER_SLOT;
      const anchorRow = 2 + gridRow * ROWS_PER_SLOT;

      const label = ws.getCell(anchorRow + 1, anchorCol + 1);
      label.value = str(img.id, `chart-${i + 1}`);
      label.font = { name: "Calibri", size: 9, bold: true, color: { argb: INK_SOFT } };

      ws.addImage(imageId, {
        tl: { col: anchorCol, row: anchorRow + 1 },
        ext: { width: IMG_W, height: IMG_H },
        editAs: "oneCell",
      });
    } catch {
      // A corrupt image must never break the export — skip it.
    }
  });
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the executive Excel briefing workbook.
 *
 * @param {object} payload SPEC §6 export payload:
 *   `{summary, projects, detailProjects, meta, images, theme, generatedBy, asOf}`.
 *   Every field is optional; missing or empty data produces a valid,
 *   gracefully annotated workbook.
 * @returns {Promise<Buffer>} XLSX file contents.
 */
export async function buildExcel(payload) {
  const safe = payload && typeof payload === "object" ? payload : {};

  const wb = new ExcelJS.Workbook();
  wb.creator = str(safe.generatedBy, "GCIO Project Intelligence");
  wb.created = new Date();
  wb.modified = new Date();

  buildExecutiveSummarySheet(wb, safe);
  buildSuccessesSheet(wb, safe);
  buildQRISheet(wb, safe);
  buildPrioritiesSheet(wb, safe);
  buildRoadmapSheet(wb, safe);
  buildPostureSheet(wb, safe);
  buildPortfolioSheet(wb, safe);
  buildProjectsDetailSheet(wb, safe);
  buildChartsSheet(wb, safe);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}
