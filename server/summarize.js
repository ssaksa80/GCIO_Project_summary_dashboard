/**
 * Executive summarization engine: period rollups, KPI computation, chart
 * series, the attention list, and the deterministic C-suite narrative
 * (SPEC §5). Pure functions over the store — no side effects.
 */
import dayjs from "dayjs";
import isoWeek from "dayjs/plugin/isoWeek.js";
import { fmtMoney, fmtDate, round1 } from "./format.js";
import { buildSections, annotateChanges } from "./sections.js";

dayjs.extend(isoWeek);

const STATUS_ORDER = ["Proposed", "Approved", "In Progress", "On Hold", "Completed", "Cancelled"];
const ACTIVE_STATUSES = new Set(["Approved", "In Progress", "On Hold"]);

/** Resolve the reporting window for a period anchored at dateISO. */
export function periodWindow(period, dateISO) {
  const d = dayjs(dateISO);
  switch (period) {
    case "daily":
      return { start: d.startOf("day"), end: d.endOf("day") };
    case "weekly":
      return { start: d.startOf("isoWeek"), end: d.endOf("isoWeek") };
    case "yearly":
      return { start: d.startOf("year"), end: d.endOf("year") };
    case "monthly":
    default:
      return { start: d.startOf("month"), end: d.endOf("month") };
  }
}

const inRange = (iso, start, end) => Boolean(iso) && iso >= start.format("YYYY-MM-DD") && iso <= end.format("YYYY-MM-DD");

const isOverdue = (p, todayISO) =>
  Boolean(p.targetEndDate) && p.targetEndDate < todayISO && p.status !== "Completed" && p.status !== "Cancelled";

/** Trend buckets per period (SPEC §5). Returns [{key, label, start, end}]. */
function trendBuckets(period, anchor) {
  const buckets = [];
  if (period === "daily") {
    for (let i = 13; i >= 0; i -= 1) {
      const day = anchor.subtract(i, "day");
      buckets.push({ label: day.format("D MMM"), start: day.startOf("day"), end: day.endOf("day") });
    }
  } else if (period === "weekly") {
    for (let i = 11; i >= 0; i -= 1) {
      const wk = anchor.subtract(i, "week");
      buckets.push({ label: wk.startOf("isoWeek").format("D MMM"), start: wk.startOf("isoWeek"), end: wk.endOf("isoWeek") });
    }
  } else if (period === "yearly") {
    for (let m = 0; m < 12; m += 1) {
      const mo = anchor.startOf("year").add(m, "month");
      buckets.push({ label: mo.format("MMM"), start: mo.startOf("month"), end: mo.endOf("month") });
    }
  } else {
    for (let i = 11; i >= 0; i -= 1) {
      const mo = anchor.subtract(i, "month");
      buckets.push({ label: mo.format("MMM YY"), start: mo.startOf("month"), end: mo.endOf("month") });
    }
  }
  return buckets;
}

const sum = (arr, fn) => arr.reduce((acc, x) => acc + (fn(x) || 0), 0);

/**
 * Fetch what changed during a period. The one asynchronous step in an
 * otherwise synchronous pipeline, kept at the edge on purpose: making the
 * section engine async to reach a database would ripple through every builder
 * and every test for no benefit.
 *
 * @returns {Promise<Map<string, object>|null>} null when the store keeps no history
 */
export async function loadChanges(store, period, dateISO) {
  if (typeof store.changesSince !== "function") return null;
  const { start } = periodWindow(period, dateISO);
  try {
    return await store.changesSince(start.format("YYYY-MM-DD"));
  } catch (err) {
    /* A history query failing must not take down the briefing. The dashboard
       is still correct without it; it just cannot say what moved. */
    console.error(`[changes] could not load history: ${err.message}`);
    return null;
  }
}

/**
 * Build the full summary payload for a period (SPEC §5 shape).
 * @param {import('./store.js').Store} store
 * @param {"daily"|"weekly"|"monthly"|"yearly"} period
 * @param {string} dateISO anchor date (yyyy-mm-dd)
 * @param {{changes?: Map<string, object>|null}} [opts] changes computed by loadChanges,
 *        already scoped to this period. Defaults to null so every existing
 *        three-argument caller keeps working unchanged and sees nothing annotated.
 */
