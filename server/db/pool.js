/**
 * Lazy shared MSSQL pool.
 *
 * Mirrors DEDB's db/pool.js, including its Windows-auth-by-default intent so
 * production can run under a domain service account with no stored password.
 *
 * Caveat worth knowing, verified against SQL Server 17 on this machine: the
 * `mssql` package's default transport is tedious, and tedious does NOT
 * implement Windows Integrated authentication from `options.trustedConnection`
 * alone — the flag is accepted and ignored, and the server answers
 * "Login failed for user ''". Windows auth needs either
 * `authentication: { type: "ntlm", options: { domain, userName, password } }`,
 * which still requires a password, or the native `msnodesqlv8` driver.
 *
 * Until one of those is chosen, set DB_WINDOWS_AUTH=false and supply a SQL
 * login. DEDB carries the same flag, so its production deployment is worth
 * checking against this.
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

  /* tedious wants the host and the instance separately: "host\INSTANCE" in
     `server` is not parsed, it is treated as a hostname and fails to resolve.
     Accept either form so DB_SERVER can be written the way people expect. */
  const rawServer = env.DB_SERVER || "localhost\\SQLEXPRESS";
  const [host, instanceFromServer] = String(rawServer).split("\\");
  const instanceName = env.DB_INSTANCE || instanceFromServer || "";

  const config = {
    server: host,
    database: env.DB_DATABASE || "GCIO",
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    options: {
      encrypt: String(env.DB_ENCRYPT || "false") === "true",
      trustServerCertificate: String(env.DB_TRUST_CERT || "true") === "true",
      enableArithAbort: true,
      trustedConnection: useWindows,
      ...(instanceName ? { instanceName } : {}),
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
