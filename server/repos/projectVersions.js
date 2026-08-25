/**
 * Append-only project history.
 *
 * A row is written only when a project's content hash differs from the newest
 * one already recorded, so re-saving a workbook does not manufacture history.
 * dbo.Project remains the current snapshot the dashboard reads; this table is
 * purely additive, and a defect here cannot break today's view.
 */
import { sql } from "../db/executor.js";

const openCount = (items, kind) =>
  (items || []).filter((item) => {
    const status = String(item.status || "Open").toLowerCase();
    return kind === "risk" ? status !== "closed" : status !== "closed" && status !== "answered";
  }).length;

const toDate = (v) => (v ? new Date(v) : null);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d || null);

export function projectVersionsRepo(ex) {
  return {
    /**
     * Append a version for each candidate whose content hash differs from the
     * newest one already on file.
     * @param {{project: object, hash: string}[]} candidates
     * @param {{ingestRunId?: number|null}} [context]
     * @returns {Promise<number>} how many versions were written
     */
    async appendChanged(candidates, { ingestRunId = null } = {}) {
      /* Before opening a transaction: an empty ingest must not take a lock,
         and it must not touch the database at all. */
      if (!candidates || candidates.length === 0) return 0;

      const ids = candidates.map((c) => c.project.id);

      /* The bulk lookup below joins ids with commas for STRING_SPLIT. A comma
         in an id would split it in two, match nothing, and silently append a
         version for a project that had not actually changed. */
      const offending = ids.filter((id) => String(id).includes(","));
      if (offending.length) {
        throw new Error(`project ids must not contain a comma: ${offending.join(" ")}`);
      }

      /* Reading the newest hash and inserting the changed rows happen inside
         one transaction. The watcher handles events serially today, so this
         is not reachable yet, but a manual replay running alongside it could
         interleave with it: two ingests of the same project racing between
         the read and the write would otherwise both see "no newest hash yet"
         and each append a row, which is exactly what this method exists to
         prevent. */
      return ex.tx(async (tx) => {
        /* One query for the newest hash of every project in this file, rather
           than one per project: a 500-project workbook should not cost 500
           round trips to discover that nothing changed. */
        const { recordset } = await tx.query(`
          SELECT ProjectId, ContentHash FROM (
            SELECT ProjectId, ContentHash,
                   ROW_NUMBER() OVER (PARTITION BY ProjectId ORDER BY RecordedAt DESC, ProjectVersionId DESC) AS rn
            FROM dbo.ProjectVersion
            WHERE ProjectId IN (SELECT value FROM STRING_SPLIT(@ids, ','))
          ) newest WHERE rn = 1
        `, [{ name: "ids", type: sql.NVarChar(sql.MAX), value: ids.join(",") }]);

        const newestByProject = new Map(recordset.map((r) => [r.ProjectId, r.ContentHash]));

        /* One row at a time inside the transaction: for the scale this project
           runs at (workbooks of a few hundred projects, ingested at most a
           few times an hour) the round trips are cheap and the code stays
           simple. A table-valued parameter or bulk insert would be the right
           call at a much larger scale, but is not warranted here. */
        let written = 0;
        for (const { project, hash } of candidates) {
          if (newestByProject.get(project.id) === hash) continue;

          await tx.query(`
            INSERT INTO dbo.ProjectVersion
              (ProjectId, ContentHash, IngestRunId, RecordedAt, Name, Department, Status, Health,
               Priority, Phase, Owner, TargetEndDate, ActualEndDate, Budget, Spent, PercentComplete,
               OpenRisks, OpenQuestions, Payload)
            VALUES
              (@projectId, @hash, @runId, SYSUTCDATETIME(), @name, @department, @status, @health,
               @priority, @phase, @owner, @targetEnd, @actualEnd, @budget, @spent, @pct,
               @openRisks, @openQuestions, @payload)
          `, [
            { name: "projectId", type: sql.NVarChar(60), value: project.id },
            { name: "hash", type: sql.Char(64), value: hash },
            { name: "runId", type: sql.BigInt, value: ingestRunId },
            { name: "name", type: sql.NVarChar(400), value: project.name },
            { name: "department", type: sql.NVarChar(200), value: project.department || null },
            { name: "status", type: sql.NVarChar(40), value: project.status },
            { name: "health", type: sql.NVarChar(20), value: project.health },
            { name: "priority", type: sql.NVarChar(20), value: project.priority },
            { name: "phase", type: sql.NVarChar(40), value: project.phase || null },
            { name: "owner", type: sql.NVarChar(200), value: project.owner || null },
            { name: "targetEnd", type: sql.Date, value: toDate(project.targetEndDate) },
            { name: "actualEnd", type: sql.Date, value: toDate(project.actualEndDate) },
            { name: "budget", type: sql.Decimal(19, 2), value: Number(project.budget) || 0 },
            { name: "spent", type: sql.Decimal(19, 2), value: Number(project.spent) || 0 },
            { name: "pct", type: sql.Decimal(5, 2), value: Number(project.percentComplete) || 0 },
            { name: "openRisks", type: sql.Int, value: openCount(project.risks, "risk") },
            { name: "openQuestions", type: sql.Int, value: openCount(project.questions, "question") },
            { name: "payload", type: sql.NVarChar(sql.MAX), value: JSON.stringify(project) },
          ]);
          written += 1;
        }
        return written;
      });
    },

    /**
     * One project's recorded history, newest first.
     * @param {string} projectId
     * @param {{limit?: number}} [options]
     * @returns {Promise<object[]>}
     */
    async historyFor(projectId, { limit = 50 } = {}) {
      const { recordset } = await ex.query(`
        SELECT TOP (@limit) RecordedAt, ContentHash, Status, Health, PercentComplete,
               Budget, Spent, OpenRisks, OpenQuestions, TargetEndDate
        FROM dbo.ProjectVersion
        WHERE ProjectId = @id
        ORDER BY RecordedAt DESC, ProjectVersionId DESC
      `, [
        { name: "id", type: sql.NVarChar(60), value: projectId },
        { name: "limit", type: sql.Int, value: Math.min(500, Math.max(1, Number(limit) || 50)) },
      ]);

      return recordset.map((r) => ({
        recordedAt: r.RecordedAt instanceof Date ? r.RecordedAt.toISOString() : String(r.RecordedAt),
        contentHash: r.ContentHash,
        status: r.Status,
        health: r.Health,
        percentComplete: Number(r.PercentComplete),
        budget: Number(r.Budget),
        spent: Number(r.Spent),
        openRisks: r.OpenRisks,
        openQuestions: r.OpenQuestions,
        targetEndDate: iso(r.TargetEndDate),
      }));
    },
  };
}