export function buildSummary(store, period, dateISO, { changes = null } = {}) {
  const anchor = dayjs(dateISO);
  const { start, end } = periodWindow(period, dateISO);
  const todayISO = dayjs().format("YYYY-MM-DD");
  const projects = store.all();
  const active = projects.filter((p) => ACTIVE_STATUSES.has(p.status));
  const overdue = projects.filter((p) => isOverdue(p, todayISO));

  const completedIn = projects.filter((p) => p.status === "Completed" && inRange(p.actualEndDate, start, end));
  const approvedIn = projects.filter((p) => inRange(p.approvalDate, start, end));
  const startedIn = projects.filter((p) => inRange(p.startDate, start, end));

  const allMilestones = projects.flatMap((p) => p.milestones.map((m) => ({ ...m, project: p })));
  const milestonesDueInPeriod = allMilestones.filter((m) => inRange(m.dueDate, start, end)).length;
  const milestonesOverdue = allMilestones.filter(
    (m) => m.dueDate && m.dueDate < todayISO && m.status !== "Completed"
  ).length;

  const openRiskList = projects.flatMap((p) =>
    p.risks.filter((r) => r.status !== "Closed").map((r) => ({ ...r, project: p }))
  );
  const criticalRisks = openRiskList.filter((r) => r.severity === "Critical");

  const budgetTotal = sum(projects, (p) => p.budget);
  const spentTotal = sum(projects, (p) => p.spent);
  const health = {
    green: projects.filter((p) => p.health === "Green").length,
    amber: projects.filter((p) => p.health === "Amber").length,
    red: projects.filter((p) => p.health === "Red").length,
  };

  const kpis = {
    totalProjects: projects.length,
    active: active.length,
    completedInPeriod: completedIn.length,
    approvedInPeriod: approvedIn.length,
    startedInPeriod: startedIn.length,
    onHold: projects.filter((p) => p.status === "On Hold").length,
    overdue: overdue.length,
    milestonesDueInPeriod,
    milestonesOverdue,
    budgetTotal,
    spentTotal,
    budgetUtilizationPct: budgetTotal > 0 ? round1((spentTotal / budgetTotal) * 100) : 0,
    avgCompletion: active.length ? round1(sum(active, (p) => p.percentComplete) / active.length) : 0,
    health,
    openRisks: openRiskList.length,
    criticalRisks: criticalRisks.length,
  };

  return {
    period,
    date: anchor.format("YYYY-MM-DD"),
    rangeStart: start.format("YYYY-MM-DD"),
    rangeEnd: end.format("YYYY-MM-DD"),
    generatedAt: new Date().toISOString(),
    currency: "AED",
    kpis,
    sections: annotateChanges(
      buildSections(projects, { period, start, end, todayISO, postureRows: store.posture() }),
      changes
    ),
    narrative: buildNarrative({ period, anchor, end, projects, active, kpis, completedIn, approvedIn, overdue, criticalRisks, allMilestones, todayISO }),
    charts: buildCharts({ period, anchor, projects, active }),
    attention: buildAttention(projects, criticalRisks, todayISO),
  };
}

