/**
 * Server-side sessions.
 *
 * Mirrors DEDB's repos/sessions.js: the cookie carries only an opaque id, the
 * record lives in SQL, and Node owns identifier generation rather than relying
 * on a SQL-side default. Server-side records are what make sign-out and
 * revocation real — a stateless token cannot be withdrawn.
 */
import { randomUUID } from "node:crypto";
import { sql } from "../db/executor.js";

/* Groups are stored as JSON, not a delimited string: directory group names
   and distinguished names contain commas and other punctuation, so a
   single-character delimiter would corrupt them on the way back out. */
const splitGroups = (s) => {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const joinGroups = (a) => JSON.stringify(Array.isArray(a) ? a : []);

function rowToSession(r) {
  return {
    sessionId: String(r.SessionId).toLowerCase(),
    principal: r.Principal,
    displayName: r.DisplayName || r.Principal,
    role: r.Role,
    groups: splitGroups(r.Groups),
    expiresAt: r.ExpiresAt instanceof Date ? r.ExpiresAt.toISOString() : String(r.ExpiresAt),
    lastSeenAt: r.LastSeenAt instanceof Date ? r.LastSeenAt.toISOString() : String(r.LastSeenAt),
  };
}

export function sessionsRepo(ex) {
  return {
    /**
     * @param {{principal: string, displayName?: string, role: string, groups?: string[], expiresAt: string|Date, ip?: string}} input
     * @returns {Promise<string>} the new session id, for the cookie
     */
    async create({ principal, displayName, role, groups, expiresAt, ip }) {
      const id = randomUUID();
      await ex.query(`
        INSERT INTO dbo.Sessions (SessionId, Principal, DisplayName, Role, Groups, ExpiresAt, LastSeenAt, LastIp)
        VALUES (@id, @principal, @displayName, @role, @groups, @expiresAt, SYSUTCDATETIME(), @ip)
      `, [
        { name: "id", type: sql.UniqueIdentifier, value: id },
        { name: "principal", type: sql.NVarChar(200), value: principal },
        { name: "displayName", type: sql.NVarChar(200), value: displayName || null },
        { name: "role", type: sql.VarChar(10), value: role },
        { name: "groups", type: sql.NVarChar(sql.MAX), value: joinGroups(groups) },
        { name: "expiresAt", type: sql.DateTime2(0), value: new Date(expiresAt) },
        { name: "ip", type: sql.VarChar(45), value: ip || null },
      ]);
      return id;
    },

    /**
     * The session, if it exists, has not expired, and has been seen inside the
     * idle window. Both limits are enforced in SQL so a clock-skewed app server
     * cannot extend a session by accident.
     * @param {string} sessionId
     * @param {number} idleMinutes
     */
    async getLive(sessionId, idleMinutes = 240) {
      if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
      const { recordset } = await ex.query(`
        SELECT SessionId, Principal, DisplayName, Role, Groups, ExpiresAt, LastSeenAt
        FROM dbo.Sessions
        WHERE SessionId = @id
          AND ExpiresAt > SYSUTCDATETIME()
          AND DATEADD(minute, @idle, LastSeenAt) > SYSUTCDATETIME()
      `, [
        { name: "id", type: sql.UniqueIdentifier, value: sessionId },
        { name: "idle", type: sql.Int, value: Math.max(1, Number(idleMinutes) || 240) },
      ]);
      return recordset.length ? rowToSession(recordset[0]) : null;
    },

    /** Best-effort last-seen update; callers must not await this on the hot path. */
    async touch(sessionId, ip) {
      try {
        await ex.query(`
          UPDATE dbo.Sessions SET LastSeenAt = SYSUTCDATETIME(), LastIp = @ip WHERE SessionId = @id
        `, [
          { name: "id", type: sql.UniqueIdentifier, value: sessionId },
          { name: "ip", type: sql.VarChar(45), value: ip || null },
        ]);
      } catch {
        /* a missed last-seen must never fail the request it belongs to */
      }
    },

    /** Sign out one session. */
    /**
     * Live sessions, for the admin console.
     *
     * SessionId is deliberately absent. It is a bearer token: listing it would
     * put every live credential into a response body, a proxy log and a browser
     * cache, so an admin screen that shows "who is signed in" would also be a
     * screen that hands over their sessions. Revocation is therefore by
     * principal, which is the question an admin is actually asking anyway.
     */
    async list({ idleMinutes = 240 } = {}) {
      const { recordset } = await ex.query(`
        SELECT Principal, DisplayName, Role, ExpiresAt, LastSeenAt, LastIp
        FROM dbo.Sessions
        WHERE ExpiresAt > SYSUTCDATETIME()
          AND DATEADD(minute, @idle, LastSeenAt) > SYSUTCDATETIME()
        ORDER BY LastSeenAt DESC
      `, [{ name: "idle", type: sql.Int, value: Math.max(1, Number(idleMinutes) || 240) }]);
      return recordset.map((r) => ({
        principal: r.Principal,
        displayName: r.DisplayName,
        role: r.Role,
        expiresAt: r.ExpiresAt,
        lastSeenAt: r.LastSeenAt,
        lastIp: r.LastIp,
      }));
    },

    async destroy(sessionId) {
      if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return 0;
      const { rowsAffected } = await ex.query("DELETE FROM dbo.Sessions WHERE SessionId = @id", [
        { name: "id", type: sql.UniqueIdentifier, value: sessionId },
      ]);
      return Array.isArray(rowsAffected) ? rowsAffected[0] : 0;
    },

    /** Sign out every session for a principal — used when access is withdrawn. */
    async destroyForPrincipal(principal) {
      const { rowsAffected } = await ex.query("DELETE FROM dbo.Sessions WHERE Principal = @p", [
        { name: "p", type: sql.NVarChar(200), value: principal },
      ]);
      return Array.isArray(rowsAffected) ? rowsAffected[0] : 0;
    },

    /** Housekeeping: drop expired rows so the table does not grow without bound. */
    async purgeExpired() {
      const { rowsAffected } = await ex.query("DELETE FROM dbo.Sessions WHERE ExpiresAt <= SYSUTCDATETIME()");
      return Array.isArray(rowsAffected) ? rowsAffected[0] : 0;
    },
  };
}

/**
 * Absolute expiry for a new session.
 * A bad or zero setting must not 500 every sign-in, so it falls back.
 */
export function computeExpiry(hoursSetting, now = new Date()) {
  let hours = parseInt(hoursSetting ?? "8", 10);
  if (!Number.isFinite(hours) || hours <= 0) hours = 8;
  return new Date(now.getTime() + hours * 3600 * 1000).toISOString();
}
