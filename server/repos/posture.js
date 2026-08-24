/**
 * Security posture rows (section 5).
 *
 * Repository factory in DEDB's style: takes an Executor, returns the operations,
 * knows nothing about Express. Every dynamic value is bound as a typed
 * parameter — nothing is interpolated into SQL.
 */
import { sql } from "../db/executor.js";

/** Coerce to something a text bind will accept, as DEDB's repos do. */
const toDbText = (v) =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);

const toDbDate = (v) => (v ? new Date(v) : null);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function rowToObj(r) {
  return {
    domain: r.Domain,
    control: r.Control || "",
    status: r.Status,
    score: num(r.Score),
    target: num(r.Target),
    owner: r.Owner || "",
    lastAssessed: r.LastAssessed ? r.LastAssessed.toISOString().slice(0, 10) : null,
    nextReview: r.NextReview ? r.NextReview.toISOString().slice(0, 10) : null,
    openFindings: num(r.OpenFindings),
    criticalFindings: num(r.CriticalFindings),
    projectId: r.ProjectId || null,
    notes: r.Notes || "",
    sourceFile: r.SourceFile,
  };
}

export function postureRepo(ex) {
  return {
    /** Current posture across every source file, worst status first. */
    async list() {
      const { recordset } = await ex.query(`
        SELECT Domain, Control, Status, Score, Target, Owner, LastAssessed, NextReview,
               OpenFindings, CriticalFindings, ProjectId, Notes, SourceFile
        FROM dbo.PostureDomain
        ORDER BY Domain, Control
      `);
      return recordset.map(rowToObj);
    },

    /**
     * Replace everything one workbook owns, in a single transaction: a partial
     * write would leave the section describing two different assessments.
     */
    async replaceForFile(sourceFile, rows) {
      return ex.tx(async (t) => {
        await t.query("DELETE FROM dbo.PostureDomain WHERE SourceFile = @file", [
          { name: "file", type: sql.NVarChar(260), value: toDbText(sourceFile) },
        ]);

        for (const row of rows || []) {
          await t.query(`
            INSERT INTO dbo.PostureDomain
              (Domain, Control, Status, Score, Target, Owner, LastAssessed, NextReview,
               OpenFindings, CriticalFindings, ProjectId, Notes, SourceFile)
            VALUES
              (@domain, @control, @status, @score, @target, @owner, @lastAssessed, @nextReview,
               @openFindings, @criticalFindings, @projectId, @notes, @file)
          `, [
            { name: "domain", type: sql.NVarChar(200), value: toDbText(row.domain) },
            { name: "control", type: sql.NVarChar(300), value: toDbText(row.control) },
            { name: "status", type: sql.NVarChar(40), value: toDbText(row.status) },
            { name: "score", type: sql.Decimal(5, 2), value: num(row.score) },
            { name: "target", type: sql.Decimal(5, 2), value: num(row.target) },
            { name: "owner", type: sql.NVarChar(200), value: toDbText(row.owner) },
            { name: "lastAssessed", type: sql.Date, value: toDbDate(row.lastAssessed) },
            { name: "nextReview", type: sql.Date, value: toDbDate(row.nextReview) },
            { name: "openFindings", type: sql.Int, value: num(row.openFindings) },
            { name: "criticalFindings", type: sql.Int, value: num(row.criticalFindings) },
            { name: "projectId", type: sql.NVarChar(60), value: row.projectId ? toDbText(row.projectId) : null },
            { name: "notes", type: sql.NVarChar(sql.MAX), value: toDbText(row.notes) },
            { name: "file", type: sql.NVarChar(260), value: toDbText(sourceFile) },
          ]);
        }
        return (rows || []).length;
      });
    },

    /** Drop a deleted workbook's rows. */
    async removeFile(sourceFile) {
      const { rowsAffected } = await ex.query("DELETE FROM dbo.PostureDomain WHERE SourceFile = @file", [
        { name: "file", type: sql.NVarChar(260), value: toDbText(sourceFile) },
      ]);
      return Array.isArray(rowsAffected) ? rowsAffected[0] : 0;
    },
  };
}
