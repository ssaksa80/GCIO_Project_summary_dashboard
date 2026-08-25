import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, TRACKED_FIELDS } from "../../server/changes.js";

const version = (over = {}) => ({
  recordedAt: "2026-08-18T09:00:00.000Z",
  status: "In Progress", health: "Green", percentComplete: 40,
  budget: 1000, spent: 300, openRisks: 1, openQuestions: 0,
  targetEndDate: "2026-06-30",
  ...over,
});

test("two identical versions are not a change", () => {
  assert.equal(compareVersions(version(), version()), null);
});

test("a health move is reported with both ends and a direction", () => {
  const change = compareVersions(version({ health: "Green" }), version({ health: "Red" }));
  assert.equal(change.fields.health.from, "Green");
  assert.equal(change.fields.health.to, "Red");
  assert.equal(change.fields.health.direction, "worse");
  assert.equal(change.headline, "health Green to Red");
});

test("health improving is reported as better", () => {
  const change = compareVersions(version({ health: "Red" }), version({ health: "Amber" }));
  assert.equal(change.fields.health.direction, "better");
});

test("a slipped target date is worse; pulling it in is better", () => {
  const slipped = compareVersions(version(), version({ targetEndDate: "2026-09-30" }));
  assert.equal(slipped.fields.targetEndDate.direction, "worse");
  assert.equal(slipped.fields.targetEndDate.days, 92);

  const pulled = compareVersions(version(), version({ targetEndDate: "2026-05-31" }));
  assert.equal(pulled.fields.targetEndDate.direction, "better");
  assert.equal(pulled.fields.targetEndDate.days, -30);
});

test("progress going backwards is worse, which is the interesting case", () => {
  const backwards = compareVersions(version({ percentComplete: 60 }), version({ percentComplete: 45 }));
  assert.equal(backwards.fields.percentComplete.direction, "worse");
  assert.equal(backwards.fields.percentComplete.delta, -15);
});

test("the headline names the most consequential move, not the first one found", () => {
  /* Health outranks everything: it is the column the CIO reads first. */
  const many = compareVersions(
    version({ health: "Green", percentComplete: 40, openRisks: 1 }),
    version({ health: "Red", percentComplete: 55, openRisks: 4 })
  );
  assert.match(many.headline, /^health/);
  assert.equal(Object.keys(many.fields).length, 3);
});

test("a change with no tracked field moving is not a change at all", () => {
  /* recordedAt always differs between two rows; it must not count. */
  const change = compareVersions(version(), version({ recordedAt: "2026-08-25T09:00:00.000Z" }));
  assert.equal(change, null);
});

test("money moves are reported, and a spend crossing its budget is called out", () => {
  const overspent = compareVersions(version({ spent: 300 }), version({ spent: 1200 }));
  assert.equal(overspent.fields.spent.delta, 900);
  assert.equal(overspent.fields.spent.direction, "worse");
  assert.equal(overspent.crossedBudget, true);

  const under = compareVersions(version({ spent: 300 }), version({ spent: 400 }));
  assert.equal(under.crossedBudget, false);
});

test("every tracked field is actually compared", () => {
  /* A field added to TRACKED_FIELDS but not handled would silently never
     report a change. Drive the assertion off the list itself. */
  for (const field of TRACKED_FIELDS) {
    const before = version();
    const after = version({ [field]: bump(before[field]) });
    const change = compareVersions(before, after);
    assert.ok(change, `${field} moved but compareVersions saw nothing`);
    assert.ok(change.fields[field], `${field} moved but is missing from fields`);
  }
});

function bump(value) {
  if (typeof value === "number") return value + 7;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "2027-01-01";
  return `${value}-moved`;
}
