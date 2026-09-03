/**
 * Per-user role grants: sAMAccountName -> application role.
 *
 * Ports DEDB's repos/userRoleMapping.js. Sits alongside repos/roleMapping.js
 * (group -> role); auth/authz.js folds the two and takes the highest, so a
 * direct grant can raise someone above what their groups give them without
 * anyone having to create or populate a directory group.
 *
 * PRINCIPALS ARE NORMALISED, both on the way in and on the way out. A person
 * reaches sign-in as a bare sAMAccountName, but an admin adding a grant may
 * type `DOMAIN\user` or `user@domain`. Stored as typed, such a row never
 * matches: the grant appears saved, the person still cannot sign in, and
 * nothing anywhere connects the two. toSam collapses all three forms.
 */
import { sql } from "../db/executor.js";
import { PRECEDENCE } from "../auth/authz.js";
import { toSam } from "../auth/ldap.js";

/**
 * Migration 12 creates dbo.UserRoleMapping. A code-only upgrade runs no
 * migrations, so on a host that has not migrated yet the table is absent - and
 * this lookup is in the LOGIN path. A purely additive feature must degrade to
 * "no grants" and fall through to group roles rather than take authentication
 * down with it.
 *
 * Deliberately narrow: SQL 208 only. Swallowing every error would turn a
 * broken database into "nobody has any grants", which reads as a permissions
 * mystery rather than the outage it is.
 */
function isMissingTable(err) {
  return !!err && (err.number === 208 || /invalid object name/i.test(err.message || ""));
}

const normalise = (principal) => toSam(String(principal || "").trim()).toLowerCase();

export function userRoleMappingRepo(ex) {
  return {
    /** @returns {Promise<Record<string, string>>} lower-cased sAMAccountName -> role */
    async getMap() {
      try {
        const { recordset } = await ex.query("SELECT Principal, Role FROM dbo.UserRoleMapping");
        const map = {};
        for (const row of recordset) {
          const role = String(row.Role || "").toLowerCase();
          if (!PRECEDENCE.includes(role)) continue; // a role this build does not know
          map[normalise(row.Principal)] = role;
        }
        return map;
      } catch (err) {
        if (isMissingTable(err)) return {};
        throw err;
      }
    },

    /** Every grant, for the admin console. */
    async list() {
      try {
        const { recordset } = await ex.query(
          "SELECT Principal, Role, GrantedBy, GrantedAt FROM dbo.UserRoleMapping ORDER BY Principal",
        );
        return recordset;
      } catch (err) {
        if (isMissingTable(err)) return [];
        throw err;
      }
    },

    /**
     * Add or change one grant. Admin-only at the route layer.
     * @param {string} principal any of jdoe, DOMAIN\jdoe, jdoe@example.local
     * @param {string} role
     * @param {string} grantedBy the signed-in admin making the change
     */
    async set(principal, role, grantedBy) {
      const normalised = String(role || "").toLowerCase();
      if (!PRECEDENCE.includes(normalised)) {
        /* The table has a CHECK too, but a constraint violation surfaces as a
           500 with a SQL message. Refusing here says what was actually wrong. */
        throw new Error(`unknown role '${role}' - expected one of ${PRECEDENCE.join(", ")}`);
      }
      const p = normalise(principal);
      if (!p) throw new Error("a principal is required");
      await ex.query(
        `MERGE dbo.UserRoleMapping AS target
           USING (VALUES (@p, @r, @by)) AS source (Principal, Role, GrantedBy)
           ON target.Principal = source.Principal
         WHEN MATCHED THEN
           UPDATE SET Role = source.Role, GrantedBy = source.GrantedBy, GrantedAt = SYSUTCDATETIME()
         WHEN NOT MATCHED THEN
           INSERT (Principal, Role, GrantedBy) VALUES (source.Principal, source.Role, source.GrantedBy);`,
        [
          { name: "p", type: sql.NVarChar(120), value: p },
          { name: "r", type: sql.VarChar(10), value: normalised },
          { name: "by", type: sql.NVarChar(120), value: grantedBy ? String(grantedBy) : null },
        ],
      );
    },

    /** Revoke a grant. Removing it is the revoke; lowering it is not, because
     *  authz takes the HIGHEST of the group role and the grant. */
    async remove(principal) {
      await ex.query("DELETE FROM dbo.UserRoleMapping WHERE Principal = @p", [
        { name: "p", type: sql.NVarChar(120), value: normalise(principal) },
      ]);
    },
  };
}
