/**
 * PowerPoint export — the same four CIO sections, one deck.
 * Uses the dependency-free writer in shared/pptx-lite.mjs, which is also the
 * engine behind the browser's one-click PPT button, so both routes produce
 * byte-identical decks for the same payload.
 */
import { buildPptx } from "../../shared/pptx-lite.mjs";
import { fmtMoney, fmtDate } from "../format.js";

const PERIOD_TITLE = {
  daily: "Daily Executive Summary",
  weekly: "Weekly Executive Summary",
  monthly: "Monthly Executive Summary",
  yearly: "Annual Executive Summary",
};

const range = (s) => (s.rangeStart === s.rangeEnd ? fmtDate(s.rangeStart) : `${fmtDate(s.rangeStart)} — ${fmtDate(s.rangeEnd)}`);
/* The writer wraps and measures text, so these caps only exist to stop one
   pathological row from eating a whole slide — they are deliberately loose. */
const clip = (text, n = 150) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));
/* A page number that is genuinely there. Documents with no page concept carry
   null, and 0 is never a real page — printing either is a false citation. */
const paged = (v) => v !== null && v !== undefined && v !== "";

/**
 * Compact change marker. The writer re-measures whatever text it is given, so
 * appending to a bullet is safe on its own — the real reason to stay short
 * here is that the deck is already dense. The web page can afford the full
 * headline ("▲ health Green to Red"); the deck says "▲ Red" instead. Never
 * mutate `change` itself — the same object is shared across every section
 * that names this project.
 */
function changeMark(change) {
  if (!change) return "";
  if (change.trackedSince) return "";
  const arrow = change.worst === "worse" ? "▲" : change.worst === "better" ? "▼" : "•";
  const f = change.fields || {};
  if (f.health) return ` ${arrow} ${f.health.to}`;
  if (f.status) return ` ${arrow} ${f.status.to}`;
  if (f.targetEndDate?.days !== undefined) return ` ${arrow} ${f.targetEndDate.days > 0 ? "+" : ""}${f.targetEndDate.days}d`;
  return ` ${arrow} ${clip(change.headline, 22)}`;
}

/**
 * The client's honest-cold-start line: a deck with no change markers must say
 * why, because it gets emailed onward and read with nobody present to explain
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

/**
 * @param {{summary: object, meta: object}} payload
 * @returns {Uint8Array} .pptx bytes
 */
