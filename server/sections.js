/**
 * The four CIO sections, in the order the CIO reads them:
 *
 *   1. Successes
 *   2. Questions, Risks & Issues
 *   3. Priorities
 *   4. Roadmap / Planned Projects
 *
 * Pure functions over the store's projects. Every ranking rule here is
 * deterministic and explainable — the dashboard shows the "why" beside each
 * item, so nothing may depend on hidden state or randomness.
 */
import dayjs from "dayjs";
import { fmtMoney, fmtDate, round1 } from "./format.js";

const CLOSED = new Set(["Completed", "Cancelled"]);
const ACTIVE = new Set(["Approved", "In Progress", "On Hold"]);
const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };

const inRange = (iso, start, end) =>
  Boolean(iso) && iso >= start.format("YYYY-MM-DD") && iso <= end.format("YYYY-MM-DD");

const isOverdue = (p, todayISO) =>
  Boolean(p.targetEndDate) && p.targetEndDate < todayISO && !CLOSED.has(p.status);

const daysBetween = (a, b) => dayjs(a).diff(dayjs(b), "day");

/** Elapsed-vs-delivered gap in points; positive means behind the burn line. */
export function scheduleGap(p, todayISO) {
  if (!p.startDate || !p.targetEndDate || CLOSED.has(p.status)) return 0;
  const duration = daysBetween(p.targetEndDate, p.startDate);
  if (duration <= 0) return 0;
  const elapsed = Math.max(0, daysBetween(todayISO, p.startDate));
  const elapsedPct = Math.min(150, (elapsed / duration) * 100);
  return round1(elapsedPct - p.percentComplete);
}

/** Straight-line forecast end date from progress so far. */
export function forecastEnd(p, todayISO) {
  if (CLOSED.has(p.status)) return p.actualEndDate || p.targetEndDate;
  if (!p.startDate || p.percentComplete <= 5) return p.targetEndDate;
  const elapsed = daysBetween(todayISO, p.startDate);
  if (elapsed <= 0) return p.targetEndDate;
  const projected = dayjs(p.startDate).add(Math.round(elapsed / (p.percentComplete / 100)), "day");
  if (p.targetEndDate && projected.isAfter(dayjs(p.targetEndDate))) return projected.format("YYYY-MM-DD");
  return p.targetEndDate;
}

/* ------------------------------------------------------------------ 1 */

/** Section 1 — what went right inside the reporting window. */
export function buildSuccesses({ projects, start, end, todayISO, period }) {
  const delivered = projects
    .filter((p) => p.status === "Completed" && inRange(p.actualEndDate, start, end))
    .map((p) => ({
      id: p.id,
      name: p.name,
      department: p.department,
      owner: p.owner,
      completedOn: p.actualEndDate,
      budget: p.budget,
      spent: p.spent,
      underBudgetBy: p.budget > 0 && p.spent <= p.budget ? p.budget - p.spent : 0,
      onTime: Boolean(p.targetEndDate && p.actualEndDate && p.actualEndDate <= p.targetEndDate),
      note: p.budget > 0 && p.spent <= p.budget
        ? `${fmtMoney(p.spent)} of ${fmtMoney(p.budget)} — under budget by ${fmtMoney(p.budget - p.spent)}`
        : `${fmtMoney(p.spent)} of ${fmtMoney(p.budget)}`,
    }))
    .sort((a, b) => b.budget - a.budget);

  const milestones = projects
    .flatMap((p) => p.milestones
      .filter((m) => m.status === "Completed" && inRange(m.completedDate, start, end))
      .map((m) => ({ id: p.id, project: p.name, name: m.name, completedOn: m.completedDate })))
    .sort((a, b) => (b.completedOn || "").localeCompare(a.completedOn || ""))
    .slice(0, 8);

  const nearComplete = projects
    .filter((p) => p.status === "In Progress" && p.percentComplete >= 90)
    .map((p) => ({
      id: p.id,
      name: p.name,
      percentComplete: p.percentComplete,
      targetEndDate: p.targetEndDate,
      note: p.targetEndDate ? `on final approach to ${fmtDate(p.targetEndDate)}` : "on final approach",
    }))
    .sort((a, b) => b.percentComplete - a.percentComplete)
    .slice(0, 6);

  const recovered = projects
    // Ahead of the burn line, but not already finished in all but name — a
    // project sitting at 100% with an open status is a data issue, not a win.
    // Meaningfully ahead, and far enough in for that to mean something: a
    // project at 7% is not "ahead", it simply has not started burning yet.
    .filter((p) => !CLOSED.has(p.status) && p.health === "Green"
      && p.percentComplete >= 20 && p.percentComplete < 100
      && scheduleGap(p, todayISO) < -10)
    .map((p) => ({
      id: p.id,
      name: p.name,
      note: `${Math.abs(scheduleGap(p, todayISO))} points ahead of its burn line at ${Math.round(p.percentComplete)}% complete`,
    }))
    .slice(0, 4);

  const savings = delivered.reduce((acc, d) => acc + d.underBudgetBy, 0);
  const headline = delivered.length
    ? `${delivered.length} project${delivered.length === 1 ? "" : "s"} delivered${savings > 0 ? `, ${fmtMoney(savings)} returned against allocation` : ""}.`
    : milestones.length
      ? `No completions this ${period === "daily" ? "day" : period.replace("ly", "")}, but ${milestones.length} milestone${milestones.length === 1 ? "" : "s"} closed on plan.`
      : "No completions or milestone closures fell inside this window.";

  return { headline, delivered, milestones, nearComplete, recovered, savings };
}