function buildCharts({ period, anchor, projects, active }) {
  const statusBreakdown = STATUS_ORDER.map((label) => ({
    label,
    value: projects.filter((p) => p.status === label).length,
  })).filter((s) => s.value > 0);

  const byDept = new Map();
  for (const p of projects) {
    if (!byDept.has(p.department)) byDept.set(p.department, []);
    byDept.get(p.department).push(p);
  }
  const healthByDepartment = [...byDept.entries()]
    .map(([department, list]) => ({
      department,
      green: list.filter((p) => p.health === "Green").length,
      amber: list.filter((p) => p.health === "Amber").length,
      red: list.filter((p) => p.health === "Red").length,
    }))
    .sort((a, b) => b.red - a.red || b.amber - a.amber);

  const deptBudgets = [...byDept.entries()]
    .map(([department, list]) => ({ department, budget: sum(list, (p) => p.budget), spent: sum(list, (p) => p.spent) }))
    .sort((a, b) => b.budget - a.budget);
  const budgetByDepartment = deptBudgets.slice(0, 8);
  if (deptBudgets.length > 8) {
    const rest = deptBudgets.slice(8);
    budgetByDepartment.push({ department: "Other", budget: sum(rest, (d) => d.budget), spent: sum(rest, (d) => d.spent) });
  }

  const buckets = trendBuckets(period, anchor);
  const completionTrend = buckets.map((b) => ({
    bucket: b.label,
    completed: projects.filter((p) => inRange(p.actualEndDate, b.start, b.end)).length,
    approved: projects.filter((p) => inRange(p.approvalDate, b.start, b.end)).length,
    started: projects.filter((p) => inRange(p.startDate, b.start, b.end)).length,
  }));

  const byPillar = new Map();
  for (const p of projects) {
    if (!byPillar.has(p.pillar)) byPillar.set(p.pillar, { pillar: p.pillar, spent: 0, budget: 0 });
    const row = byPillar.get(p.pillar);
    row.spent += p.spent;
    row.budget += p.budget;
  }
  const spendByPillar = [...byPillar.values()].sort((a, b) => b.budget - a.budget);

  const topProjects = [...active]
    .sort((a, b) => b.budget - a.budget)
    .slice(0, 10)
    .map((p) => ({
      id: p.id,
      name: p.name,
      department: p.department,
      budget: p.budget,
      spent: p.spent,
      percentComplete: p.percentComplete,
      health: p.health,
      targetEndDate: p.targetEndDate,
    }));

  return { statusBreakdown, healthByDepartment, budgetByDepartment, completionTrend, spendByPillar, topProjects };
}