export function buildPptxDeck(payload) {
  const { summary, meta = {} } = payload;
  const { kpis, sections } = summary;
  const { successes, qri, priorities, roadmap, posture, documents } = sections;

  const slides = [];

  const coverSubtitle = `${range(summary)} · ${kpis.totalProjects} projects · ${fmtMoney(kpis.budgetTotal)} committed${meta.demoMode ? " · demonstration portfolio" : ""}`;
  const noHistory = noHistoryLine(summary);

  slides.push({
    cover: true,
    eyebrow: "GCIO · PROJECT INTELLIGENCE",
    title: PERIOD_TITLE[summary.period] || "Executive Summary",
    subtitle: noHistory ? `${coverSubtitle}\n${noHistory}` : coverSubtitle,
    kpis: [
      { lab: "Portfolio", val: String(kpis.totalProjects), sub: `${kpis.active} active` },
      { lab: "Healthy", val: `${kpis.totalProjects ? Math.round((kpis.health.green / kpis.totalProjects) * 100) : 0}%`, sub: `${kpis.health.green} green · ${kpis.health.red} red` },
      { lab: "Committed", val: fmtMoney(kpis.budgetTotal), sub: `${Math.round(kpis.budgetUtilizationPct)}% consumed` },
      { lab: "Overdue", val: String(kpis.overdue), sub: `${kpis.milestonesOverdue} milestones` },
    ],
  });

  /* 1 — Successes */
  const successBullets = [
    ...successes.delivered.slice(0, 5).map((d) => ({
      tag: "Delivered", tone: "good", text: clip(d.name) + changeMark(d.change), sub: `${fmtDate(d.completedOn)} · ${d.note}`,
    })),
    ...successes.milestones.slice(0, 3).map((m) => ({
      tag: "Milestone", tone: "info", text: clip(m.name), sub: `${clip(m.project, 70)} · ${fmtDate(m.completedOn)}`,
    })),
    ...successes.nearComplete.slice(0, 2).map((n) => ({
      tag: "90%+", tone: "plum", text: clip(n.name), sub: `${Math.round(n.percentComplete)}% complete — ${n.note}`,
    })),
  ];
  slides.push({
    eyebrow: "Section 1",
    title: "Successes",
    kpis: [
      { lab: "Delivered", val: String(successes.delivered.length) },
      { lab: "Milestones closed", val: String(successes.milestones.length) },
      { lab: "Returned to budget", val: successes.savings > 0 ? fmtMoney(successes.savings) : "—" },
    ],
    bullets: successBullets.length ? successBullets : [{ tag: "None", tone: "neutral", text: successes.headline }],
    note: successes.headline,
  });

  /* 2 — Questions, Risks & Issues */
  slides.push({
    eyebrow: "Section 2 · part 1",
    title: "Questions — decisions awaiting the CIO",
    dense: true,
    kpis: [
      { lab: "Open questions", val: String(qri.counts.questions) },
      { lab: "Need a decision now", val: String(qri.counts.questionsCritical) },
      { lab: "Raised by PMs", val: String(qri.counts.questionsFromWorkbook) },
    ],
    bullets: qri.questions.slice(0, 6).map((q) => ({
      tag: q.severity === "critical" ? "Decision now" : "Decision soon",
      tone: q.severity === "critical" ? "bad" : "warn",
      text: clip(q.text, 190),
      sub: `${clip(q.project, 52)}${changeMark(q.change)} · ${q.source === "workbook" ? `raised by ${q.askedBy || "the PM"}` : "derived from portfolio state"}${q.neededBy ? ` · needed by ${fmtDate(q.neededBy)}` : ""}`,
    })),
    note: qri.counts.questions > 6 ? `${qri.counts.questions - 6} further questions in the dashboard.` : "",
  });

  slides.push({
    eyebrow: "Section 2 · part 2",
    title: "Risks & Issues",
    dense: true,
    kpis: [
      { lab: "Open risks", val: String(qri.counts.risks) },
      { lab: "Critical", val: String(qri.counts.risksCritical) },
      { lab: "Live issues", val: String(qri.counts.issues) },
    ],
    bullets: [
      ...qri.risks.slice(0, 4).map((r) => ({
        tag: r.severity, tone: r.severity === "Critical" ? "bad" : r.severity === "High" ? "warn" : "neutral",
        text: clip(r.title), sub: `${clip(r.project, 60)}${changeMark(r.change)}${r.owner ? ` · ${r.owner}` : ""} · ${r.status}`,
      })),
      ...qri.issues.slice(0, 4).map((i) => ({
        tag: i.type, tone: i.health === "Red" ? "bad" : "warn",
        text: clip(i.text), sub: clip(i.project, 70),
      })),
    ],
  });

  /* 3 — Priorities */
  slides.push({
    eyebrow: "Section 3",
    title: "Priorities",
    dense: true,
    bullets: priorities.items.slice(0, 6).map((p, i) => ({
      tag: `#${i + 1} · ${p.score}`,
      tone: p.score > 85 ? "bad" : p.score > 70 ? "warn" : "good",
      text: clip(p.name, 80) + changeMark(p.change),
      sub: `${clip(p.why, 190)}\nNeeded: ${clip(p.ask, 190)}`,
    })),
    note: "Score = priority + health + schedule + risk + financial + dependency weight.",
  });

  /* 4 — Roadmap */
  slides.push({
    eyebrow: "Section 4",
    title: "Roadmap / Planned Projects",
    dense: true,
    kpis: [
      { lab: "In flight", val: String(roadmap.inFlight.length) },
      { lab: "Planned", val: String(roadmap.pipeline.length) },
      { lab: "Committed ahead", val: fmtMoney(roadmap.committedAhead) },
    ],
    bullets: [
      ...roadmap.inFlight.slice(0, 4).map((p) => ({
        tag: p.slipDays > 0 ? `+${p.slipDays}d` : "On plan",
        tone: p.slipDays > 0 ? "warn" : "good",
        text: clip(p.name, 80) + changeMark(p.change),
        sub: `${Math.round(p.percentComplete)}% · target ${fmtDate(p.targetEndDate)}${p.slipDays > 0 ? ` · forecast ${fmtDate(p.forecastEnd)}` : ""}`,
      })),
      ...roadmap.pipeline.slice(0, 4).map((p) => ({
        tag: p.status, tone: p.status === "Approved" ? "good" : "neutral",
        text: clip(p.name, 80) + changeMark(p.change),
        sub: `${p.pillar} · ${p.startDate ? `starts ${fmtDate(p.startDate)}` : "no start date"} · ${fmtMoney(p.budget)} · ${p.readiness}`,
      })),
    ],
  });

  /* 5 — Security Posture, last, and only when a Posture sheet was provided. */
  if (posture?.available) {
    const tone = (status) =>
      status === "Compliant" ? "good" : status === "Partial" ? "warn"
        : status === "Non-Compliant" ? "bad" : "neutral";

    slides.push({
      eyebrow: "Section 5",
      title: "Security Posture",
      dense: true,
      kpis: [
        { lab: "Overall maturity", val: `${Math.round(posture.overallScore)}%` },
        { lab: "Target", val: `${Math.round(posture.targetScore)}%` },
        { lab: "Non-compliant", val: String(posture.counts.nonCompliant) },
        { lab: "Critical findings", val: String(posture.counts.criticalFindings) },
      ],
      bullets: posture.weakest.slice(0, 6).map((d) => ({
        tag: d.status,
        tone: tone(d.status),
        text: clip(d.control ? `${d.domain} — ${d.control}` : d.domain, 90) + changeMark(d.change),
        sub: `${Math.round(d.score)}% against a ${Math.round(d.target)}% target`
          + (d.gap > 0 ? `, ${Math.round(d.gap)} points short` : "")
          + (d.criticalFindings ? ` · ${d.criticalFindings} critical finding${d.criticalFindings === 1 ? "" : "s"}` : "")
          + (d.owner ? ` · ${d.owner}` : "")
          + (d.linkedProject ? `\nRemediation: ${clip(d.linkedProject.name, 70)} (${d.linkedProject.health}, ${Math.round(d.linkedProject.percentComplete)}%)` : ""),
      })),
      note: posture.headline,
    });
  }

  /* 6 — Documents, and only when something has actually been imported.
     Same rule as Posture above: an empty chapter is worse than no chapter. */
  if (documents?.available) {
    const shown = documents.documents.slice(0, 5);
    const rest = documents.documents.length - shown.length;
    const sentences = documents.documents.reduce((n, d) => n + (d.summary?.length || 0), 0);
    const flagged = documents.documents.filter((d) => d.warnings?.length).length;

    slides.push({
      eyebrow: "Section 6",
      title: "Documents",
      dense: true,
      kpis: [
        { lab: "Imported", val: String(documents.documents.length) },
        { lab: "Sentences extracted", val: String(sentences) },
        { lab: "Needing a look", val: String(flagged) },
      ],
      bullets: shown.map((d) => {
        /* pageCount and a sentence's page are null for .docx/.txt/.md, which
           have no pages before something renders them. Say so in words rather
           than printing a page that does not exist. */
        const pages = paged(d.pageCount)
          ? `${d.pageCount} page${d.pageCount === 1 ? "" : "s"}`
          : "no page numbers";
        /* Every entry here becomes its OWN line, because pptx-lite splits a
           bullet's .sub on "\n" into separate <a:p> paragraphs. A line feed
           left inside a single <a:t> is ignored by OOXML and PowerPoint runs
           the two lines together — which is why provenance, which must sit
           under its sentence, goes through .sub and never through .text. */
        const lines = [`${d.fileName} · ${pages} · ${d.wordCount} words · imported ${fmtDate(d.extractedAt)}`];
        for (const w of d.warnings || []) lines.push(`⚠ ${clip(w, 120)}`);

        const summary = d.summary || [];
        if (summary.length) {
          lines.push("Extracted from the document:");
          for (const s of summary.slice(0, 2)) {
            lines.push(`“${clip(s.text, 160)}”`);
            lines.push(`— ${s.heading || "document"}${paged(s.page) ? `, page ${s.page}` : ""}`);
          }
        }
        if (d.projectRefs?.length) lines.push(`Mentions ${d.projectRefs.join(", ")} (reported, not linked)`);

        return {
          tag: d.kind,
          tone: d.warnings?.length ? "warn" : "info",
          text: clip(d.title || d.fileName, 80),
          sub: lines.join("\n"),
        };
      }),
      note: rest > 0
        ? `${documents.headline} ${rest} further document${rest === 1 ? "" : "s"} in the dashboard.`
        : documents.headline,
    });
  }

  return buildPptx({
    title: `GCIO ${PERIOD_TITLE[summary.period] || "Executive Summary"}`,
    footer: `GCIO Project Intelligence · ${range(summary)}${meta.demoMode ? " · demonstration data" : ""}`,
    slides,
  });
}