/* ------------------------------------------------------------------ 2 */

/**
 * Derived questions — decisions the portfolio state implies but nobody has
 * written down. Each carries the evidence that produced it so the CIO can see
 * why it is being asked.
 */
function deriveQuestions(projects, todayISO) {
  const out = [];
  for (const p of projects) {
    if (CLOSED.has(p.status)) continue;

    if (p.status === "On Hold") {
      const since = p.lastUpdated ? daysBetween(todayISO, p.lastUpdated) : null;
      out.push({
        id: p.id,
        project: p.name,
        text: `${p.name} has been on hold${since !== null ? ` for ${since} days` : ""} — release it, re-scope it, or close it?`,
        because: "Status is On Hold and no restart date is recorded",
        severity: since !== null && since > 30 ? "critical" : "serious",
        source: "derived",
        decisionOwner: p.sponsor || "Unassigned",
      });
    }

    if (!p.owner || !p.sponsor) {
      const missing = [!p.owner && "owner", !p.sponsor && "sponsor"].filter(Boolean).join(" and ");
      out.push({
        id: p.id,
        project: p.name,
        text: `${p.name} has no ${missing} assigned — who leads it?`,
        because: `Workbook leaves ${missing} blank`,
        severity: p.status === "In Progress" ? "critical" : "serious",
        source: "derived",
        decisionOwner: p.sponsor || "Unassigned",
      });
    }

    if (p.status === "Approved" && (!p.budget || p.budget <= 0)) {
      out.push({
        id: p.id,
        project: p.name,
        text: `${p.name} is approved with no budget recorded — confirm the funding line?`,
        because: "Status is Approved and budget is zero or missing",
        severity: "serious",
        source: "derived",
        decisionOwner: p.sponsor || "Unassigned",
      });
    }

    const fc = forecastEnd(p, todayISO);
    if (fc && p.targetEndDate && fc > p.targetEndDate) {
      const slip = daysBetween(fc, p.targetEndDate);
      if (slip >= 14) {
        out.push({
          id: p.id,
          project: p.name,
          text: `${p.name} forecasts ${fmtDate(fc)} against a ${fmtDate(p.targetEndDate)} target — accept the ${slip}-day slip or fund recovery?`,
          because: `Progress-based forecast is ${slip} days past target`,
          severity: slip >= 90 ? "critical" : "serious",
          source: "derived",
          decisionOwner: p.sponsor || p.owner || "Unassigned",
        });
      }
    }

    if (p.budget > 0 && p.spent > p.budget) {
      out.push({
        id: p.id,
        project: p.name,
        text: `${p.name} has spent ${fmtMoney(p.spent)} against ${fmtMoney(p.budget)} — approve the overrun or stop work?`,
        because: `Spend exceeds allocation by ${fmtMoney(p.spent - p.budget)}`,
        severity: "critical",
        source: "derived",
        decisionOwner: p.sponsor || "Unassigned",
      });
    }

    if (p.status === "In Progress" && p.lastUpdated && daysBetween(todayISO, p.lastUpdated) > 30) {
      out.push({
        id: p.id,
        project: p.name,
        text: `${p.name} has not reported in ${daysBetween(todayISO, p.lastUpdated)} days — is it still running?`,
        because: `Last workbook update ${fmtDate(p.lastUpdated)}`,
        severity: "serious",
        source: "derived",
        decisionOwner: p.owner || "Unassigned",
      });
    }
  }
  return out;
}

