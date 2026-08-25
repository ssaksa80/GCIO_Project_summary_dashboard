import test from "node:test";
import assert from "node:assert/strict";
import { hashBytes, hashProject } from "../../server/ingest/hash.js";

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

test("a changed field changes the hash", () => {
  assert.notEqual(hashProject(project()), hashProject(project({ health: "Red" })));
  assert.notEqual(hashProject(project()), hashProject(project({ percentComplete: 46 })));
  assert.notEqual(hashProject(project()), hashProject(project({ targetEndDate: "2026-07-31" })));
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
