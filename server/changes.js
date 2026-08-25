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
 *
 * Some moves have no honest polarity at all — a status change, a budget
 * change, a target date appearing or disappearing for the first time — and
 * are reported as "neutral" rather than defaulting to whichever reading
 * happens to look better on a slide.
 */
import dayjs from "dayjs";
import { fmtMoney, fmtPct, fmtDate, round1 } from "./format.js";

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

/**
 * Fields where a rising number cannot honestly be called better or worse
 * without knowing why it moved. A budget increase can be secured funding or
 * an overrun being formalised after the fact — this module cannot tell
 * which, so it is reported without judging it, the same position `status`
 * is already in.
 */
const NO_POLARITY = new Set(["budget"]);

function compareField(field, from, to) {
  if (from === to) return null;
  if (from == null && to == null) return null;

  if (field === "health") {
    /* Ingest normalises health today, but the column has no CHECK constraint
       guaranteeing it always will. An unrecognised value silently ranks as
       Amber below — warn so a future data-quality problem doesn't hide
       behind a plausible-looking badge. */
    for (const v of [from, to]) {
      if (v != null && !(v in HEALTH_RANK)) {
        console.warn(`changes: unrecognised health value ${JSON.stringify(v)}`);
      }
    }
    const worse = (HEALTH_RANK[to] ?? 1) > (HEALTH_RANK[from] ?? 1);
    return { from, to, direction: worse ? "worse" : "better" };
  }

  if (field === "targetEndDate") {
    /* One side missing is a different event from a date moving: the project
       either acquired a commitment or lost one. Neither is an improvement or
       a regression on its own, and inventing a day count across a null
       produces "NaN days" on a slide. */
    if (from == null || to == null) {
      return { from: from ?? null, to: to ?? null, direction: "neutral" };
    }
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
  const rounded = round1(delta);
  if (NO_POLARITY.has(field)) {
    return { from, to, delta: rounded, direction: "neutral" };
  }
  const rising = delta > 0;
  const worse = RISING_IS_WORSE.has(field) ? rising : !rising;
  return { from, to, delta: rounded, direction: worse ? "worse" : "better" };
}

/** Render a headline amount the way the rest of the product writes one. */
function formatAmount(field, amount) {
  if (field === "spent" || field === "budget") return fmtMoney(amount);
  if (field === "percentComplete") return fmtPct(amount);
  return String(amount);
}

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

  let headline;
  if (headlineField === "targetEndDate") {
    headline = h.days === undefined
      ? (h.to == null ? "target date removed" : `target date set to ${fmtDate(h.to)}`)
      : `target date ${h.days > 0 ? "slipped" : "pulled in"} ${Math.abs(h.days)} days`;
  } else if (h.delta !== undefined) {
    /* The direction word must agree with `direction`, which is computed off
       the unrounded delta (see compareField) — a real 4-fils spend increase
       must never read as "down" next to a red "worse" badge just because it
       rounds to 0. */
    const raw = Number(current[headlineField]) - Number(baseline[headlineField]);
    const word = raw > 0 ? "up" : "down";
    const amount = h.delta === 0 ? "slightly" : formatAmount(headlineField, Math.abs(h.delta));
    headline = `${LABEL[headlineField]} ${word} ${amount}`;
  } else {
    headline = `${LABEL[headlineField]} ${h.from} to ${h.to}`;
  }

  const directions = Object.values(fields).map((f) => f.direction);
  const worst = directions.includes("worse") ? "worse"
    : directions.includes("better") ? "better"
      : "neutral";

  return {
    fields,
    headline,
    worst,
    /* Spend crossing the budget line is the one derived fact worth stating
       outright; everything else the reader can see from the numbers. A
       budget cut underneath flat spend is a different story from
       overspending, and the digest must not count it as the latter. */
    crossedBudget: Number(baseline.spent) <= Number(baseline.budget)
      && Number(current.spent) > Number(current.budget)
      && Number(current.budget) >= Number(baseline.budget),
  };
}
