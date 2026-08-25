import test from "node:test";
import assert from "node:assert/strict";
import { hashBytes, hashProject, HASHED_FIELDS, HASHED_CHILDREN } from "../../server/ingest/hash.js";
import { ingestFile } from "../../server/ingest.js";

const project = (over = {}) => ({
  id: "PRJ-1", name: "A Project", description: "", department: "IT", pillar: "Core",
  program: "", parentId: null, owner: "An Owner", sponsor: "A Sponsor", vendor: "",
  status: "In Progress", health: "Amber", priority: "High", phase: "Execution",
  approvalDate: "2025-01-01", startDate: "2025-06-01", targetEndDate: "2026-06-30",
  actualEndDate: null, budget: 1000, spent: 400, percentComplete: 45, currency: "AED",
  lastUpdated: "2026-08-20", sourceFile: "master.xlsx",
  milestones: [], updates: [], risks: [], questions: [],
  ...over,
});

test("the same bytes hash the same, different bytes do not", () => {
  assert.equal(hashBytes(Buffer.from("abc")), hashBytes(Buffer.from("abc")));
  assert.notEqual(hashBytes(Buffer.from("abc")), hashBytes(Buffer.from("abd")));
  assert.match(hashBytes(Buffer.from("abc")), /^[0-9a-f]{64}$/);
});

test("an unchanged project hashes the same however the object was built", () => {
  const a = project();
  const b = { ...project(), extraFieldNobodyAskedFor: true };
  assert.equal(hashProject(a), hashProject(b), "an unknown field changed the hash");
});

test("all 23 hashed fields are detected when changed", () => {
  const original = hashProject(project());
  /* Each field gets a mutation appropriate to its type. For non-null starting values,
     we change them; for nulls, we set a value. This ensures every field is observed. */
  const mutations = {
    id: "PRJ-2", name: "Different", description: "X", department: "HR", pillar: "Strategic",
    program: "Y", parentId: "PARENT-1", owner: "Other", sponsor: "Different", vendor: "Z",
    status: "Completed", health: "Red", priority: "Critical", phase: "Planning",
    approvalDate: "2025-02-01", startDate: "2025-07-01", targetEndDate: "2026-07-31",
    actualEndDate: "2026-08-31", budget: 2000, spent: 500, percentComplete: 50, currency: "USD",
    lastUpdated: "2026-08-21",
  };

  for (const field of HASHED_FIELDS) {
    const mutated = project({ [field]: mutations[field] });
    assert.notEqual(
      hashProject(mutated), original,
      `field ${field} (=${mutations[field]}) does not change the hash`,
    );
  }
});

test("which workbook a project came from is not part of its content", () => {
  /* Moving a project between workbooks is not a change to the project. */
  assert.equal(hashProject(project()), hashProject(project({ sourceFile: "other.xlsx" })));
});

test("children count as content, because the drill-down shows them", () => {
  const withRisk = project({ risks: [{ title: "A risk", severity: "High", status: "Open" }] });
  assert.notEqual(hashProject(project()), hashProject(withRisk));

  const sameRisk = project({ risks: [{ title: "A risk", severity: "High", status: "Open" }] });
  assert.equal(hashProject(withRisk), hashProject(sameRisk));
});

test("child order from the workbook does not change the hash", () => {
  const one = project({ milestones: [{ name: "A" }, { name: "B" }] });
  const two = project({ milestones: [{ name: "B" }, { name: "A" }] });
  assert.equal(hashProject(one), hashProject(two), "row order in the sheet counted as a change");
});

test("hashBytes refuses a string to prevent vault collision from re-encoding", () => {
  assert.throws(
    () => hashBytes("abc"),
    (err) => err instanceof TypeError && err.message.includes("requires a Buffer"),
  );
});

test("a Date object hashes differently from its ISO string (regression: input contract)", () => {
  /* Date object vs. ISO string are logically identical, but this function treats them
     as different content. The ingest pipeline produces ISO strings; if someone passes
     a Date, this test locks in the current (different) hash so a silent corruption
     does not go unnoticed. */
  const withDate = project({ approvalDate: new Date("2025-01-01") });
  const withString = project({ approvalDate: "2025-01-01" });
  assert.notEqual(hashProject(withDate), hashProject(withString),
    "Date object should hash differently from ISO string");
});

test("non-finite numbers hash like null (regression: input contract)", () => {
  /* NaN and Infinity both JSON.stringify to null. If the pipeline produces a
     non-finite number, it will hash identically to null, silently creating history
     confusion. This test locks in today's behaviour so a serialiser change cannot
     alter it unnoticed. */
  const withNaN = project({ budget: NaN });
  const withInfinity = project({ budget: Infinity });
  const withNull = project({ budget: null });
  assert.equal(hashProject(withNaN), hashProject(withNull));
  assert.equal(hashProject(withInfinity), hashProject(withNull));
});

test("every field the ingester produces is either hashed or deliberately ignored", () => {
  /* A field added to the pipeline but not to HASHED_FIELDS silently stops counting
     as a change, and nobody finds out until they ask when something went Red. */
  const parsed = ingestFile("sample-data/GCIO_Portfolio_Master.xlsx");
  assert.equal(parsed.ok, true, parsed.error);

  const IGNORED = new Set(["sourceFile"]); // not content: see hash.js
  const known = new Set([...HASHED_FIELDS, ...HASHED_CHILDREN, ...IGNORED]);

  const unaccounted = new Set();
  for (const project of parsed.projects) {
    for (const key of Object.keys(project)) if (!known.has(key)) unaccounted.add(key);
  }
  assert.deepEqual([...unaccounted].sort(), [],
    "these fields reach hashProject but are neither hashed nor explicitly ignored");
});
