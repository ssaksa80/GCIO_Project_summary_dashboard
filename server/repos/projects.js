/**
 * Portfolio projects and their child records.
 *
 * Child collections (milestones, updates, risks, questions) are stored as JSON
 * payloads in one table rather than four typed ones. They are read and written
 * whole, per project, and never queried by their internals — a typed table per
 * collection would buy nothing and cost four migrations every time the workbook
 * grows a column.
 */
import { sql } from "../db/executor.js";

const CHILD_KINDS = ["milestones", "updates", "risks", "questions"];

const text = (v) => (v == null ? null : typeof v === "string" ? v : String(v));
const date = (v) => (v ? new Date(v) : null);
const money = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d || null);

function rowToProject(r) {
  return {
    id: r.ProjectId,
    name: r.Name,
    description: r.Description || "",
    department: r.Department || "Unassigned",
    pillar: r.Pillar || "General",
    program: r.Program || "",
    parentId: r.ParentId || null,
    owner: r.Owner || "",
    sponsor: r.Sponsor || "",
    vendor: r.Vendor || "",
    status: r.Status,
    health: r.Health,
    priority: r.Priority,
    phase: r.Phase || "Execution",
    approvalDate: iso(r.ApprovalDate),
    startDate: iso(r.StartDate),
    targetEndDate: iso(r.TargetEndDate),
    actualEndDate: iso(r.ActualEndDate),
    budget: Number(r.Budget) || 0,
    spent: Number(r.Spent) || 0,
    percentComplete: Number(r.PercentComplete) || 0,
    currency: r.Currency || "AED",
    lastUpdated: iso(r.LastUpdated),
    sourceFile: r.SourceFile,
    milestones: [],
    updates: [],
    risks: [],
    questions: [],
  };
}

