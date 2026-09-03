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
/* Shared with the real repos so the stand-ins cannot drift from them. */
import { PRECEDENCE } from "./auth/authz.js";
import { toSam } from "./auth/ldap.js";

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
    /**
     * Read events back, newest first. Files are one per day, so the newest day
     * is read first and only enough files are opened to satisfy the limit —
     * a year of audit history is not loaded to answer a request for 200 rows.
     *
     * @param {{limit?: number, action?: string|null}} [options]
     */
    async recent({ limit = 200, action = null } = {}) {
      const cap = Math.min(1000, Math.max(1, Number(limit) || 200));
      let files;
      try {
        files = fs.readdirSync(dir)
          .filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
          .sort()
          .reverse();
      } catch {
        return []; // no audit directory yet is not an error
      }

      const events = [];
      for (const file of files) {
        let lines;
        try {
          lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
        } catch (err) {
          logger.error?.(`[audit] could not read ${file}: ${err.message}`);
          continue;
        }

        /* Within a file the newest entry is last, so walk it backwards. */
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i].trim();
          if (!line) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // one corrupt line must not lose the rest of the file
          }
          if (action && parsed.action !== action) continue;
          events.push(parsed);
          if (events.length >= cap) return events;
        }
      }
      return events;
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
 * Per-user role grants, in memory. Mirrors repos/userRoleMapping.js closely
 * enough that a test exercising one is exercising the behaviour of the other -
 * including the principal normalisation, which is where the real repo earns
 * its keep: a grant typed as DOMAIN\user has to land on the key sign-in looks
 * up, or the grant is stored, displayed, and silently ineffective.
 */
export function memoryUserRoleMapping(map = {}) {
  const store = new Map(
    Object.entries(map).map(([p, r]) => [toSam(p).toLowerCase(), { role: r, grantedBy: null, grantedAt: new Date() }]),
  );
  return {
    async getMap() {
      return Object.fromEntries([...store].map(([p, v]) => [p, v.role]));
    },
    async list() {
      return [...store]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([Principal, v]) => ({ Principal, Role: v.role, GrantedBy: v.grantedBy, GrantedAt: v.grantedAt }));
    },
    async set(principal, role, grantedBy) {
      const normalised = String(role || "").toLowerCase();
      if (!PRECEDENCE.includes(normalised)) {
        throw new Error(`unknown role '${role}' - expected one of ${PRECEDENCE.join(", ")}`);
      }
      const p = toSam(String(principal || "").trim()).toLowerCase();
      if (!p) throw new Error("a principal is required");
      store.set(p, { role: normalised, grantedBy: grantedBy || null, grantedAt: new Date() });
    },
    async remove(principal) {
      return store.delete(toSam(String(principal || "").trim()).toLowerCase()) ? 1 : 0;
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
