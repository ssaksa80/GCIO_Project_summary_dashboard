import test from "node:test";
import assert from "node:assert/strict";
import { projectVersionsRepo } from "../../server/repos/projectVersions.js";

/* Same shape as the helper in history.test.js. Note repos.test.js has a THIRD
   variant with a { recordsets } signature -- do not copy that one. */
function scriptedExecutor(recordsets = {}) {
  const statements = [];
  const ex = {
    statements,
    async query(text, params) {
      statements.push({ text: text.trim(), params: params || [] });
      const needles = Object.keys(recordsets).sort((a, b) => b.length - a.length);
      for (const needle of needles) {
        if (text.includes(needle)) {
          const rows = recordsets[needle];
          return { recordset: rows, rowsAffected: [rows.length] };
        }
      }
      return { recordset: [], rowsAffected: [0] };
    },
    async tx(fn) { return fn(ex); },
  };
  return ex;
}

const row = (over = {}) => ({
  ProjectId: "PRJ-1", Bucket: "current",
  RecordedAt: new Date("2026-08-25T09:00:00Z"),
  ContentHash: "h2", Status: "In Progress", Health: "Red",
  PercentComplete: 45, Budget: 1000, Spent: 400,
  OpenRisks: 2, OpenQuestions: 1,
  TargetEndDate: new Date("2026-06-30T00:00:00Z"),
  ...over,
});

test("a project with a baseline and a newer version comes back as a pair", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.ProjectVersion": [
      row({ Bucket: "baseline", Health: "Green", RecordedAt: new Date("2026-08-18T09:00:00Z"), ContentHash: "h1" }),
      row({ Bucket: "current", Health: "Red" }),
    ],
  });

  const changes = await projectVersionsRepo(ex).changedSince("2026-08-18");
  assert.equal(changes.size, 1);
  const entry = changes.get("PRJ-1");
  assert.equal(entry.baseline.health, "Green");
  assert.equal(entry.current.health, "Red");
  assert.equal(entry.baseline.recordedAt, "2026-08-18T09:00:00.000Z");
});

test("a project first recorded inside the period has no baseline, and says so", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.ProjectVersion": [row({ Bucket: "current" })],
  });

  const changes = await projectVersionsRepo(ex).changedSince("2026-08-18");
  const entry = changes.get("PRJ-1");
  assert.equal(entry.baseline, null, "a baseline was invented");
  assert.equal(entry.current.health, "Red");
  assert.equal(entry.trackedSince, "2026-08-25T09:00:00.000Z");
});

test("a project whose hash never moved is left out entirely", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.ProjectVersion": [
      row({ Bucket: "baseline", ContentHash: "same" }),
      row({ Bucket: "current", ContentHash: "same" }),
    ],
  });

  const changes = await projectVersionsRepo(ex).changedSince("2026-08-18");
  assert.equal(changes.size, 0, "an unchanged project was reported as changed");
});

test("the date is bound as a parameter, never interpolated", async () => {
  const ex = scriptedExecutor();
  await projectVersionsRepo(ex).changedSince("2026-08-18");
  const select = ex.statements.find((s) => s.text.includes("FROM dbo.ProjectVersion"));
  assert.ok(select.params.some((p) => p.name === "since"), "the date was not bound");
  assert.ok(!select.text.includes("2026-08-18"), "the date was interpolated into the SQL");
});

test("dates come back as ISO strings the section engine can compare", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.ProjectVersion": [
      row({ Bucket: "baseline", ContentHash: "h1" }),
      row({ Bucket: "current", ContentHash: "h2", TargetEndDate: new Date("2026-09-30T00:00:00Z") }),
    ],
  });

  const entry = (await projectVersionsRepo(ex).changedSince("2026-08-18")).get("PRJ-1");
  assert.equal(entry.current.targetEndDate, "2026-09-30");
  assert.equal(typeof entry.current.recordedAt, "string");
});

test("nothing recorded yet is an empty map, not a failure", async () => {
  const ex = scriptedExecutor();
  const changes = await projectVersionsRepo(ex).changedSince("2026-08-18");
  assert.equal(changes.size, 0);
});
