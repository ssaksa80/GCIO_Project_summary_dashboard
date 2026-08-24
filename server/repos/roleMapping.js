/**
 * Directory group -> application role.
 *
 * Mirrors DEDB's repos/roleMapping.js. The map is read on every sign-in, so a
 * change of membership policy takes effect without a restart; it is cached
 * briefly because sign-in storms otherwise hammer the same three rows.
 */
import { sql } from "../db/executor.js";
import { PRECEDENCE } from "../auth/authz.js";

const CACHE_MS = 30_000;

export function roleMappingRepo(ex, { cacheMs = CACHE_MS, now = () => Date.now() } = {}) {
  let cached = null;
  let cachedAt = 0;

  const repo = {
    /** @returns {Promise<Record<string, string>>} lower-cased group name -> role */
    async getMap({ fresh = false } = {}) {
      if (!fresh && cached && now() - cachedAt < cacheMs) return cached;
      const { recordset } = await ex.query("SELECT GroupName, Role FROM dbo.RoleMapping");
      const map = {};
      for (const row of recordset) {
        const role = String(row.Role || "").toLowerCase();
        if (!PRECEDENCE.includes(role)) continue; // ignore a role the app does not know
        map[String(row.GroupName).toLowerCase()] = role;
      }
      cached = map;
      cachedAt = now();
      return map;
    },

    /** Add or change one mapping. Admin-only at the route layer. */
    async set(groupName, role) {
      const normalised = String(role || "").toLowerCase();
      if (!PRECEDENCE.includes(normalised)) {
        throw new Error(`unknown role '${role}' — expected one of ${PRECEDENCE.join(", ")}`);
      }
      await ex.query(`
        MERGE dbo.RoleMapping AS target
        USING (SELECT @group AS GroupName) AS source
          ON target.GroupName = source.GroupName
        WHEN MATCHED THEN UPDATE SET Role = @role
        WHEN NOT MATCHED THEN INSERT (GroupName, Role) VALUES (@group, @role);
      `, [
        { name: "group", type: sql.NVarChar(300), value: String(groupName) },
        { name: "role", type: sql.VarChar(10), value: normalised },
      ]);
      cached = null;
      return { groupName: String(groupName), role: normalised };
    },

    /** Remove a mapping — the next sign-in for that group alone loses access. */
    async remove(groupName) {
      const { rowsAffected } = await ex.query("DELETE FROM dbo.RoleMapping WHERE GroupName = @group", [
        { name: "group", type: sql.NVarChar(300), value: String(groupName) },
      ]);
      cached = null;
      return Array.isArray(rowsAffected) ? rowsAffected[0] : 0;
    },

    /** For the admin screen. */
    async list() {
      const { recordset } = await ex.query("SELECT GroupName, Role FROM dbo.RoleMapping ORDER BY GroupName");
      return recordset.map((r) => ({ groupName: r.GroupName, role: r.Role }));
    },

    /**
     * Install one admin mapping when the table is empty, so a fresh database is
     * reachable at all: with no mappings every sign-in folds to no role and is
     * refused, and the mapping needed to let an administrator in can only be
     * created by an administrator.
     *
     * Never overwrites an existing map. Once any mapping exists the seed group
     * has no special power, so leaving SEED_ADMIN_GROUP set in the environment
     * does not become a standing back door.
     *
     * @param {string} groupName from SEED_ADMIN_GROUP
     * @returns {Promise<string|null>} the group seeded, or null if it was not needed
     */
    async seedIfEmpty(groupName) {
      if (!groupName) return null;
      const existing = await repo.list();
      if (existing.length) return null;
      await repo.set(groupName, "admin");
      return groupName;
    },
  };

  return repo;
}