export function projectsRepo(ex) {
  return {
    /**
     * Every project with its children attached, in the shape the domain code
     * already expects from the in-memory store.
     * @returns {Promise<object[]>}
     */
    async all() {
      const { recordset } = await ex.query(`
        SELECT ProjectId, Name, Description, Department, Pillar, Program, ParentId,
               Owner, Sponsor, Vendor, Status, Health, Priority, Phase,
               ApprovalDate, StartDate, TargetEndDate, ActualEndDate,
               Budget, Spent, PercentComplete, Currency, LastUpdated, SourceFile
        FROM dbo.Project
      `);
      const projects = recordset.map(rowToProject);
      if (projects.length === 0) return projects;

      const byId = new Map(projects.map((p) => [p.id, p]));
      const { recordset: children } = await ex.query(
        "SELECT ProjectId, Kind, Payload FROM dbo.ProjectChild ORDER BY Id"
      );
      for (const row of children) {
        const project = byId.get(row.ProjectId);
        if (!project || !CHILD_KINDS.includes(row.Kind)) continue;
        try {
          project[row.Kind].push(JSON.parse(row.Payload));
        } catch {
          /* One unreadable child row must not lose the whole portfolio. */
        }
      }
      return projects;
    },

    /**
     * Replace everything one workbook owns, in a single transaction: a partial
     * write would leave the dashboard describing two different ingests.
     * @param {string} sourceFile
     * @param {object[]} projects
     */
    async replaceForFile(sourceFile, projects) {
      return ex.tx(async (t) => {
        const fileParam = () => ({ name: "file", type: sql.NVarChar(260), value: text(sourceFile) });

        await t.query("DELETE FROM dbo.ProjectChild WHERE SourceFile = @file", [fileParam()]);
        await t.query("DELETE FROM dbo.Project WHERE SourceFile = @file", [fileParam()]);

        for (const p of projects || []) {
          await t.query(`
            INSERT INTO dbo.Project
              (ProjectId, Name, Description, Department, Pillar, Program, ParentId,
               Owner, Sponsor, Vendor, Status, Health, Priority, Phase,
               ApprovalDate, StartDate, TargetEndDate, ActualEndDate,
               Budget, Spent, PercentComplete, Currency, LastUpdated, SourceFile, IngestedAt)
            VALUES
              (@id, @name, @description, @department, @pillar, @program, @parentId,
               @owner, @sponsor, @vendor, @status, @health, @priority, @phase,
               @approvalDate, @startDate, @targetEndDate, @actualEndDate,
               @budget, @spent, @pct, @currency, @lastUpdated, @file, SYSUTCDATETIME())
          `, [
            { name: "id", type: sql.NVarChar(60), value: text(p.id) },
            { name: "name", type: sql.NVarChar(400), value: text(p.name) },
            { name: "description", type: sql.NVarChar(sql.MAX), value: text(p.description) },
            { name: "department", type: sql.NVarChar(200), value: text(p.department) },
            { name: "pillar", type: sql.NVarChar(200), value: text(p.pillar) },
            { name: "program", type: sql.NVarChar(200), value: text(p.program) },
            { name: "parentId", type: sql.NVarChar(60), value: text(p.parentId) },
            { name: "owner", type: sql.NVarChar(200), value: text(p.owner) },
            { name: "sponsor", type: sql.NVarChar(200), value: text(p.sponsor) },
            { name: "vendor", type: sql.NVarChar(200), value: text(p.vendor) },
            { name: "status", type: sql.NVarChar(40), value: text(p.status) },
            { name: "health", type: sql.NVarChar(20), value: text(p.health) },
            { name: "priority", type: sql.NVarChar(20), value: text(p.priority) },
            { name: "phase", type: sql.NVarChar(40), value: text(p.phase) },
            { name: "approvalDate", type: sql.Date, value: date(p.approvalDate) },
            { name: "startDate", type: sql.Date, value: date(p.startDate) },
            { name: "targetEndDate", type: sql.Date, value: date(p.targetEndDate) },
            { name: "actualEndDate", type: sql.Date, value: date(p.actualEndDate) },
            { name: "budget", type: sql.Decimal(19, 2), value: money(p.budget) },
            { name: "spent", type: sql.Decimal(19, 2), value: money(p.spent) },
            { name: "pct", type: sql.Decimal(5, 2), value: money(p.percentComplete) },
            { name: "currency", type: sql.NVarChar(10), value: text(p.currency) || "AED" },
            { name: "lastUpdated", type: sql.Date, value: date(p.lastUpdated) },
            fileParam(),
          ]);

          for (const kind of CHILD_KINDS) {
            for (const child of p[kind] || []) {
              await t.query(`
                INSERT INTO dbo.ProjectChild (ProjectId, Kind, Payload, SourceFile)
                VALUES (@projectId, @kind, @payload, @file)
              `, [
                { name: "projectId", type: sql.NVarChar(60), value: text(p.id) },
                { name: "kind", type: sql.VarChar(12), value: kind },
                { name: "payload", type: sql.NVarChar(sql.MAX), value: JSON.stringify(child) },
                fileParam(),
              ]);
            }
          }
        }
        return (projects || []).length;
      });
    },

    /** Drop a deleted workbook's projects and their children. */
    async removeFile(sourceFile) {
      return ex.tx(async (t) => {
        const fileParam = () => ({ name: "file", type: sql.NVarChar(260), value: text(sourceFile) });
        await t.query("DELETE FROM dbo.ProjectChild WHERE SourceFile = @file", [fileParam()]);
        const { rowsAffected } = await t.query("DELETE FROM dbo.Project WHERE SourceFile = @file", [fileParam()]);
        return Array.isArray(rowsAffected) ? rowsAffected[0] : 0;
      });
    },

    /** Which workbooks are represented, and when each was last ingested. */
    async sourceFiles() {
      const { recordset } = await ex.query(`
        SELECT SourceFile, COUNT(*) AS Projects, MAX(IngestedAt) AS IngestedAt
        FROM dbo.Project GROUP BY SourceFile ORDER BY SourceFile
      `);
      return recordset.map((r) => ({
        sourceFile: r.SourceFile,
        projects: Number(r.Projects) || 0,
        ingestedAt: r.IngestedAt instanceof Date ? r.IngestedAt.toISOString() : String(r.IngestedAt),
      }));
    },
  };
}