/** Section 2 — questions first, then risks, then issues already materialised. */
export function buildQRI({ projects, todayISO }) {
  const authored = projects.flatMap((p) =>
    (p.questions || [])
      .filter((q) => q.status !== "Closed")
      .map((q) => ({
        id: p.id,
        project: p.name,
        text: q.text,
        because: q.askedBy ? `Raised by ${q.askedBy}` : "Raised in the workbook",
        askedBy: q.askedBy || p.owner || "",
        raisedDate: q.raisedDate || null,
        neededBy: q.neededBy || null,
        decisionOwner: q.decisionOwner || p.sponsor || "Unassigned",
        severity: q.neededBy && daysBetween(q.neededBy, todayISO) <= 7 ? "critical" : "serious",
        source: "workbook",
      })));

  const derived = deriveQuestions(projects, todayISO);
  const rank = { critical: 0, serious: 1 };
  const seen = new Set();
  const allQuestions = [...authored, ...derived]
    .filter((q) => {
      const key = `${q.id}|${q.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      (a.source === b.source ? 0 : a.source === "workbook" ? -1 : 1) ||
      rank[a.severity] - rank[b.severity] ||
      (a.neededBy || "9999").localeCompare(b.neededBy || "9999"));
  const questions = allQuestions.slice(0, 12);

  const risks = projects
    .flatMap((p) => (p.risks || [])
      .filter((r) => r.status !== "Closed")
      .map((r) => ({
        id: p.id,
        project: p.name,
        title: r.title,
        severity: r.severity,
        status: r.status,
        owner: r.owner || p.owner || "",
        department: p.department,
      })))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.project.localeCompare(b.project));

  const issues = [];
  for (const p of projects) {
    if (CLOSED.has(p.status)) continue;
    if (isOverdue(p, todayISO)) {
      issues.push({
        id: p.id, project: p.name, type: "Schedule", health: p.health,
        text: `${daysBetween(todayISO, p.targetEndDate)} days past its ${fmtDate(p.targetEndDate)} target`,
      });
    }
    const gap = scheduleGap(p, todayISO);
    if (gap > 15 && !isOverdue(p, todayISO)) {
      issues.push({
        id: p.id, project: p.name, type: "Schedule", health: p.health,
        text: `${Math.round(p.percentComplete)}% delivered against ${Math.round(p.percentComplete + gap)}% elapsed — ${Math.round(gap)} points behind`,
      });
    }
    if (p.budget > 0 && p.spent > p.budget) {
      issues.push({
        id: p.id, project: p.name, type: "Financial", health: p.health,
        text: `Overrun — ${fmtMoney(p.spent)} spent against ${fmtMoney(p.budget)}`,
      });
    }
    const overdueMs = p.milestones.filter((m) => m.dueDate && m.dueDate < todayISO && m.status !== "Completed");
    if (overdueMs.length) {
      issues.push({
        id: p.id, project: p.name, type: "Milestone", health: p.health,
        text: `${overdueMs.length} milestone${overdueMs.length === 1 ? "" : "s"} overdue (${overdueMs.slice(0, 2).map((m) => m.name).join(", ")}${overdueMs.length > 2 ? ", …" : ""})`,
      });
    }
    if (p.status === "On Hold") {
      issues.push({
        id: p.id, project: p.name, type: "Decision", health: p.health,
        text: p.lastUpdated ? `On hold ${daysBetween(todayISO, p.lastUpdated)} days awaiting a decision` : "On hold awaiting a decision",
      });
    }
  }
  const healthRank = { Red: 0, Amber: 1, Green: 2 };
  issues.sort((a, b) => healthRank[a.health] - healthRank[b.health] || a.project.localeCompare(b.project));

  return {
    questions,
    risks,
    issues,
    counts: {
      // Counts describe the whole portfolio; the lists above are the top slice.
      questions: allQuestions.length,
      questionsShown: questions.length,
      questionsCritical: allQuestions.filter((q) => q.severity === "critical").length,
      questionsFromWorkbook: allQuestions.filter((q) => q.source === "workbook").length,
      risks: risks.length,
      risksCritical: risks.filter((r) => r.severity === "Critical").length,
      issues: issues.length,
    },
  };
}

/* ------------------------------------------------------------------ 3 */

const PRIORITY_WEIGHT = { Critical: 30, High: 20, Medium: 10, Low: 4 };
const HEALTH_WEIGHT = { Red: 25, Amber: 12, Green: 0 };

/**
 * Section 3 — a ranked call list. The score is a transparent sum of weights so
 * the reasons shown beside each row always add up to the number displayed.
 */
export function buildPriorities({ projects, todayISO, qri, childCountById }) {
  const scored = projects
    .filter((p) => !CLOSED.has(p.status))
    .map((p) => {
      const reasons = [];
      let score = 0;

      score += PRIORITY_WEIGHT[p.priority] || 10;
      reasons.push(`${p.priority} priority`);

      if (HEALTH_WEIGHT[p.health]) {
        score += HEALTH_WEIGHT[p.health];
        reasons.push(`${p.health} health`);
      }

      if (isOverdue(p, todayISO)) {
        const days = daysBetween(todayISO, p.targetEndDate);
        score += Math.min(20, 6 + Math.round(days / 7));
        reasons.push(`${days} days past target`);
      } else {
        const gap = scheduleGap(p, todayISO);
        if (gap > 10) {
          score += Math.min(15, Math.round(gap / 2));
          reasons.push(`${Math.round(gap)} points behind the burn line`);
        }
      }

      const crit = (p.risks || []).filter((r) => r.severity === "Critical" && r.status !== "Closed").length;
      const openR = (p.risks || []).filter((r) => r.status !== "Closed").length;
      if (crit) { score += crit * 8; reasons.push(`${crit} critical risk${crit === 1 ? "" : "s"} open`); }
      else if (openR) { score += Math.min(6, openR * 2); reasons.push(`${openR} open risk${openR === 1 ? "" : "s"}`); }

      if (p.budget > 0 && p.spent > p.budget) {
        score += 12;
        reasons.push(`budget overrun of ${fmtMoney(p.spent - p.budget)}`);
      }

      if (p.status === "On Hold") { score += 10; reasons.push("held pending a decision"); }

      const children = childCountById.get(p.id) || 0;
      if (children) { score += Math.min(10, children * 4); reasons.push(`blocks ${children} dependent project${children === 1 ? "" : "s"}`); }

      const questionsHere = qri.questions.filter((q) => q.id === p.id);
      if (questionsHere.length) { score += 8; }

      const ask = questionsHere[0]?.text
        || (p.status === "On Hold" ? "Release the hold or close the project — it is consuming plan capacity either way."
          : isOverdue(p, todayISO) ? "Confirm a recovery date or re-baseline the target formally."
            : p.health === "Red" ? "Agree the recovery plan and the date it will be measured against."
              : "No decision needed this period — keep it on watch.");

      return {
        id: p.id,
        name: p.name,
        department: p.department,
        owner: p.owner,
        sponsor: p.sponsor,
        health: p.health,
        priority: p.priority,
        status: p.status,
        percentComplete: p.percentComplete,
        budget: p.budget,
        spent: p.spent,
        targetEndDate: p.targetEndDate,
        forecastEnd: forecastEnd(p, todayISO),
        score: Math.min(99, score),
        why: reasons.join(" · "),
        ask,
      };
    })
    .sort((a, b) => b.score - a.score || b.budget - a.budget);

  return { items: scored.slice(0, 8), watchlist: scored.slice(8, 14) };
}

/* ------------------------------------------------------------------ 4 */

/** Section 4 — what is coming, in flight first, then the planned pipeline. */
export function buildRoadmap({ projects, end, todayISO, period }) {
  const horizonEnd = end.add(period === "daily" ? 90 : period === "weekly" ? 180 : period === "monthly" ? 365 : 540, "day");

  const inFlight = projects
    .filter((p) => p.status === "In Progress" || p.status === "On Hold")
    .map((p) => {
      const fc = forecastEnd(p, todayISO);
      return {
        id: p.id,
        name: p.name,
        owner: p.owner,
        health: p.health,
        percentComplete: p.percentComplete,
        startDate: p.startDate,
        targetEndDate: p.targetEndDate,
        forecastEnd: fc,
        slipDays: fc && p.targetEndDate && fc > p.targetEndDate ? daysBetween(fc, p.targetEndDate) : 0,
        onHold: p.status === "On Hold",
      };
    })
    .sort((a, b) => (a.targetEndDate || "9999").localeCompare(b.targetEndDate || "9999"));

  const pipeline = projects
    .filter((p) => p.status === "Proposed" || p.status === "Approved")
    .map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      pillar: p.pillar,
      department: p.department,
      sponsor: p.sponsor,
      budget: p.budget,
      startDate: p.startDate,
      targetEndDate: p.targetEndDate,
      readiness: p.owner && p.sponsor && p.budget > 0 ? "Ready" : "Needs setup",
    }))
    .sort((a, b) => (a.startDate || a.targetEndDate || "9999").localeCompare(b.startDate || b.targetEndDate || "9999"));

  const upcomingMilestones = projects
    .flatMap((p) => p.milestones
      .filter((m) => m.status !== "Completed" && m.dueDate && m.dueDate >= todayISO && m.dueDate <= horizonEnd.format("YYYY-MM-DD"))
      .map((m) => ({ id: p.id, project: p.name, name: m.name, dueDate: m.dueDate, health: p.health })))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 10);

  const byPillar = new Map();
  for (const p of projects) {
    if (CLOSED.has(p.status)) continue;
    const row = byPillar.get(p.pillar) || { pillar: p.pillar, budget: 0, spent: 0, count: 0 };
    row.budget += p.budget;
    row.spent += p.spent;
    row.count += 1;
    byPillar.set(p.pillar, row);
  }

  return {
    horizonStart: todayISO,
    horizonEnd: horizonEnd.format("YYYY-MM-DD"),
    inFlight: inFlight.slice(0, 14),
    pipeline: pipeline.slice(0, 12),
    upcomingMilestones,
    pillars: [...byPillar.values()].sort((a, b) => b.budget - a.budget),
    committedAhead: pipeline.reduce((acc, p) => acc + p.budget, 0),
  };
}

/* ---------------------------------------------------------------- all 4 */

/**
 * Build all four sections in CIO order.
 * @param {object[]} projects
 * @param {{period: string, start: import('dayjs').Dayjs, end: import('dayjs').Dayjs, todayISO: string}} ctx
 */
export function buildSections(projects, { period, start, end, todayISO, postureRows = [] }) {
  const childCountById = new Map();
  for (const p of projects) {
    if (!p.parentId) continue;
    childCountById.set(p.parentId, (childCountById.get(p.parentId) || 0) + 1);
  }

  const successes = buildSuccesses({ projects, start, end, todayISO, period });
  const qri = buildQRI({ projects, todayISO });
  const priorities = buildPriorities({ projects, todayISO, qri, childCountById });
  const roadmap = buildRoadmap({ projects, end, todayISO, period });
  const posture = buildPosture(postureRows, {
    todayISO,
    projectsById: new Map(projects.map((p) => [p.id, p])),
  });

  return { successes, qri, priorities, roadmap, posture };
}

export const SECTION_TITLES = [
  "Successes",
  "Questions, Risks & Issues",
  "Priorities",
  "Roadmap / Planned Projects",
  "Security Posture",
];

/* ------------------------------------------------------------------ 5 */

const POSTURE_RANK = { "Non-Compliant": 0, Partial: 1, "Not Assessed": 2, Compliant: 3 };

/**
 * Section 5 — Security Posture. Portfolio-level, sourced from the workbook's
 * Posture sheet rather than from projects, and shown last because it is
 * standing context rather than something the CIO decides in the room.
 *
 * @param {object[]} rows normalized posture rows from the store
 * @param {{todayISO: string, projectsById: Map<string, object>}} ctx
 */
export function buildPosture(rows, { todayISO, projectsById }) {
  if (!rows || rows.length === 0) {
    return {
      available: false,
      headline: "No Security Posture sheet has been provided in any workbook.",
      domains: [], counts: {}, weakest: [], overdueReviews: [], remediation: [],
      overallScore: 0, targetScore: 0,
    };
  }

  const domains = rows.map((row) => {
    const gap = Math.max(0, (row.target || 0) - (row.score || 0));
    const reviewOverdue = Boolean(row.nextReview && row.nextReview < todayISO);
    const linked = row.projectId ? projectsById.get(row.projectId) || null : null;
    return {
      ...row,
      gap: round1(gap),
      reviewOverdue,
      reviewOverdueDays: reviewOverdue ? daysBetween(todayISO, row.nextReview) : 0,
      linkedProject: linked ? { id: linked.id, name: linked.name, health: linked.health, percentComplete: linked.percentComplete } : null,
    };
  });

  const counts = {
    total: domains.length,
    compliant: domains.filter((d) => d.status === "Compliant").length,
    partial: domains.filter((d) => d.status === "Partial").length,
    nonCompliant: domains.filter((d) => d.status === "Non-Compliant").length,
    notAssessed: domains.filter((d) => d.status === "Not Assessed").length,
    openFindings: domains.reduce((acc, d) => acc + d.openFindings, 0),
    criticalFindings: domains.reduce((acc, d) => acc + d.criticalFindings, 0),
    reviewsOverdue: domains.filter((d) => d.reviewOverdue).length,
  };

  const assessed = domains.filter((d) => d.status !== "Not Assessed");
  const overallScore = assessed.length
    ? round1(assessed.reduce((acc, d) => acc + d.score, 0) / assessed.length)
    : 0;
  const targetScore = assessed.length
    ? round1(assessed.reduce((acc, d) => acc + (d.target || 100), 0) / assessed.length)
    : 0;

  /* Worst first: status, then the shortfall against target, then how many
     critical findings sit behind it. The headline names weakest[0], so the
     order has to agree with what "worst" means in that sentence. */
  const weakest = [...domains]
    .sort((a, b) =>
      POSTURE_RANK[a.status] - POSTURE_RANK[b.status] ||
      b.gap - a.gap ||
      b.criticalFindings - a.criticalFindings)
    .slice(0, 6);

  const overdueReviews = domains
    .filter((d) => d.reviewOverdue)
    .sort((a, b) => b.reviewOverdueDays - a.reviewOverdueDays);

  /* Domains whose remediation is already funded as a project — the link
     between this section and the rest of the portfolio. */
  const remediation = domains
    .filter((d) => d.linkedProject)
    .map((d) => ({
      domain: d.domain,
      control: d.control,
      status: d.status,
      project: d.linkedProject,
    }));

  const worst = weakest[0];
  const headline = counts.nonCompliant > 0
    ? `${counts.nonCompliant} of ${counts.total} domains are non-compliant${worst ? `, worst is ${worst.domain} at ${Math.round(worst.score)}% against a ${Math.round(worst.target)}% target` : ""}.`
    : counts.partial > 0
      ? `No domain is non-compliant; ${counts.partial} of ${counts.total} remain partial, overall maturity ${Math.round(overallScore)}%.`
      : `All ${counts.total} assessed domains are compliant, overall maturity ${Math.round(overallScore)}%.`;

  return {
    available: true,
    headline,
    overallScore,
    targetScore,
    counts,
    domains,
    weakest,
    overdueReviews,
    remediation,
  };
}
