/**
 * server/exporters/word.js — Word briefing exporter (docx v9).
 *
 * buildWord(payload) -> Promise<Buffer>
 * Payload contract (SPEC §6):
 *   { summary, projects, detailProjects, meta, images, theme, generatedBy, asOf }
 *
 * Document: cover page, Executive Summary (headline, bullets, wins/watch-list,
 * outlook), KPI table, Attention table, per-detail-project brief pages, and
 * embedded chart images when provided.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

/* ------------------------------------------------------------------ */
/* Brand constants                                                     */
/* ------------------------------------------------------------------ */

const NAVY = "101828";
const GOLD = "B08D3E";
const INK_SOFT = "5A574F";
const WHITE = "FFFFFF";
const SEVERITY_COLOR = { critical: "D03B3B", serious: "EC835A", warning: "9A6E00" };
const RAG_COLOR = { Green: "0CA30C", Amber: "9A6E00", Red: "D03B3B" };

const IMG_WIDTH = 600;
const IMG_HEIGHT = Math.round((IMG_WIDTH * 9) / 16); // 16:9 assumption -> 338

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

/**
 * Change text for a section item, or "" when the item did not move (or the
 * store keeps no history). Unlike pptx.js this exporter does not measure
 * text, so the full headline the web page shows is fine here too. Never
 * mutate `change` itself — the same object is shared across every section
 * that names this project.
 */
function changeText(change) {
  if (!change) return "";
  if (change.trackedSince) return ` (new since ${fmtDate(change.trackedSince)})`;
  const arrow = change.worst === "worse" ? "▲" : change.worst === "better" ? "▼" : "•";
  return ` (${arrow} ${str(change.headline, "")})`;
}

/**
 * The client's honest-cold-start line: a briefing with no change markers must
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

/** Decode the base64 body of a data URL into a Buffer, or null on failure. */
function bufferFromDataUrl(dataUrl) {
  try {
    const s = String(dataUrl || "");
    const idx = s.indexOf("base64,");
    const b64 = idx >= 0 ? s.slice(idx + 7) : s;
    if (!b64) return null;
    const buf = Buffer.from(b64, "base64");
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

/** Gold accent rule: an empty paragraph with a gold bottom border. */
function goldRule() {
  return new Paragraph({
    spacing: { before: 60, after: 160 },
    border: {
      bottom: { style: BorderStyle.SINGLE, color: GOLD, size: 8, space: 1 },
    },
  });
}

/** Body paragraph (11pt). */
function body(text, opts = {}) {
  return new Paragraph({
    spacing: { after: opts.after ?? 120 },
    alignment: opts.align,
    bullet: opts.bullet ? { level: 0 } : undefined,
    children: [
      new TextRun({
        text: String(text),
        bold: !!opts.bold,
        italics: !!opts.italic,
        color: opts.color || undefined,
        size: opts.size || 22, // half-points: 22 = 11pt
      }),
    ],
  });
}

/** Uppercase micro section label in gold. */
function sectionLabel(text) {
  return new Paragraph({
    spacing: { before: 240, after: 40 },
    children: [
      new TextRun({ text: String(text).toUpperCase(), bold: true, color: GOLD, size: 18 }),
    ],
  });
}

/** Navy heading paragraph. */
function heading(text, level = HeadingLevel.HEADING_1, size = 32) {
  return new Paragraph({
    heading: level,
    spacing: { before: 240, after: 80 },
    children: [new TextRun({ text: String(text), bold: true, color: NAVY, size })],
  });
}

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: "D8D3C4" };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };

/** Table cell with sane defaults. */
function cell(text, opts = {}) {
  return new TableCell({
    borders: CELL_BORDERS,
    shading: opts.fill ? { fill: opts.fill } : undefined,
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [
      new Paragraph({
        spacing: { after: 0 },
        children: [
          new TextRun({
            text: String(text),
            bold: !!opts.bold,
            color: opts.color || undefined,
            size: opts.size || 20,
          }),
        ],
      }),
    ],
  });
}

/** Header row cell: navy fill, white bold. */
function headCell(text, width) {
  return cell(text, { fill: NAVY, color: WHITE, bold: true, width });
}

/** Full-width table from rows. */
function fullTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows,
  });
}

/* ------------------------------------------------------------------ */
/* Document sections                                                   */
/* ------------------------------------------------------------------ */

