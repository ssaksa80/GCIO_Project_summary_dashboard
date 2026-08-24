/**
 * Audit trail.
 *
 * Mirrors DEDB's repos/audit.js, including its hard-won rule: an audit write
 * must never take down the action it is recording. Failures are logged and
 * swallowed; the caller is told nothing, because there is nothing it could
 * usefully do about it mid-request.
 */
import { sql } from "../db/executor.js";

const toDbText = (v) =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);

export function auditRepo(ex, { logger = console } = {}) {
  return {
    /**
     * Record one event. Never throws.
     * @param {{actor: string, action: string, subject?: string, ip?: string, userAgent?: string, requestId?: string}} event
     */
    async append(event) {
      try {
        await ex.query(`
          INSERT INTO dbo.AuditEvent (At, Actor, Action, Subject, Ip, UserAgent, RequestId)
          VALUES (SYSUTCDATETIME(), @actor, @action, @subject, @ip, @ua, @rid)
        `, [
          { name: "actor", type: sql.NVarChar(320), value: toDbText(event.actor) || "anonymous" },
          { name: "action", type: sql.NVarChar(80), value: toDbText(event.action) },
          { name: "subject", type: sql.NVarChar(600), value: toDbText(event.subject) },
          { name: "ip", type: sql.NVarChar(64), value: toDbText(event.ip) },
          { name: "ua", type: sql.NVarChar(400), value: toDbText(event.userAgent) },
          { name: "rid", type: sql.NVarChar(64), value: toDbText(event.requestId) },
        ]);
        return true;
      } catch (err) {
        logger.error?.(`[audit] could not record ${event.action}: ${err.message}`);
        return false;
      }
    },

    /** Newest first, for the Admin view. */
    async recent({ limit = 200, action = null } = {}) {
      const { recordset } = await ex.query(`
        SELECT TOP (@limit) At, Actor, Action, Subject, Ip, RequestId
        FROM dbo.AuditEvent
        WHERE (@action IS NULL OR Action = @action)
        ORDER BY At DESC
      `, [
        { name: "limit", type: sql.Int, value: Math.min(1000, Math.max(1, Number(limit) || 200)) },
        { name: "action", type: sql.NVarChar(80), value: action ? toDbText(action) : null },
      ]);
      return recordset.map((r) => ({
        at: r.At instanceof Date ? r.At.toISOString() : String(r.At),
        actor: r.Actor,
        action: r.Action,
        subject: r.Subject || "",
        ip: r.Ip || "",
        requestId: r.RequestId || "",
      }));
    },
  };
}
