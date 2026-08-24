/**
 * In-memory and file-backed stand-ins for the SQL backends.
 *
 * These exist so the dashboard can be demonstrated and developed with no SQL
 * Server and no directory — the same reason the in-memory store exists. They
 * are refused in production by config.js (AUTH_MODE=dev), and the SQL store is
 * the default there.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Audit sink that appends JSONL, one file per day. Never throws. */
export function createFileAudit(dir, { logger = console } = {}) {
  return {
    async append(event) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({
          at: new Date().toISOString(),
          actor: event.actor || "anonymous",
          action: event.action,
          subject: event.subject || "",
          ip: event.ip || "",
          userAgent: event.userAgent || "",
          requestId: event.requestId || "",
        });
        fs.appendFileSync(path.join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`), `${line}\n`);
        return true;
      } catch (err) {
        logger.error?.(`[audit] could not record ${event.action}: ${err.message}`);
        return false;
      }
    },
    async recent() {
      return [];
    },
  };
}

/** Sessions held in a Map. Lost on restart, which is acceptable for dev only. */
export function memorySessions() {
  const rows = new Map();
  return {
    async create({ principal, displayName, role, groups, expiresAt, ip }) {
      const id = randomUUID();
      rows.set(id, {
        sessionId: id, principal, displayName: displayName || principal, role,
        groups: groups || [], expiresAt, lastSeenAt: new Date().toISOString(), ip,
      });
      return id;
    },
    async getLive(sessionId) {
      const row = rows.get(sessionId);
      if (!row) return null;
      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        rows.delete(sessionId);
        return null;
      }
      return row;
    },
    async touch(sessionId) {
      const row = rows.get(sessionId);
      if (row) row.lastSeenAt = new Date().toISOString();
    },
    async destroy(sessionId) {
      return rows.delete(sessionId) ? 1 : 0;
    },
    async destroyForPrincipal(principal) {
      let n = 0;
      for (const [id, row] of rows) if (row.principal === principal) { rows.delete(id); n += 1; }
      return n;
    },
    async purgeExpired() {
      return 0;
    },
  };
}

/** A fixed group-to-role map, for development. */
export function memoryRoleMapping(map = {}) {
  const store = new Map(Object.entries(map).map(([g, r]) => [g.toLowerCase(), r]));
  return {
    async getMap() {
      return Object.fromEntries(store);
    },
    async set(groupName, role) {
      store.set(String(groupName).toLowerCase(), role);
      return { groupName, role };
    },
    async remove(groupName) {
      return store.delete(String(groupName).toLowerCase()) ? 1 : 0;
    },
    async list() {
      return [...store].map(([groupName, role]) => ({ groupName, role }));
    },
  };
}

/**
 * A directory stand-in that accepts any password and grants a fixed role.
 * Only reachable when AUTH_MODE=dev, which config.js refuses in production.
 * @param {"viewer"|"pm"|"admin"} role
 */
export function devAuthenticate(role) {
  return async ({ username }) => ({
    principal: `${username || "developer"}@localhost`,
    displayName: `${username || "Local Developer"} (dev)`,
    groups: [`gcio-dashboard-${role}s`],
  });
}