/** Cover page children. */
function coverPage(payload) {
  const summary = payload.summary || {};
  const period = str(summary.period, "portfolio");
  const noHistory = noHistoryLine(summary);
  return [
    new Paragraph({ spacing: { before: 2400, after: 0 }, children: [] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: "GCIO Portfolio Brief", bold: true, color: NAVY, size: 72 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      border: { bottom: { style: BorderStyle.SINGLE, color: GOLD, size: 12, space: 8 } },
      children: [
        new TextRun({
          text: `${period.toUpperCase()} EXECUTIVE BRIEFING`,
          bold: true,
          color: GOLD,
          size: 26,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 60 },
      children: [
        new TextRun({
          text: `Period: ${fmtDate(summary.rangeStart)} — ${fmtDate(summary.rangeEnd)}`,
          color: INK_SOFT,
          size: 24,
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: `Generated ${fmtDate(summary.generatedAt || payload.asOf)} · As of ${fmtDate(payload.asOf)}`,
          color: INK_SOFT,
          size: 22,
        }),
      ],
    }),
    ...(noHistory ? [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 60 },
        children: [
          new TextRun({ text: noHistory, italics: true, color: INK_SOFT, size: 20 }),
        ],
      }),
    ] : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 0 },
      children: [
        new TextRun({
          text: str(payload.generatedBy, "GCIO Project Intelligence"),
          italics: true,
          color: INK_SOFT,
          size: 20,
        }),
      ],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

/** Executive Summary section children. */
function executiveSummary(payload) {
  const narrative = (payload.summary && payload.summary.narrative) || {};
  const out = [heading("Executive Summary", HeadingLevel.HEADING_1, 36), goldRule()];

  if (narrative.headline) out.push(body(str(narrative.headline), { bold: true, size: 26, after: 200 }));

  const bullets = arr(narrative.bullets);
  for (const b of bullets) out.push(body(str(b), { bullet: true, after: 80 }));

  const wins = arr(narrative.wins);
  if (wins.length) {
    out.push(sectionLabel("Wins"));
    for (const w of wins) out.push(body(str(w), { bullet: true, after: 60 }));
  }
  const watch = arr(narrative.risks);
  if (watch.length) {
    out.push(sectionLabel("Watch-list"));
    for (const r of watch) out.push(body(str(r), { bullet: true, after: 60 }));
  }
  if (narrative.outlook) {
    out.push(sectionLabel("Outlook"));
    out.push(body(str(narrative.outlook)));
  }
  if (!narrative.headline && !bullets.length && !wins.length && !watch.length && !narrative.outlook) {
    out.push(body("No narrative available for this period — the portfolio contains no matching data.", { italic: true }));
  }
  return out;
}

/* ---------------------------------------------------------------------------
   The four CIO sections, in order: Successes, then Questions/Risks/Issues,
   then Priorities, then Roadmap. Mirrors the dashboard exactly.
   ------------------------------------------------------------------------ */

const SECTIONS_OF = (payload) => ((payload.summary && payload.summary.sections) || {});

/** Numbered section heading, e.g. "1 · Successes". */
function cioHeading(n, title) {
  return heading(`${n} · ${title}`, HeadingLevel.HEADING_1, 34);
}

function successesSection(payload) {
  const sec = SECTIONS_OF(payload).successes;
  const out = [cioHeading(1, "Successes"), goldRule()];
  if (!sec) {
    out.push(body("No section data available for this period.", { italic: true }));
    return out;
  }
  if (sec.headline) out.push(body(str(sec.headline), { bold: true, size: 24, after: 180 }));

  const delivered = arr(sec.delivered);
  if (delivered.length) {
    out.push(sectionLabel("Delivered this period"));
    out.push(fullTable([
      new TableRow({ children: [headCell("Project", 34), headCell("Closed", 14), headCell("Budget outcome", 38), headCell("Department", 14)] }),
      ...delivered.map((d) => new TableRow({
        children: [
          cell(str(d.name, "") + changeText(d.change), { bold: true }),
          cell(fmtDate(d.completedOn)),
          cell(str(d.note, "")),
          cell(str(d.department, "")),
        ],
      })),
    ]));
  } else {
    out.push(body("No projects closed inside this window.", { italic: true }));
  }

  const milestones = arr(sec.milestones);
  if (milestones.length) {
    out.push(sectionLabel("Milestones completed"));
    for (const m of milestones) {
      out.push(body(`${str(m.name, "")} — ${str(m.project, "")}${changeText(m.change)} (${fmtDate(m.completedOn)})`, { bullet: true, after: 60 }));
    }
  }

  const near = arr(sec.nearComplete);
  if (near.length) {
    out.push(sectionLabel("On final approach (90% or more)"));
    for (const n of near) {
      out.push(body(`${str(n.name, "")}${changeText(n.change)} — ${Math.round(num(n.percentComplete))}% complete, ${str(n.note, "")}`, { bullet: true, after: 60 }));
    }
  }
  return out;
}

function qriSection(payload) {
  const sec = SECTIONS_OF(payload).qri;
  const out = [cioHeading(2, "Questions, Risks & Issues"), goldRule()];
  if (!sec) {
    out.push(body("No section data available for this period.", { italic: true }));
    return out;
  }
  const counts = sec.counts || {};
  out.push(body(
    `${num(counts.questions)} open questions (${num(counts.questionsCritical)} needing a decision now) · ` +
    `${num(counts.risks)} open risks (${num(counts.risksCritical)} critical) · ${num(counts.issues)} live issues.`,
    { bold: true, after: 180 }
  ));

  out.push(sectionLabel("Questions — decisions awaiting the CIO"));
  const questions = arr(sec.questions);
  if (questions.length) {
    out.push(fullTable([
      new TableRow({ children: [headCell("Urgency", 12), headCell("Question", 48), headCell("Project", 22), headCell("Needed by", 18)] }),
      ...questions.map((q) => new TableRow({
        children: [
          cell(q.severity === "critical" ? "Decision now" : "Decision soon", {
            bold: true,
            color: q.severity === "critical" ? "C0392B" : "B07900",
          }),
          cell(`${str(q.text, "")}\n${str(q.because, "")}${q.source === "workbook" ? " (raised by the PM)" : " (derived)"}`),
          cell(str(q.project, "") + changeText(q.change)),
          cell(q.neededBy ? fmtDate(q.neededBy) : "—"),
        ],
      })),
    ]));
  } else {
    out.push(body("Nothing is waiting on an executive decision.", { italic: true }));
  }

  out.push(sectionLabel("Open risks — severity ranked"));
  const risks = arr(sec.risks).slice(0, 15);
  if (risks.length) {
    out.push(fullTable([
      new TableRow({ children: [headCell("Severity", 12), headCell("Risk", 38), headCell("Project", 24), headCell("Owner", 14), headCell("Status", 12)] }),
      ...risks.map((r) => new TableRow({
        children: [
          cell(str(r.severity, ""), { bold: true, color: r.severity === "Critical" ? "C0392B" : undefined }),
          cell(str(r.title, "")),
          cell(str(r.project, "") + changeText(r.change)),
          cell(str(r.owner, "—")),
          cell(str(r.status, "")),
        ],
      })),
    ]));
  } else {
    out.push(body("No open risks recorded.", { italic: true }));
  }

  out.push(sectionLabel("Issues — already materialised"));
  const issues = arr(sec.issues).slice(0, 15);
  if (issues.length) {
    out.push(fullTable([
      new TableRow({ children: [headCell("Project", 28), headCell("Issue", 46), headCell("Type", 14), headCell("Health", 12)] }),
      ...issues.map((i) => new TableRow({
        children: [
          cell(str(i.project, ""), { bold: true }),
          cell(str(i.text, "")),
          cell(str(i.type, "")),
          cell(str(i.health, ""), { color: i.health === "Red" ? "C0392B" : i.health === "Amber" ? "B07900" : "0CA30C" }),
        ],
      })),
    ]));
  } else {
    out.push(body("Nothing is overdue, overrun or held.", { italic: true }));
  }
  return out;
}

function prioritiesSection(payload) {
  const sec = SECTIONS_OF(payload).priorities;
  const out = [cioHeading(3, "Priorities"), goldRule()];
  const items = arr(sec && sec.items);
  if (!items.length) {
    out.push(body("Nothing is active in this period.", { italic: true }));
    return out;
  }
  out.push(body("Ranked by priority, health, schedule, risk, spend and dependency weight.", { italic: true, after: 180 }));
  items.forEach((p, i) => {
    out.push(body(`${i + 1}.  ${str(p.name, "")}${changeText(p.change)}  —  urgency ${num(p.score)}`, { bold: true, size: 24, after: 60 }));
    out.push(body(`${str(p.health, "")} · ${str(p.priority, "")} priority · ${str(p.owner, "no owner")} · ${str(p.department, "")}`, { size: 18, after: 40 }));
    out.push(body(str(p.why, ""), { after: 40 }));
    out.push(body(`Needed: ${str(p.ask, "")}`, { bold: true, after: 160 }));
  });
  return out;
}

function roadmapSection(payload) {
  const sec = SECTIONS_OF(payload).roadmap;
  const out = [cioHeading(4, "Roadmap / Planned Projects"), goldRule()];
  if (!sec) {
    out.push(body("No section data available for this period.", { italic: true }));
    return out;
  }
  out.push(body(`Horizon ${fmtDate(sec.horizonStart)} — ${fmtDate(sec.horizonEnd)}.`, { italic: true, after: 160 }));

  const inFlight = arr(sec.inFlight);
  out.push(sectionLabel("In flight — forecast against target"));
  if (inFlight.length) {
    out.push(fullTable([
      new TableRow({ children: [headCell("Project", 34), headCell("Owner", 16), headCell("Complete", 12), headCell("Target", 13), headCell("Forecast", 13), headCell("Slip", 12)] }),
      ...inFlight.map((p) => new TableRow({
        children: [
          cell(str(p.name, "") + changeText(p.change), { bold: true }),
          cell(str(p.owner, "—")),
          cell(`${Math.round(num(p.percentComplete))}%`),
          cell(fmtDate(p.targetEndDate)),
          cell(fmtDate(p.forecastEnd)),
          cell(num(p.slipDays) > 0 ? `+${num(p.slipDays)} days` : "on plan", { color: num(p.slipDays) > 0 ? "B07900" : "0CA30C" }),
        ],
      })),
    ]));
  } else {
    out.push(body("Nothing is in flight.", { italic: true }));
  }

  const pipeline = arr(sec.pipeline);
  out.push(sectionLabel("Planned pipeline — proposed & approved"));
  if (pipeline.length) {
    out.push(fullTable([
      new TableRow({ children: [headCell("Project", 36), headCell("Status", 14), headCell("Starts", 16), headCell("Budget", 18), headCell("Readiness", 16)] }),
      ...pipeline.map((p) => new TableRow({
        children: [
          cell(str(p.name, "") + changeText(p.change), { bold: true }),
          cell(str(p.status, "")),
          cell(fmtDate(p.startDate)),
          cell(fmtMoney(p.budget)),
          cell(str(p.readiness, "")),
        ],
      })),
    ]));
  } else {
    out.push(body("No proposed or approved projects waiting to start.", { italic: true }));
  }

  const milestones = arr(sec.upcomingMilestones);
  if (milestones.length) {
    out.push(sectionLabel("Milestones falling due"));
    for (const m of milestones) {
      out.push(body(`${str(m.name, "")} — ${str(m.project, "")}${changeText(m.change)} (${fmtDate(m.dueDate)})`, { bullet: true, after: 60 }));
    }
  }
  return out;
}

function postureSection(payload) {
  const sec = SECTIONS_OF(payload).posture;
  if (!sec || !sec.available) return [];

  const out = [cioHeading(5, "Security Posture"), goldRule()];
  out.push(body(str(sec.headline, ""), { bold: true, size: 24, after: 160 }));
  const counts = sec.counts || {};
  out.push(body(
    `${Math.round(num(sec.overallScore))}% overall maturity against a ${Math.round(num(sec.targetScore))}% target · `
    + `${num(counts.nonCompliant)} non-compliant · ${num(counts.criticalFindings)} critical findings · `
    + `${num(counts.reviewsOverdue)} assessments overdue.`,
    { after: 180 }
  ));

  const domains = arr(sec.domains);
  if (domains.length) {
    out.push(fullTable([
      new TableRow({ children: [
        headCell("Domain", 30), headCell("Status", 14), headCell("Score", 10),
        headCell("Target", 10), headCell("Findings", 12), headCell("Owner", 14), headCell("Next review", 10),
      ] }),
      ...domains.map((d) => new TableRow({
        children: [
          cell((d.control ? `${str(d.domain, "")} — ${d.control}` : str(d.domain, "")) + changeText(d.change), { bold: true }),
          cell(str(d.status, ""), {
            color: d.status === "Non-Compliant" ? "C0392B" : d.status === "Partial" ? "B07900"
              : d.status === "Compliant" ? "0CA30C" : undefined,
          }),
          cell(d.status === "Not Assessed" ? "—" : `${Math.round(num(d.score))}%`),
          cell(`${Math.round(num(d.target))}%`),
          cell(`${num(d.openFindings)}${num(d.criticalFindings) ? ` (${num(d.criticalFindings)} crit)` : ""}`),
          cell(str(d.owner, "—")),
          cell(`${fmtDate(d.nextReview)}${d.reviewOverdue ? " — overdue" : ""}`),
        ],
      })),
    ]));
  }

  const remediation = arr(sec.remediation);
  if (remediation.length) {
    out.push(sectionLabel("Funded remediation"));
    for (const r of remediation) {
      out.push(body(
        `${str(r.domain, "")} — ${str(r.project?.name, "")} (${str(r.project?.health, "")}, ${Math.round(num(r.project?.percentComplete))}% complete)`,
        { bullet: true, after: 60 }
      ));
    }
  }
  return out;
}

/**
 * Documents — the imported source files and the sentences pulled out of them.
 *
 * Absent or unavailable renders nothing at all, exactly as postureSection does
 * above: a briefing for a portfolio with no imported documents should not
 * carry an empty chapter about them.
 *
 * Two contract details shape what is printed:
 *   - `pageCount` and a sentence's `page` are null for Word, text and Markdown,
 *     which have no pages until something renders them. A page is cited only
 *     when there genuinely is one — "page null", or a coerced "page 0", would
 *     be a fabricated citation in a document people forward.
 *   - `summary` can be empty while `warnings` is not (a scanned PDF with no
 *     text layer). That document still gets its heading and its warning; it
 *     must not silently vanish into "nothing was imported".
 *
 * The label over the sentences is "Extracted from the document", never
 * "Summary" — these are the document's own words, selected, not written.
 */
function documentsSection(payload) {
  const sec = SECTIONS_OF(payload).documents;
  if (!sec || !sec.available) return [];

  const paged = (v) => v !== null && v !== undefined && v !== "";
  const out = [cioHeading(6, "Documents"), goldRule()];
  out.push(body(str(sec.headline, ""), { bold: true, size: 24, after: 160 }));

  for (const d of arr(sec.documents)) {
    if (!d || typeof d !== "object") continue;
    out.push(heading(str(d.title, "Untitled document"), HeadingLevel.HEADING_2, 26));

    const pages = paged(d.pageCount)
      ? ` · ${num(d.pageCount)} page${num(d.pageCount) === 1 ? "" : "s"}`
      : "";
    out.push(body(
      `${str(d.fileName, "")} · ${str(d.kind, "")}${pages} · ${num(d.wordCount)} words · imported ${fmtDate(d.extractedAt)}`,
      { color: INK_SOFT, size: 18, after: 100 }
    ));

    for (const w of arr(d.warnings)) {
      out.push(body(str(w, ""), { bullet: true, italic: true, color: SEVERITY_COLOR.warning, after: 60 }));
    }

    const summary = arr(d.summary);
    if (summary.length) {
      /* Gold and bold like sectionLabel above, but deliberately NOT routed
         through it: sectionLabel uppercases, and this heading is a claim
         about where the sentences came from, meant to be read as the
         sentence it is rather than as chrome. */
      out.push(body("Extracted from the document", { bold: true, color: GOLD, size: 18, after: 60 }));
      for (const s of summary) {
        out.push(body(`“${str(s.text, "")}”`, { italic: true, after: 20 }));
        /* Provenance is its own paragraph rather than a suffix on the quote:
           it is the citation, not part of what the document said. */
        out.push(body(
          `— ${str(s.heading, "document")}${paged(s.page) ? `, page ${num(s.page)}` : ""}`,
          { color: INK_SOFT, size: 18, after: 120 }
        ));
      }
    }

    const refs = arr(d.projectRefs);
    if (refs.length) {
      out.push(body(`Mentions: ${refs.join(", ")} (reported, not linked)`, { size: 18, after: 160 }));
    }
  }
  return out;
}

/** KPI 2-column table. */
function kpiSection(payload) {
  const kpis = (payload.summary && payload.summary.kpis) || {};
  const health = kpis.health || {};
  const pairs = [
    ["Total Projects", String(num(kpis.totalProjects))],
    ["Active Projects", String(num(kpis.active))],
    ["Completed (Period)", String(num(kpis.completedInPeriod))],
    ["Approved (Period)", String(num(kpis.approvedInPeriod))],
    ["Started (Period)", String(num(kpis.startedInPeriod))],
    ["On Hold", String(num(kpis.onHold))],
    ["Overdue Projects", String(num(kpis.overdue))],
    ["Milestones Due / Overdue", `${num(kpis.milestonesDueInPeriod)} / ${num(kpis.milestonesOverdue)}`],
    ["Budget Total", fmtMoney(kpis.budgetTotal)],
    ["Spent Total", fmtMoney(kpis.spentTotal)],
    ["Budget Utilization", `${num(kpis.budgetUtilizationPct).toFixed(1)}%`],
    ["Avg Completion (Active)", `${num(kpis.avgCompletion).toFixed(1)}%`],
    ["Health (G / A / R)", `${num(health.green)} / ${num(health.amber)} / ${num(health.red)}`],
    ["Open Risks (Critical)", `${num(kpis.openRisks)} (${num(kpis.criticalRisks)})`],
  ];
  const rows = [
    new TableRow({ children: [headCell("Indicator", 55), headCell("Value", 45)] }),
    ...pairs.map(
      ([label, value]) =>
        new TableRow({ children: [cell(label, { width: 55 }), cell(value, { width: 45, bold: true })] })
    ),
  ];
  return [heading("Key Performance Indicators", HeadingLevel.HEADING_2, 28), goldRule(), fullTable(rows)];
}

/** Attention table. */
function attentionSection(payload) {
  const items = arr(payload.summary && payload.summary.attention);
  const out = [heading("Needs Executive Attention", HeadingLevel.HEADING_2, 28), goldRule()];
  if (!items.length) {
    out.push(body("No items need executive attention in this period.", { italic: true }));
    return out;
  }
  const rows = [
    new TableRow({
      children: [headCell("Severity", 14), headCell("ID", 12), headCell("Project", 30), headCell("Reason", 44)],
    }),
  ];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const sev = String(it.severity || "warning").toLowerCase();
    rows.push(
      new TableRow({
        children: [
          cell(sev.toUpperCase(), { width: 14, bold: true, color: SEVERITY_COLOR[sev] || NAVY }),
          cell(str(it.id, ""), { width: 12 }),
          cell(str(it.name, ""), { width: 30 }),
          cell(str(it.reason, ""), { width: 44 }),
        ],
      })
    );
  }
  out.push(fullTable(rows));
  return out;
}

