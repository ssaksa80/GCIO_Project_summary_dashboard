/**
 * One row per ingest attempt, successful or not.
 *
 * This is the answer to "why does the dashboard not show last night's file":
 * either there is no run, or there is a run with an outcome and a reason.
 */
import { sql } from "../db/executor.js";

const ERROR_MAX = 1000;

/* An event-loop stall becomes visible to a concurrent request at somewhere
   around 50-100ms, and this runs behind a proxy whose request timeout is
   shorter than a second's stall is comfortable with. 500ms is an order of
   magnitude above what today's 14-27 kB workbooks take, and well below the
   point where a request served during an ingest would fail rather than merely
   feel slow. If this starts firing, the decision to defer worker-thread
   parsing has stopped being justified. */
const SLOW_PARSE_MS = 500;

/* Enforced in SQL by CK_IngestRun_TriggerSource / CK_IngestRun_Outcome, which
   fail at runtime with error 547. There is no type checking in this project
   to catch a typo at a call site before then, so it is checked here too — a
   thrown message naming the bad value beats a bare 547 three layers down. */
/* "upload" is a real vocabulary value, not a dead one, but nothing calls
   start() with it today: the upload route writes into the watched folder and
   lets the watcher pick the file up, so the run it produces is always
   trigger "watcher". That is also why SourceFile.UploadedBy is always null in
   practice — see the comment beside `uploadedBy: actor` in sqlStore.js. */
export const INGEST_TRIGGERS = ["watcher", "upload", "boot", "replay"];
export const INGEST_OUTCOMES = ["applied", "unchanged", "failed", "removed"];

/* NVARCHAR(1000) counts UTF-16 code units, so slicing to ERROR_MAX is the
   right length — but the cut can land inside a surrogate pair and leave a
   dangling high surrogate in an admin-facing message. */