function buildAttention(projects, criticalRisks, todayISO) {
  const items = [];
  for (const p of projects) {
    if (p.status === "Completed" || p.status === "Cancelled") continue;
    if (p.health === "Red") {
      items.push({ id: p.id, name: p.name, severity: "critical", reason: `Red health in ${p.phase.toLowerCase()} phase at ${Math.round(p.percentComplete)}% complete` });
    }
    if (isOverdue(p, todayISO)) {
      const days = dayjs(todayISO).diff(dayjs(p.targetEndDate), "day");
      items.push({ id: p.id, name: p.name, severity: "serious", reason: `${days} day${days === 1 ? "" : "s"} past target end of ${fmtDate(p.targetEndDate)}` });
    }
    if (p.budget > 0 && p.spent > p.budget) {
      items.push({ id: p.id, name: p.name, severity: "serious", reason: `Budget overrun — ${fmtMoney(p.spent)} spent against ${fmtMoney(p.budget)}` });
    }
  }
  for (const r of criticalRisks) {
    items.push({ id: r.project.id, name: r.project.name, severity: "critical", reason: `Critical risk open: ${r.title}` });
  }
  const rank = { critical: 0, serious: 1, warning: 2 };
  const seen = new Set();
  return items
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .filter((item) => {
      const key = `${item.id}|${item.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

const names = (list, max = 3) => {
  const shown = list.slice(0, max).map((p) => p.name);
  const extra = list.length - shown.length;
  return shown.join(", ") + (extra > 0 ? ` and ${extra} more` : "");
};

const PERIOD_NOUN = { daily: "today", weekly: "this week", monthly: "this month", yearly: "this year" };
const NEXT_NOUN = { daily: "tomorrow", weekly: "next week", monthly: "next month", yearly: "next year" };

function buildNarrative(ctx) {
  const { period, anchor, end, projects, active, kpis, completedIn, approvedIn, overdue, criticalRisks, allMilestones, todayISO } = ctx;
  const noun = PERIOD_NOUN[period] || "this period";
  const healthyPct = projects.length ? Math.round((kpis.health.green / projects.length) * 100) : 0;

  const headline = projects.length === 0
    ? "No portfolio data has been ingested yet."
    : `Portfolio of ${projects.length} projects (${active.length} active) is ${healthyPct}% healthy; ${fmtMoney(kpis.budgetTotal)} committed with ${Math.round(kpis.budgetUtilizationPct)}% consumed.`;

  const bullets = [];
  if (completedIn.length) bullets.push(`${completedIn.length} project${completedIn.length === 1 ? "" : "s"} delivered ${noun}: ${names(completedIn)}.`);
  if (approvedIn.length) bullets.push(`${approvedIn.length} new approval${approvedIn.length === 1 ? "" : "s"} ${noun}: ${names(approvedIn)}.`);
  if (kpis.milestonesOverdue > 0) bullets.push(`${kpis.milestonesOverdue} milestone${kpis.milestonesOverdue === 1 ? " is" : "s are"} overdue across the portfolio.`);
  const overruns = projects.filter((p) => p.budget > 0 && p.spent > p.budget).sort((a, b) => (b.spent / b.budget) - (a.spent / a.budget));
  if (overruns.length) bullets.push(`${overruns.length} project${overruns.length === 1 ? "" : "s"} running over budget, led by ${overruns[0].name} at ${Math.round((overruns[0].spent / overruns[0].budget) * 100)}% of allocation.`);
  const deptHealth = new Map();
  for (const p of projects) {
    if (!deptHealth.has(p.department)) deptHealth.set(p.department, { total: 0, red: 0 });
    const row = deptHealth.get(p.department);
    row.total += 1;
    if (p.health === "Red") row.red += 1;
  }
  const weakest = [...deptHealth.entries()].filter(([, v]) => v.red > 0).sort((a, b) => b[1].red / b[1].total - a[1].red / a[1].total)[0];
  if (weakest) bullets.push(`${weakest[0]} carries the weakest health profile with ${weakest[1].red} of ${weakest[1].total} projects in Red.`);
  if (kpis.onHold > 0) bullets.push(`${kpis.onHold} project${kpis.onHold === 1 ? " remains" : "s remain"} on hold pending executive decisions.`);

  const nearDone = active.filter((p) => p.percentComplete >= 90 && p.status === "In Progress");
  const wins = [
    ...completedIn.map((p) => `${p.name} — delivered ${p.actualEndDate ? fmtDate(p.actualEndDate) : noun}${p.budget > 0 && p.spent <= p.budget ? ", within budget" : ""}.`),
    ...nearDone.slice(0, 3).map((p) => `${p.name} — ${Math.round(p.percentComplete)}% complete, on final approach to ${p.targetEndDate ? fmtDate(p.targetEndDate) : "close"}.`),
  ].slice(0, 5);

  const redList = projects.filter((p) => p.health === "Red" && p.status !== "Completed" && p.status !== "Cancelled");
  const risks = [
    ...redList.slice(0, 3).map((p) => `${p.name} — Red health, ${Math.round(p.percentComplete)}% complete${p.targetEndDate ? `, target ${fmtDate(p.targetEndDate)}` : ""}.`),
    ...criticalRisks.slice(0, 2).map((r) => `${r.project.name} — ${r.title}.`),
    ...overdue.filter((p) => p.health !== "Red").slice(0, 2).map((p) => `${p.name} — past its ${fmtDate(p.targetEndDate)} target.`),
  ].slice(0, 5);

  const nextStart = end.add(1, "day");
  const nextEnd = period === "daily" ? nextStart.endOf("day")
    : period === "weekly" ? nextStart.endOf("isoWeek")
    : period === "yearly" ? nextStart.endOf("year")
    : nextStart.endOf("month");
  const upcomingMilestones = allMilestones.filter((m) => m.status !== "Completed" && inRange(m.dueDate, nextStart, nextEnd));
  const dueNext = projects.filter((p) => p.status !== "Completed" && p.status !== "Cancelled" && inRange(p.targetEndDate, nextStart, nextEnd));
  const outlookParts = [];
  if (dueNext.length) outlookParts.push(`${dueNext.length} project${dueNext.length === 1 ? " is" : "s are"} scheduled to complete ${NEXT_NOUN[period] || "next period"} (${names(dueNext, 2)})`);
  if (upcomingMilestones.length) outlookParts.push(`${upcomingMilestones.length} milestone${upcomingMilestones.length === 1 ? "" : "s"} fall due`);
  const outlook = outlookParts.length
    ? `Looking ahead: ${outlookParts.join("; ")}. Focus remains on converting Amber projects before quarter close.`
    : `No completions or milestones are scheduled for ${NEXT_NOUN[period] || "the next period"}; attention stays on in-flight delivery.`;

  return { headline, bullets: bullets.slice(0, 6), wins, risks, outlook };
}

/** Slim listing row for /api/projects (SPEC §4). */
export function toRow(p, todayISO = dayjs().format("YYYY-MM-DD")) {
  const { milestones, updates, risks, ...rest } = p;
  return {
    ...rest,
    overdue: isOverdue(p, todayISO),
    daysToTarget: p.targetEndDate ? dayjs(p.targetEndDate).diff(dayjs(todayISO), "day") : null,
    budgetUtilization: p.budget > 0 ? round1((p.spent / p.budget) * 100) : 0,
    openRisks: risks.filter((r) => r.status !== "Closed").length,
    milestoneCount: milestones.length,
  };
}

/** Per-project computed panel + merged event timeline (SPEC §4). */
export function computeDetail(p) {
  const todayISO = dayjs().format("YYYY-MM-DD");
  const openRisks = p.risks.filter((r) => r.status !== "Closed").length;
  const overdueMilestones = p.milestones.filter((m) => m.dueDate && m.dueDate < todayISO && m.status !== "Completed").length;
  const durationDays = p.startDate && p.targetEndDate ? dayjs(p.targetEndDate).diff(dayjs(p.startDate), "day") : null;
  const elapsed = p.startDate ? dayjs(todayISO).diff(dayjs(p.startDate), "day") : null;
  const elapsedPct = durationDays && elapsed !== null && durationDays > 0
    ? Math.max(0, Math.min(150, round1((elapsed / durationDays) * 100)))
    : null;

  let scheduleStatus = "On Track";
  if (p.status === "Completed") scheduleStatus = "Completed";
  else if (isOverdue(p, todayISO)) scheduleStatus = "Overdue";
  else if (p.health === "Red" || (elapsedPct !== null && elapsedPct - p.percentComplete > 15) || overdueMilestones > 0) scheduleStatus = "At Risk";

  let forecastEnd = p.actualEndDate || p.targetEndDate;
  if (scheduleStatus !== "Completed" && p.startDate && p.percentComplete > 5 && elapsed > 0) {
    const projectedTotal = Math.round(elapsed / (p.percentComplete / 100));
    const projected = dayjs(p.startDate).add(projectedTotal, "day");
    if (p.targetEndDate && projected.isAfter(dayjs(p.targetEndDate))) forecastEnd = projected.format("YYYY-MM-DD");
  }

  const timeline = [];
  if (p.approvalDate) timeline.push({ date: p.approvalDate, type: "approval", label: "Project approved", detail: p.sponsor ? `Sponsored by ${p.sponsor}` : "" });
  if (p.startDate) timeline.push({ date: p.startDate, type: "start", label: "Execution started", detail: p.owner ? `Led by ${p.owner}` : "" });
  for (const m of p.milestones) {
    const date = m.completedDate || m.dueDate;
    if (date) timeline.push({ date, type: "milestone", label: m.name, detail: m.status === "Completed" ? `Completed ${fmtDate(m.completedDate)}` : `${m.status} — due ${fmtDate(m.dueDate)}` });
  }
  for (const u of p.updates) {
    if (u.date) timeline.push({ date: u.date, type: "update", label: u.author ? `Update — ${u.author}` : "Status update", detail: u.text });
  }
  if (p.actualEndDate) timeline.push({ date: p.actualEndDate, type: "completion", label: "Project completed", detail: "" });
  timeline.sort((a, b) => a.date.localeCompare(b.date));

  return {
    computed: {
      scheduleStatus,
      daysRemaining: p.targetEndDate && p.status !== "Completed" ? dayjs(p.targetEndDate).diff(dayjs(todayISO), "day") : null,
      durationDays,
      elapsedPct,
      budgetUtilizationPct: p.budget > 0 ? round1((p.spent / p.budget) * 100) : 0,
      forecastEnd,
      openRisks,
      overdueMilestones,
    },
    timeline,
  };
}
