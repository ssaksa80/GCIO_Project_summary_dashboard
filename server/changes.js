/**
 * What moved between two recorded versions of a project.
 *
 * Pure, synchronous, and deliberately ignorant of SQL: the repository decides
 * WHICH two versions to compare, this decides what the difference means and
 * how to say it in a sentence a CIO would accept.
 *
 * "Direction" is from the reader's point of view, not the number's. Progress
 * going up is better; spend going up is worse; a target date moving out is
 * worse. Getting that wrong makes the briefing say the opposite of the truth,
 * so each field states its own rule rather than inferring one from the sign.
 */
import dayjs from "dayjs";

const HEALTH_RANK = { Green: 0, Amber: 1, Red: 2 };

/**
 * Ordered by how much the CIO cares. The headline names the first of these
 * that moved, so the order is the editorial decision, not an implementation
 * detail — health before dates before money before counts.
 */
export const TRACKED_FIELDS = [
  "health", "status", "targetEndDate", "percentComplete",
  "spent", "budget", "openRisks", "openQuestions",
];

const LABEL = {
  health: "health", status: "status", targetEndDate: "target date",
  percentComplete: "progress", spent: "spend", budget: "budget",
  openRisks: "open risks", openQuestions: "open questions",
};

/** Rising is worse for these; for the rest, rising is better. */
const RISING_IS_WORSE = new Set(["spent", "openRisks", "openQuestions"]);

function compareField(field, from, to) {
  if (from === to) return null;
  if (from == null && to == null) return null;

  if (field === "health") {
    const worse = (HEALTH_RANK[to] ?? 1) > (HEALTH_RANK[from] ?? 1);
    return { from, to, direction: worse ? "worse" : "better" };
  }

  if (field === "targetEndDate") {
    const days = dayjs(to).diff(dayjs(from), "day");
    return { from, to, days, direction: days > 0 ? "worse" : "better" };
  }

  if (field === "status") {
    /* No ordering worth inventing: a move to Completed is good, a move to On
       Hold is not, and everything else is context the reader supplies. */
    const direction = to === "Completed" ? "better" : to === "On Hold" ? "worse" : "neutral";
    return { from, to, direction };
  }

  const delta = Number(to) - Number(from);
  const rising = delta > 0;
  const worse = RISING_IS_WORSE.has(field) ? rising : !rising;
  return { from, to, delta: round1(delta), direction: worse ? "worse" : "better" };
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {object} baseline the version as it stood at the start of the period
 * @param {object} current the newest recorded version
 * @returns {null|{fields: object, headline: string, worst: string, crossedBudget: boolean}}
 *          null when nothing tracked moved
 */
export function compareVersions(baseline, current) {
  if (!baseline || !current) return null;

  const fields = {};
  for (const field of TRACKED_FIELDS) {
    const moved = compareField(field, baseline[field], current[field]);
    if (moved) fields[field] = moved;
  }
  if (Object.keys(fields).length === 0) return null;

  const headlineField = TRACKED_FIELDS.find((f) => fields[f]);
  const h = fields[headlineField];
  const headline = headlineField === "targetEndDate"
    ? `target date ${h.days > 0 ? "slipped" : "pulled in"} ${Math.abs(h.days)} days`
    : h.delta !== undefined
      ? `${LABEL[headlineField]} ${h.delta > 0 ? "up" : "down"} ${Math.abs(h.delta)}`
      : `${LABEL[headlineField]} ${h.from} to ${h.to}`;

  return {
    fields,
    headline,
    worst: Object.values(fields).some((f) => f.direction === "worse") ? "worse" : "better",
    /* Spend crossing the budget line is the one derived fact worth stating
       outright; everything else the reader can see from the numbers. */
    crossedBudget: Number(baseline.spent) <= Number(baseline.budget)
      && Number(current.spent) > Number(current.budget),
  };
}
