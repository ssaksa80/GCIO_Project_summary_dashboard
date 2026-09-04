/**
 * Section ownership: who is responsible for a part of the brief.
 *
 * Ports DEDB's repos/ownership.js, with GCIO's five section keys.
 *
 * The resolution rule is the one that matters and it is DEDB's exactly:
 * `ownedSectionsFor` matches PrincipalName against the caller's principal AND
 * every one of their group CNs in a single IN clause, and never filters on
 * PrincipalType. So a row typed 'group' whose name happens to match a person
 * resolves for that person, and vice versa. The type is descriptive - it tells
 * an admin reading the table what a row was meant to be - not load-bearing.
 * Changing that would change who can see what, so it is preserved deliberately
 * rather than "tidied up".
 */
import { sql } from "../db/executor.js";
import { toSam } from "../auth/ldap.js";

/** The five sections the client renders. A grant against anything else would
 *  match nobody and report nothing, so the table constrains it too. */
export const SECTION_KEYS = ["successes", "questions", "priorities", "roadmap", "posture"];

export function ownershipRepo(ex) {
  return {
    /**
     * Which sections this caller owns, by principal or by group membership.
     *
     * The principal is tried in both the form sign-in produced and its bare
     * sAMAccountName. A person arrives as `jdoe@example.local` while an admin
     * granting ownership will have typed `jdoe`; matching only the raw
     * principal would store a grant that silently owns nothing - the same
     * mismatch that made per-user role grants fail on a live host.
     */
    async ownedSectionsFor(principal, groups = []) {
      const bare = toSam(String(principal || ""));
      const names = [...new Set([principal, bare, ...(groups || [])].filter(Boolean))];
      if (!names.length) return [];
      const params = names.map((n, i) => ({ name: `p${i}`, type: sql.NVarChar(200), value: String(n) }));
      const placeholders = params.map((p) => `@${p.name}`).join(", ");
      const { recordset } = await ex.query(
        `SELECT DISTINCT SectionKey FROM dbo.SectionOwnership WHERE PrincipalName IN (${placeholders})`,
        params,
      );
      return [...new Set(recordset.map((r) => r.SectionKey))];
    },

    /** Every grant, for the admin console. */
    async list() {
      const { recordset } = await ex.query(
        `SELECT Id, PrincipalType, PrincipalName, SectionKey, GrantedBy, GrantedAt
         FROM dbo.SectionOwnership ORDER BY PrincipalName, SectionKey`,
      );
      return recordset;
    },

    /**
     * Grant one section to one principal.
     * @returns {Promise<number>} the new row id, which the console uses to revoke
     */
    async grant({ principalType, principalName, sectionKey, grantedBy }) {
      const type = String(principalType || "").trim().toLowerCase();
      const name = String(principalName || "").trim();
      const key = String(sectionKey || "").trim();
      if (!["user", "group"].includes(type)) throw new Error("principalType must be user or group");
      if (!name) throw new Error("a principalName is required");
      if (!SECTION_KEYS.includes(key)) throw new Error(`sectionKey must be one of: ${SECTION_KEYS.join(", ")}`);
      /* NVARCHAR(200) in the table, and the driver validates the JS type but
         not the length - an over-length value would be truncated on assignment
         rather than rejected, persisting as a name that matches nobody. DEDB
         hit this with a pasted full DN instead of a CN. */
      if (name.length > 200) throw new Error("principalName must be 200 characters or fewer");

      const { recordset } = await ex.query(
        `INSERT INTO dbo.SectionOwnership (PrincipalType, PrincipalName, SectionKey, GrantedBy)
         OUTPUT inserted.Id AS Id VALUES (@pt, @pn, @sk, @by)`,
        [
          { name: "pt", type: sql.VarChar(10), value: type },
          { name: "pn", type: sql.NVarChar(200), value: name },
          { name: "sk", type: sql.VarChar(20), value: key },
          { name: "by", type: sql.NVarChar(120), value: grantedBy ? String(grantedBy) : null },
        ],
      );
      return recordset[0].Id;
    },

    async revoke(id) {
      const n = Number(id);
      if (!Number.isInteger(n) || n <= 0) throw new Error("a numeric ownership id is required");
      await ex.query("DELETE FROM dbo.SectionOwnership WHERE Id = @id", [
        { name: "id", type: sql.BigInt, value: n },
      ]);
    },
  };
}