function truncate(text) {
  const cut = String(text).slice(0, ERROR_MAX);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function ingestRunsRepo(ex, { logger = console } = {}) {
  return {
    /**
     * @param {{fileName: string, trigger: "watcher"|"upload"|"boot"|"replay", sourceFileId?: number|null}} run
     * @returns {Promise<number>} the run id
     */
    async start({ fileName, trigger, sourceFileId = null }) {
      if (!INGEST_TRIGGERS.includes(trigger)) {
        throw new Error(`unknown ingest trigger '${trigger}' — expected one of ${INGEST_TRIGGERS.join(", ")}`);
      }
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
     *          projectsChanged?: number, postureRows?: number, error?: string|null,
     *          sourceFileId?: number|null, parseMs?: number|null, persistMs?: number|null,
     *          fileName?: string}} result
     *          sourceFileId is optional: omit it (leave undefined) to leave the column
     *          untouched — Task 6 opens the run before the workbook is vaulted, so the id
     *          is not always known yet. parseMs/persistMs are nullable on purpose: a run
     *          rejected before parsing, or one that died before persisting, has no honest
     *          number to report, and a zero would be a lie. fileName only names the run in
     *          the slow-parse warning below — every real caller already has it in scope
     *          (it is what it passed to start()), so this is not a second source of truth.
     */
    async finish(runId, { outcome, projectsSeen = 0, projectsChanged = 0, postureRows = 0,
                          error = null, sourceFileId, parseMs = null, persistMs = null,
                          fileName = null } = {}) {
      if (!INGEST_OUTCOMES.includes(outcome)) {
        throw new Error(`unknown ingest outcome '${outcome}' — expected one of ${INGEST_OUTCOMES.join(", ")}`);
      }

      const { rowsAffected } = await ex.query(`
        UPDATE dbo.IngestRun
           SET FinishedAt = SYSUTCDATETIME(), Outcome = @outcome,
               ProjectsSeen = @seen, ProjectsChanged = @changed,
               PostureRows = @posture, Error = @error,
               SourceFileId = COALESCE(@sourceFileId, SourceFileId),
               ParseMs = @parseMs, PersistMs = @persistMs
         WHERE IngestRunId = @id
      `, [
        { name: "id", type: sql.BigInt, value: runId },
        { name: "outcome", type: sql.VarChar(16), value: outcome },
        { name: "seen", type: sql.Int, value: Number(projectsSeen) || 0 },
        { name: "changed", type: sql.Int, value: Number(projectsChanged) || 0 },
        { name: "posture", type: sql.Int, value: Number(postureRows) || 0 },
        /* Truncated rather than rejected: a run must always be closed, and a
           5,000-character parser message must not be what stops that. */
        { name: "error", type: sql.NVarChar(ERROR_MAX), value: error ? truncate(error) : null },
        { name: "sourceFileId", type: sql.BigInt, value: sourceFileId ?? null },
        { name: "parseMs", type: sql.Int, value: Number.isFinite(parseMs) ? Math.round(parseMs) : null },
        { name: "persistMs", type: sql.Int, value: Number.isFinite(persistMs) ? Math.round(persistMs) : null },
      ]);

      if (!rowsAffected[0]) {
        /* Not thrown: the caller is usually already handling its own failure and
           must not be blocked by ours. But a run that never closed is exactly
           what this table exists to make visible, so it cannot be silent. */
        logger.error?.(`[ingest] run ${runId} was not closed — no such row`);
      }

      if (Number.isFinite(parseMs) && parseMs >= SLOW_PARSE_MS) {
        logger.warn?.(`[ingest] ${fileName ?? `run ${runId}`} took ${parseMs}ms to parse — ` +
          `slow enough to block the event loop; if this becomes normal, revisit the deferred worker-thread parsing`);
      }
    },

    /**
     * The hash of the content currently believed live for a filename, or null.
     *
     * "Live" means the most recently closed run for this file closed applied or
     * unchanged. A failed run proves nothing was applied, and a removed run
     * proves it was taken away — in both cases the next ingest must do the work
     * even if the bytes are identical, or a transient failure would hide a
     * portfolio permanently.
     *
     * @param {string} fileName
     * @returns {Promise<string|null>}
     */
    async liveHashFor(fileName) {
      const { recordset } = await ex.query(`
        SELECT TOP (1) r.Outcome, f.Sha256
        FROM dbo.IngestRun r
        LEFT JOIN dbo.SourceFile f ON f.SourceFileId = r.SourceFileId
        WHERE r.FileName = @name AND r.Outcome IS NOT NULL
        ORDER BY r.StartedAt DESC, r.IngestRunId DESC
      `, [{ name: "name", type: sql.NVarChar(260), value: fileName }]);

      if (!recordset.length) return null;
      const { Outcome, Sha256 } = recordset[0];
      return (Outcome === "applied" || Outcome === "unchanged") && Sha256 ? Sha256 : null;
    },

    /** Newest first. */
    async recent({ limit = 200 } = {}) {
      const { recordset } = await ex.query(`
        SELECT TOP (@limit) IngestRunId, FileName, TriggerSource, StartedAt, FinishedAt,
               Outcome, ProjectsSeen, ProjectsChanged, PostureRows, Error, ParseMs, PersistMs
        FROM dbo.IngestRun ORDER BY StartedAt DESC
      `, [{ name: "limit", type: sql.Int, value: Math.min(500, Math.max(1, Number(limit) || 200)) }]);

      return recordset.map((r) => ({
        id: Number(r.IngestRunId),
        fileName: r.FileName,
        trigger: r.TriggerSource,
        startedAt: r.StartedAt instanceof Date ? r.StartedAt.toISOString() : String(r.StartedAt),
        finishedAt: r.FinishedAt instanceof Date ? r.FinishedAt.toISOString() : (r.FinishedAt || null),
        outcome: r.Outcome,
        projectsSeen: r.ProjectsSeen,
        projectsChanged: r.ProjectsChanged,
        postureRows: r.PostureRows,
        error: r.Error || null,
        parseMs: r.ParseMs ?? null,
        persistMs: r.PersistMs ?? null,
      }));
    },

    /**
     * What the metrics endpoint needs, windowed to the last 7 days so a single
     * cold-cache run does not pin the maxima for the life of the database --
     * MAX() over the whole table never decays, and a metric that cannot decay
     * stops telling an operator anything about the present. `runs` is windowed
     * too, since it is the denominator that makes the maxima interpretable.
     * A window with nothing in it returns nulls, not zeroes: a quiet week is
     * not the same claim as "parsing took 0ms".
     * @returns {Promise<{runs: number, slowestParseMs: number|null,
     *                    slowestPersistMs: number|null, lastFinishedAt: string|null}>}
     */
    async timingSummary() {
      const { recordset } = await ex.query(`
        SELECT COUNT(*) AS runs, MAX(ParseMs) AS slowestParse,
               MAX(PersistMs) AS slowestPersist, MAX(FinishedAt) AS lastFinishedAt
        FROM dbo.IngestRun
        WHERE FinishedAt >= DATEADD(day, -7, SYSUTCDATETIME())
      `);
      const r = recordset[0] || {};
      return {
        runs: Number(r.runs) || 0,
        slowestParseMs: r.slowestParse ?? null,
        slowestPersistMs: r.slowestPersist ?? null,
        lastFinishedAt: r.lastFinishedAt instanceof Date ? r.lastFinishedAt.toISOString() : null,
      };
    },

    /**
     * Ingest attempts grouped by outcome, all-time -- this feeds a Prometheus
     * counter, and a counter that is windowed can go backwards, which is a
     * contradiction a scraper has no way to represent. (Contrast
     * timingSummary() above, which is a gauge and is windowed on purpose.)
     *
     * All four INGEST_OUTCOMES keys are always present, zero-filled: a
     * missing series reads as a gap on a graph, and a real zero must not look
     * like one. A run that was started but never finished has Outcome NULL
     * and belongs to none of the four buckets, so it is excluded rather than
     * silently forming a fifth, unlabelled group.
     * @returns {Promise<{applied: number, unchanged: number, failed: number, removed: number}>}
     */
    async countByOutcome() {
      const { recordset } = await ex.query(`
        SELECT Outcome, COUNT(*) AS n
        FROM dbo.IngestRun
        WHERE Outcome IS NOT NULL
        GROUP BY Outcome
      `);
      const counts = Object.fromEntries(INGEST_OUTCOMES.map((o) => [o, 0]));
      for (const row of recordset) {
        if (row.Outcome in counts) counts[row.Outcome] = Number(row.n) || 0;
      }
      return counts;
    },
  };
}
