/**
 * Lazy shared MSSQL pool.
 *
 * Mirrors DEDB's db/pool.js: Windows Integrated auth by default, so production
 * runs under a domain service account with no stored password; SQL auth stays
 * available through environment variables for development.
 */
import sql from "mssql";

let poolPromise = null;

/**
 * Build the pool configuration from environment variables.
 * @param {NodeJS.ProcessEnv} env
 */
export function buildConfig(env = process.env) {
  const has = (v) => v !== undefined && v !== null && v !== "";
  const useWindows = String(env.DB_WINDOWS_AUTH || "true") === "true";

  const config = {
    server: env.DB_SERVER || "localhost\\SQLEXPRESS",
    database: env.DB_DATABASE || "GCIO",
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: String(env.DB_ENCRYPT || "false") === "true",
      trustServerCertificate: String(env.DB_TRUST_CERT || "true") === "true",
      enableArithAbort: true,
      trustedConnection: useWindows,
    },
  };

  if (!useWindows) {
    if (!has(env.DB_USER) || !has(env.DB_PASSWORD)) {
      throw new Error("DB_WINDOWS_AUTH=false requires DB_USER and DB_PASSWORD");
    }
    config.user = env.DB_USER;
    config.password = env.DB_PASSWORD;
  }
  return config;
}

/** Connect once and memoise. A failed connect clears the memo so the next call retries. */
export function getPool(env = process.env) {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(buildConfig(env))
      .connect()
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

/**
 * Drop the memoised pool so the next getPool() dials a fresh connection.
 * Called by the supervisor when a live pool dies mid-day — a SQL restart, a
 * failover, a dropped socket — because the memo otherwise holds the corpse.
 */
export function resetPool() {
  const dying = poolPromise;
  poolPromise = null;
  Promise.resolve(dying)
    .then((pool) => pool?.close?.())
    .catch(() => { /* the pool is already gone; nothing to close */ });
}

/** True when a pool has been created (whether or not it is healthy). */
export const hasPool = () => poolPromise !== null;
