/**
 * One row per ingest attempt, successful or not.
 *
 * This is the answer to "why does the dashboard not show last night's file":
 * either there is no run, or there is a run with an outcome and a reason.
 */
import { sql } from "../db/executor.js";

const ERROR_MAX = 1000;

export function ingestRunsRepo(ex) {
  return {
    /**
     * @param {{fileName: string, trigger: "watcher"|"upload"|"boot"|"replay", sourceFileId?: number|null}} run
     * @returns {Promise<number>} the run id
     */
    async start({ fileName, trigger, sourceFileId = null }) {
      const { recordset } = await ex.query(`
        INSERT INTO dbo.IngestRun (SourceFileId, FileName, TriggerSource, StartedAt)
        OUTPUT INSERTED.IngestRunId
        VALUES (@sourceFileId, @name, @trigger, SYSUTCDATETIME())
      `, [
        { name: "sourceFileId", type: sql.BigInt, value: sourceFileId },
        { name: "name", type: sql.NVarChar(260), value: fileName },
        { name: "trigger", type: sql.VarChar(16), value: trigger },
      ]);
      return Number(recordset[0].IngestRunId);
    },

    /**
     * @param {number} runId
     * @param {{outcome: "applied"|"unchanged"|"failed"|"removed", projectsSeen?: number,
     *          projectsChanged?: number, postureRows?: number, error?: string|null}} result
     */
    async finish(runId, { outcome, projectsSeen = 0, projectsChanged = 0, postureRows = 0, error = null }) {
      await ex.query(`
        UPDATE dbo.IngestRun
           SET FinishedAt = SYSUTCDATETIME(), Outcome = @outcome,
               ProjectsSeen = @seen, ProjectsChanged = @changed,
               PostureRows = @posture, Error = @error
         WHERE IngestRunId = @id
      `, [
        { name: "id", type: sql.BigInt, value: runId },
        { name: "outcome", type: sql.VarChar(16), value: outcome },
        { name: "seen", type: sql.Int, value: Number(projectsSeen) || 0 },
        { name: "changed", type: sql.Int, value: Number(projectsChanged) || 0 },
        { name: "posture", type: sql.Int, value: Number(postureRows) || 0 },
        /* Truncated rather than rejected: a run must always be closed, and a
           5,000-character parser message must not be what stops that. */
        { name: "error", type: sql.NVarChar(ERROR_MAX), value: error ? String(error).slice(0, ERROR_MAX) : null },
      ]);
    },

    /** Newest first. */
    async recent({ limit = 200 } = {}) {
      const { recordset } = await ex.query(`
        SELECT TOP (@limit) IngestRunId, FileName, TriggerSource, StartedAt, FinishedAt,
               Outcome, ProjectsSeen, ProjectsChanged, PostureRows, Error
        FROM dbo.IngestRun ORDER BY StartedAt DESC
      `, [{ name: "limit", type: sql.Int, value: Math.min(500, Math.max(1, Number(limit) || 200)) }]);

      return recordset.map((r) => ({
        id: Number(r.IngestRunId),
        fileName: r.FileName,
        trigger: r.TriggerSource,
        startedAt: r.StartedAt.toISOString(),
        finishedAt: r.FinishedAt ? r.FinishedAt.toISOString() : null,
        outcome: r.Outcome,
        projectsSeen: r.ProjectsSeen,
        projectsChanged: r.ProjectsChanged,
        postureRows: r.PostureRows,
        error: r.Error || null,
      }));
    },
  };
}
