/**
 * The projects repository and the SQL-backed store, against a scripted
 * executor. What matters: a workbook's rows are replaced atomically, children
 * survive the round trip, and the read model presents the same surface the
 * domain code already gets from the in-memory store.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { projectsRepo } from "../../server/repos/projects.js";
import { SqlStore } from "../../server/store/sqlStore.js";
import { buildSummary } from "../../server/summarize.js";

function scriptedExecutor({ recordsets = {} } = {}) {
  const statements = [];
  const ex = {
    statements,
    async query(text, params) {
      statements.push({ text: text.trim(), params: params || [] });
      /* Longest needle first: "FROM dbo.ProjectChild" also contains
         "FROM dbo.Project", and matching the shorter one would hand the child
         query the parent rows. */
      const needles = Object.keys(recordsets).sort((a, b) => b.length - a.length);
      for (const needle of needles) {
        if (text.includes(needle)) {
          const rows = recordsets[needle];
          return { recordset: rows, rowsAffected: [rows.length] };
        }
      }
      return { recordset: [], rowsAffected: [0] };
    },
    async tx(fn) {
      statements.push({ text: "BEGIN TRAN", params: [] });
      const out = await fn(ex);
      statements.push({ text: "COMMIT", params: [] });
      return out;
    },
  };
  return ex;
}

const projectRow = (over = {}) => ({
  ProjectId: "PRJ-1", Name: "A Project", Description: "", Department: "IT", Pillar: "Core",
  Program: "", ParentId: null, Owner: "An Owner", Sponsor: "A Sponsor", Vendor: "",
  Status: "In Progress", Health: "Amber", Priority: "High", Phase: "Execution",
  ApprovalDate: new Date("2025-01-01T00:00:00Z"), StartDate: new Date("2025-06-01T00:00:00Z"),
  TargetEndDate: new Date("2026-06-30T00:00:00Z"), ActualEndDate: null,
  Budget: 1000000, Spent: 400000, PercentComplete: 45, Currency: "AED",
  LastUpdated: new Date("2026-08-20T00:00:00Z"), SourceFile: "master.xlsx",
  ...over,
});

test("a project round-trips into the shape the domain code expects", async () => {
  const ex = scriptedExecutor({
    recordsets: {
      "FROM dbo.Project": [projectRow()],
      "FROM dbo.ProjectChild": [
        { ProjectId: "PRJ-1", Kind: "risks", Payload: JSON.stringify({ title: "A risk", severity: "High", status: "Open" }) },
        { ProjectId: "PRJ-1", Kind: "questions", Payload: JSON.stringify({ text: "Proceed?", source: "workbook", status: "Open" }) },
      ],
    },
  });

  const [project] = await projectsRepo(ex).all();
  assert.equal(project.id, "PRJ-1");
  assert.equal(project.approvalDate, "2025-01-01");
  assert.equal(project.budget, 1000000);
  assert.equal(project.risks.length, 1);
  assert.equal(project.questions[0].text, "Proceed?");
  assert.deepEqual(project.milestones, []);
});

test("an unreadable child row is skipped rather than losing the portfolio", async () => {
  const ex = scriptedExecutor({
    recordsets: {
      "FROM dbo.Project": [projectRow()],
      "FROM dbo.ProjectChild": [
        { ProjectId: "PRJ-1", Kind: "risks", Payload: "{not json" },
        { ProjectId: "PRJ-1", Kind: "risks", Payload: JSON.stringify({ title: "Good", severity: "Low", status: "Open" }) },
      ],
    },
  });

  const [project] = await projectsRepo(ex).all();
  assert.equal(project.risks.length, 1);
  assert.equal(project.risks[0].title, "Good");
});

test("replacing a workbook deletes children before parents, inside one transaction", async () => {
  const ex = scriptedExecutor();
  await projectsRepo(ex).replaceForFile("master.xlsx", [
    { id: "PRJ-1", name: "One", status: "In Progress", health: "Green", priority: "High",
      milestones: [{ name: "M1" }], updates: [], risks: [], questions: [] },
  ]);

  const texts = ex.statements.map((s) => s.text);
  assert.equal(texts[0], "BEGIN TRAN");
  assert.equal(texts.at(-1), "COMMIT");

  const childDelete = texts.findIndex((t) => t.startsWith("DELETE FROM dbo.ProjectChild"));
  const parentDelete = texts.findIndex((t) => t.startsWith("DELETE FROM dbo.Project WHERE"));
  assert.ok(childDelete < parentDelete, "children must be deleted before their parents");
  assert.equal(texts.filter((t) => t.includes("INSERT INTO dbo.ProjectChild")).length, 1);
});

test("no project value reaches the statement text", async () => {
  const ex = scriptedExecutor();
  await projectsRepo(ex).replaceForFile("master.xlsx", [
    { id: "PRJ-1", name: "'); DROP TABLE dbo.Project;--", status: "In Progress",
      health: "Green", priority: "Low", milestones: [], updates: [], risks: [], questions: [] },
  ]);
  for (const stmt of ex.statements) {
    assert.ok(!stmt.text.includes("DROP TABLE"), "a hostile value reached the SQL text");
  }
});

test("the SQL store presents the same read surface as the in-memory one", async () => {
  const repos = {
    projects: { async all() { return [{ ...toDomain(projectRow()), id: "PRJ-1" }]; } },
    posture: { async list() { return [{ domain: "Identity", status: "Partial", score: 60, target: 90, openFindings: 1, criticalFindings: 0 }]; } },
  };
  const store = new SqlStore(repos);
  await store.refresh();

  assert.equal(store.projectCount, 1);
  assert.equal(store.get("PRJ-1").name, "A Project");
  /* Both stores canonicalise the id, so a lower-case lookup still finds it —
     the ids come out of workbooks typed by people. */
  assert.equal(store.get("prj-1").name, "A Project");
  assert.equal(store.get("PRJ-NOPE"), null);
  assert.equal(store.posture().length, 1);
  assert.equal(store.fileCount, 1);
});

test("a summary can be built from the SQL store without changing the domain code", async () => {
  const repos = {
    projects: { async all() { return [toDomain(projectRow())]; } },
    posture: { async list() { return []; } },
  };
  const store = new SqlStore(repos);
  await store.refresh();

  const summary = buildSummary(store, "weekly", "2026-08-24");
  assert.equal(summary.kpis.totalProjects, 1);
  assert.equal(summary.sections.posture.available, false);
  assert.ok(summary.sections.priorities.items.length >= 1);
});

/** The repository's own mapping, reused so the test asserts one shape. */
function toDomain(r) {
  return {
    id: r.ProjectId, name: r.Name, description: "", department: r.Department, pillar: r.Pillar,
    program: "", parentId: null, owner: r.Owner, sponsor: r.Sponsor, vendor: "",
    status: r.Status, health: r.Health, priority: r.Priority, phase: r.Phase,
    approvalDate: "2025-01-01", startDate: "2025-06-01", targetEndDate: "2026-06-30", actualEndDate: null,
    budget: r.Budget, spent: r.Spent, percentComplete: r.PercentComplete, currency: "AED",
    lastUpdated: "2026-08-20", sourceFile: r.SourceFile,
    milestones: [], updates: [], risks: [], questions: [],
  };
}
