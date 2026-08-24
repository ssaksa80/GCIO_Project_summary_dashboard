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

/**
 * @param {{summary: object, meta: object}} payload
 * @returns {Uint8Array} .pptx bytes
 */
export function buildPptxDeck(payload) {
  const { summary, meta = {} } = payload;
  const { kpis, sections } = summary;
  const { successes, qri, priorities, roadmap, posture } = sections;

  const slides = [];

  slides.push({
    cover: true,
    eyebrow: "GCIO · PROJECT INTELLIGENCE",
    title: PERIOD_TITLE[summary.period] || "Executive Summary",
    subtitle: `${range(summary)} · ${kpis.totalProjects} projects · ${fmtMoney(kpis.budgetTotal)} committed${meta.demoMode ? " · demonstration portfolio" : ""}`,
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
      tag: "Delivered", tone: "good", text: clip(d.name), sub: `${fmtDate(d.completedOn)} · ${d.note}`,
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
      sub: `${clip(q.project, 52)} · ${q.source === "workbook" ? `raised by ${q.askedBy || "the PM"}` : "derived from portfolio state"}${q.neededBy ? ` · needed by ${fmtDate(q.neededBy)}` : ""}`,
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
        text: clip(r.title), sub: `${clip(r.project, 60)}${r.owner ? ` · ${r.owner}` : ""} · ${r.status}`,
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
      text: clip(p.name, 80),
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
        text: clip(p.name, 80),
        sub: `${Math.round(p.percentComplete)}% · target ${fmtDate(p.targetEndDate)}${p.slipDays > 0 ? ` · forecast ${fmtDate(p.forecastEnd)}` : ""}`,
      })),
      ...roadmap.pipeline.slice(0, 4).map((p) => ({
        tag: p.status, tone: p.status === "Approved" ? "good" : "neutral",
        text: clip(p.name, 80),
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
        text: clip(d.control ? `${d.domain} — ${d.control}` : d.domain, 90),
        sub: `${Math.round(d.score)}% against a ${Math.round(d.target)}% target`
          + (d.gap > 0 ? `, ${Math.round(d.gap)} points short` : "")
          + (d.criticalFindings ? ` · ${d.criticalFindings} critical finding${d.criticalFindings === 1 ? "" : "s"}` : "")
          + (d.owner ? ` · ${d.owner}` : "")
          + (d.linkedProject ? `\nRemediation: ${clip(d.linkedProject.name, 70)} (${d.linkedProject.health}, ${Math.round(d.linkedProject.percentComplete)}%)` : ""),
      })),
      note: posture.headline,
    });
  }

  return buildPptx({
    title: `GCIO ${PERIOD_TITLE[summary.period] || "Executive Summary"}`,
    footer: `GCIO Project Intelligence · ${range(summary)}${meta.demoMode ? " · demonstration data" : ""}`,
    slides,
  });
}
