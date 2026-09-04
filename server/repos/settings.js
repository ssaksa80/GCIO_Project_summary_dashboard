/**
 * Operator-editable settings, stored in the database.
 *
 * Ports the shape of DEDB's settings store and, more importantly, its
 * distinction between "saved" and "applied live". Some settings the running
 * process can pick up immediately; others need a restart. DEDB's PUT reports
 * which ones actually took effect so the console can say so, instead of
 * implying every save is instant. That honesty is the point of the design.
 *
 * WHAT DOES NOT BELONG HERE: anything secret, and anything read before the
 * database is available. Connection strings, the LDAP bind password and the
 * session keys all stay in .env, sealed where sealing applies. A settings table
 * that the app must read in order to reach the database it lives in cannot
 * work, and a secret stored here would be readable by anyone with db_datareader
 * while the .env equivalent is DPAPI-sealed.
 */
import { sql } from "../db/executor.js";

/**
 * The settings this build understands.
 *
 * `live` marks the ones the running process re-reads without a restart. A
 * setting absent from here is still stored and still shown - an older build
 * reading a newer database must not lose a value it does not recognise - but it
 * is reported as unknown rather than silently ignored.
 */
export const KNOWN_SETTINGS = [
  { key: "sessionIdleMinutes", label: "Session idle timeout (minutes)", type: "number", live: true,
    help: "How long a session survives without activity. Read per request, so a change applies to the next request." },
  { key: "sessionAbsoluteHours", label: "Session maximum age (hours)", type: "number", live: false,
    help: "The hard cap on a session's life. Applied when a session is created, so existing sessions keep their original expiry." },
  { key: "logLevel", label: "Log level", type: "enum", live: true, options: ["error", "warn", "info", "debug"],
    help: "How much the service writes to its log files." },
  { key: "briefTitle", label: "Brief title", type: "text", live: true,
    help: "The heading shown above the executive summary." },
];

const KNOWN_KEYS = new Set(KNOWN_SETTINGS.map((s) => s.key));

/** Missing table means "no settings yet", not an outage - migration 13 may not
 *  have run on a host taking a code-only upgrade. Narrow: SQL 208 only. */
function isMissingTable(err) {
  return !!err && (err.number === 208 || /invalid object name/i.test(err.message || ""));
}

export function settingsRepo(ex) {
  return {
    /** @returns {Promise<Record<string,string>>} key -> stored value */
    async getMap() {
      try {
        const { recordset } = await ex.query("SELECT [Key], Value FROM dbo.AppSetting");
        return Object.fromEntries(recordset.map((r) => [r.Key, r.Value]));
      } catch (err) {
        if (isMissingTable(err)) return {};
        throw err;
      }
    },

    /**
     * Every known setting with its current value, plus anything stored that
     * this build does not recognise. The console renders both; an unknown key
     * is shown read-only rather than dropped, because dropping it from the
     * screen is how it gets silently deleted on the next save.
     */
    async describe() {
      const stored = await this.getMap();
      const known = KNOWN_SETTINGS.map((s) => ({ ...s, value: stored[s.key] ?? null }));
      const extra = Object.entries(stored)
        .filter(([k]) => !KNOWN_KEYS.has(k))
        .map(([key, value]) => ({ key, label: key, type: "text", live: false, value, unknown: true }));
      return [...known, ...extra];
    },

    async set(key, value, updatedBy) {
      const k = String(key || "").trim();
      if (!k) throw new Error("a setting key is required");
      if (k.length > 60) throw new Error("a setting key must be 60 characters or fewer");
      const v = value === null || value === undefined ? null : String(value);
      if (v !== null && v.length > 400) throw new Error("a setting value must be 400 characters or fewer");
      await ex.query(
        `MERGE dbo.AppSetting AS target
           USING (VALUES (@k, @v, @by)) AS source ([Key], Value, UpdatedBy)
           ON target.[Key] = source.[Key]
         WHEN MATCHED THEN
           UPDATE SET Value = source.Value, UpdatedBy = source.UpdatedBy, UpdatedAt = SYSUTCDATETIME()
         WHEN NOT MATCHED THEN
           INSERT ([Key], Value, UpdatedBy) VALUES (source.[Key], source.Value, source.UpdatedBy);`,
        [
          { name: "k", type: sql.VarChar(60), value: k },
          { name: "v", type: sql.NVarChar(400), value: v },
          { name: "by", type: sql.NVarChar(120), value: updatedBy ? String(updatedBy) : null },
        ],
      );
    },
  };
}