/** Embedded chart images (when provided). */
function chartsSection(payload) {
  const images = arr(payload.images).filter((im) => im && im.dataUrl);
  if (!images.length) return [];
  const out = [heading("Portfolio Charts", HeadingLevel.HEADING_2, 28), goldRule()];
  for (const img of images) {
    const data = bufferFromDataUrl(img.dataUrl);
    if (!data) continue;
    try {
      out.push(
        body(str(img.id, "chart"), { bold: true, color: INK_SOFT, size: 18, after: 40 }),
        new Paragraph({
          spacing: { after: 240 },
          children: [
            new ImageRun({
              type: "png",
              data,
              transformation: { width: IMG_WIDTH, height: IMG_HEIGHT },
            }),
          ],
        })
      );
    } catch {
      // A corrupt image must never break the export — skip it.
    }
  }
  return out;
}

/** One brief page per detail project. */
function projectBriefPages(payload) {
  const details = arr(payload.detailProjects);
  const out = [];
  for (const p of details) {
    if (!p || typeof p !== "object") continue;
    out.push(new Paragraph({ children: [new PageBreak()] }));
    out.push(heading(`${str(p.id, "")} · ${str(p.name, "Untitled project")}`, HeadingLevel.HEADING_2, 30));
    out.push(goldRule());
    out.push(
      body(
        `${str(p.status)} · ${str(p.health)} health · ${str(p.priority)} priority · ${str(p.phase)} phase`,
        { color: RAG_COLOR[String(p.health)] || INK_SOFT, bold: true, size: 20, after: 160 }
      )
    );
    if (p.description) out.push(body(str(p.description), { after: 160 }));

    const metaPairs = [
      ["Owner", str(p.owner)],
      ["Sponsor", str(p.sponsor)],
      ["Department", str(p.department)],
      ["Pillar", str(p.pillar)],
      ["Program", str(p.program)],
      ["Vendor", str(p.vendor)],
      ["Approval Date", fmtDate(p.approvalDate)],
      ["Start Date", fmtDate(p.startDate)],
      ["Target End", fmtDate(p.targetEndDate)],
      ["Actual End", p.actualEndDate ? fmtDate(p.actualEndDate) : "—"],
      ["Budget", fmtMoney(p.budget)],
      ["Spent", fmtMoney(p.spent)],
      ["% Complete", `${num(p.percentComplete).toFixed(0)}%`],
    ];
    out.push(
      fullTable(
        metaPairs.map(
          ([label, value]) =>
            new TableRow({
              children: [cell(label, { width: 35, fill: "F3F2ED", bold: true }), cell(value, { width: 65 })],
            })
        )
      )
    );

    const milestones = arr(p.milestones);
    if (milestones.length) {
      out.push(sectionLabel("Milestones"));
      const rows = [
        new TableRow({
          children: [headCell("Milestone", 44), headCell("Due", 18), headCell("Completed", 18), headCell("Status", 20)],
        }),
      ];
      for (const m of milestones) {
        if (!m || typeof m !== "object") continue;
        const overdue = String(m.status) === "Overdue";
        rows.push(
          new TableRow({
            children: [
              cell(str(m.name, ""), { width: 44 }),
              cell(fmtDate(m.dueDate), { width: 18 }),
              cell(m.completedDate ? fmtDate(m.completedDate) : "—", { width: 18 }),
              cell(str(m.status, ""), {
                width: 20,
                bold: overdue,
                color: overdue ? SEVERITY_COLOR.critical : undefined,
              }),
            ],
          })
        );
      }
      out.push(fullTable(rows));
    }

    const updates = arr(p.updates);
    if (updates.length) {
      const latest = updates
        .slice()
        .sort((a, b) => String((b && b.date) || "").localeCompare(String((a && a.date) || "")))[0];
      if (latest) {
        out.push(sectionLabel("Latest Update"));
        out.push(
          body(`${fmtDate(latest.date)} — ${str(latest.author, "Unknown")}`, {
            bold: true,
            color: INK_SOFT,
            size: 20,
            after: 40,
          })
        );
        out.push(body(str(latest.text, "")));
      }
    }

    const risks = arr(p.risks);
    if (risks.length) {
      out.push(sectionLabel("Risks"));
      const rows = [
        new TableRow({
          children: [headCell("Risk", 46), headCell("Severity", 18), headCell("Status", 18), headCell("Owner", 18)],
        }),
      ];
      for (const r of risks) {
        if (!r || typeof r !== "object") continue;
        const sev = String(r.severity || "");
        rows.push(
          new TableRow({
            children: [
              cell(str(r.title, ""), { width: 46 }),
              cell(sev || "—", {
                width: 18,
                bold: sev === "Critical" || sev === "High",
                color: sev === "Critical" ? SEVERITY_COLOR.critical : sev === "High" ? SEVERITY_COLOR.serious : undefined,
              }),
              cell(str(r.status, ""), { width: 18 }),
              cell(str(r.owner, ""), { width: 18 }),
            ],
          })
        );
      }
      out.push(fullTable(rows));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build the executive Word briefing document.
 *
 * @param {object} payload SPEC §6 export payload:
 *   `{summary, projects, detailProjects, meta, images, theme, generatedBy, asOf}`.
 *   Every field is optional; missing or empty data produces a valid,
 *   gracefully annotated document.
 * @returns {Promise<Buffer>} DOCX file contents.
 */
export async function buildWord(payload) {
  const safe = payload && typeof payload === "object" ? payload : {};

  const children = [
    ...coverPage(safe),
    ...kpiSection(safe),
    ...successesSection(safe),
    ...qriSection(safe),
    ...prioritiesSection(safe),
    ...roadmapSection(safe),
    ...postureSection(safe),
    ...documentsSection(safe),
    ...chartsSection(safe),
    ...projectBriefPages(safe),
  ];

  const doc = new Document({
    creator: str(safe.generatedBy, "GCIO Project Intelligence"),
    title: "GCIO Portfolio Brief",
    description: "Executive portfolio briefing generated by GCIO Project Intelligence.",
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22, color: "14120E" }, // 11pt body
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1080, bottom: 1080, left: 1180, right: 1180 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                border: { top: { style: BorderStyle.SINGLE, color: GOLD, size: 4, space: 4 } },
                children: [
                  new TextRun({
                    text: "CONFIDENTIAL — Executive Briefing",
                    bold: true,
                    color: INK_SOFT,
                    size: 16,
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
