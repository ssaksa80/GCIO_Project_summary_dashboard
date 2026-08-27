/**
 * Ingest leader election via a SQL Server application lock.
 *
 * This is the `sp_getapplock` election the spec's P3 row deferred, reasoned
 * away as guarding "a configuration nobody has deployed"
 * (docs/superpowers/specs/2026-08-24-backend-production-design.md). That
 * stopped being true the moment a stray process from an earlier run was
 * still watching the drop folder while a second one started: both ingested,
 * `dbo.Project` took a primary-key violation, and the in-memory read model
 * was left disagreeing with the database.
 *
 * `sp_getapplock` with `@LockOwner = 'Session'` elects exactly one ingester
 * per (database, drop folder): the lock lives on the SQL Server session tied
 * to one physical connection, and is released automatically the instant
 * that connection drops -- a crashed leader fails over with no lease to
 * expire and no heartbeat to tune on the server side.
 *
 * THE TRAP, and how this avoids it: a session-scoped applock lives on
 * exactly one connection. Taken from the shared application pool
 * (server/db/pool.js -- max 10, min 0, idleTimeoutMillis 30000), the
 * connection that ran sp_getapplock can be handed back to that pool and
 * later reaped by its idle timer -- silently, with no error -- leaving this
 * process believing it leads while holding nothing. So the lock is taken on
 * a SEPARATE, DEDICATED connection pool sized `{ min: 1, max: 1 }`: tarn's
 * own reaping rule (node_modules/tarn/dist/Pool.js `check()` computes
 * `minKeep = min - used.length` and never destroys past that many free
 * resources) guarantees this one connection is never evicted merely for
 * being idle. It is opened once, at boot, held for this process's entire
 * life, and never returned to -- or shared with -- the pool in pool.js.
 */
import sql from "mssql";
import { makeExecutor } from "./executor.js";
import { buildConfig } from "./pool.js";

/**
 * The sp_getapplock resource name for one database + drop folder.
 *
 * Deliberately NOT derived from the machine (hostname, pid): two instances
 * guarding the same database and the same drop folder MUST collide -- that
 * is the entire point of the lock -- while two genuinely different
 * deployments (different folders) must not.
 *
 * @param {string} dataDir the watched drop-folder path
 * @returns {string} at most 255 chars, sp_getapplock's @Resource limit
 */
export function lockResourceName(dataDir) {
  const normalized = String(dataDir || "").trim().replace(/\\/g, "/").toLowerCase();
  const name = `gcio-ingest:${normalized}`;
  return name.length > 255 ? name.slice(0, 255) : name;
}

const REFUSAL_REASONS = { "-1": "timeout", "-2": "cancelled", "-3": "deadlock victim" };

/**
 * Interpret sp_getapplock's return code.
 *
 * 0 and 1 both mean granted (immediately, or after waiting -- moot here
 * since callers pass @LockTimeout=0, but both count as leadership if either
 * occurs). -1/-2/-3 are clean refusals. Anything else -- most importantly
 * -999, "bad parameter" -- means the CALL ITSELF was wrong (a typo'd lock
 * mode, a malformed resource name) and must never be read as "this process
 * lost a fair election"; it is thrown instead.
 *
 * @param {number} code
 * @returns {{leader: boolean, reason?: string}}
 * @throws {Error} for any code other than 0, 1, -1, -2, -3
 */
export function classifyLockResult(code) {
  const n = Number(code);
  if (n === 0 || n === 1) return { leader: true };
  if (n === -1 || n === -2 || n === -3) return { leader: false, reason: REFUSAL_REASONS[String(n)] };
  throw new Error(
    `sp_getapplock returned ${code}, which is not one of the documented outcomes ` +
    `(0/1 granted, -1/-2/-3 refused). The call itself is wrong -- treat this as an ` +
    `error, not as "this process is a follower".`
  );
}

const APPLOCK_SQL = `
  DECLARE @result INT;
  EXEC @result = sp_getapplock @Resource = @resource, @LockMode = @lockMode, @LockOwner = @lockOwner, @LockTimeout = @lockTimeout;
  SELECT @result AS Result;
`;

/**
 * Try to take the lock over an already-open Executor (see db/executor.js).
 * `@LockTimeout = 0` so a follower fails fast at boot rather than blocking
 * for a lock it will never get.
 *
 * @param {{query: Function}} ex
 * @param {string} resource
 * @returns {Promise<{code: number, leader: boolean, reason?: string}>}
 */
export async function acquireApplock(ex, resource, { lockTimeout = 0 } = {}) {
  const { recordset } = await ex.query(APPLOCK_SQL, [
    { name: "resource", type: sql.NVarChar(255), value: resource },
    { name: "lockMode", type: sql.VarChar(16), value: "Exclusive" },
    { name: "lockOwner", type: sql.VarChar(16), value: "Session" },
    { name: "lockTimeout", type: sql.Int, value: lockTimeout },
  ]);
  const code = recordset[0].Result;
  return { code, ...classifyLockResult(code) };
}

/**
 * Poll the dedicated connection so a dropped session is noticed even though
 * nothing else runs on it after the lock is taken -- there is no natural
 * traffic that would otherwise surface the failure. `onLost` fires at most
 * once.
 *
 * @param {{query: Function}} ex bound to the dedicated connection
 * @param {{intervalMs?: number, onLost: (err: Error) => void}} options
 * @returns {() => void} stop the poll
 */
export function watchForConnectionLoss(ex, { intervalMs = 15000, onLost }) {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      await ex.query("SELECT 1 AS ok");
    } catch (err) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      onLost(err);
    }
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Open the dedicated connection and try to become the ingest leader.
 *
 * Deliberately does NOT attempt to re-acquire the lock later, and does not
 * retry or fail over automatically -- see the caller (server/ingestRole.js,
 * server/index.js) and the report: automatic re-election is a bigger change
 * than this fix, and honest degradation (stop ingesting, say so loudly) beats
 * a half-built failover.
 *
 * @param {{env?: object, dataDir: string, logger?: object,
 *           connect?: () => Promise<object>}} options
 *   `connect` is injectable for tests: it must resolve to an object
 *   `makeExecutor` accepts (has `.request()`) and that also has `.close()`.
 *   The default opens a real, dedicated `{min:1, max:1}` mssql pool built
 *   from the same `buildConfig` server/db/pool.js uses for the shared one.
 * @returns {Promise<{
 *   isLeader: boolean,
 *   refusalReason?: string,
 *   resource: string,
 *   watchForLoss: (onLost: (err: Error) => void, opts?: {intervalMs?: number}) => (() => void),
 *   close: () => Promise<void>,
 * }>}
 */
export async function electIngestLeader({ env = process.env, dataDir, logger = console, connect } = {}) {
  const resource = lockResourceName(dataDir);
  const open = connect || (async () => {
    const pool = new sql.ConnectionPool({ ...buildConfig(env), pool: { min: 1, max: 1 } });
    await pool.connect();
    return pool;
  });

  const connection = await open();
  const ex = makeExecutor(connection, { logger });

  let outcome;
  try {
    outcome = await acquireApplock(ex, resource);
  } catch (err) {
    await connection.close?.().catch?.(() => {});
    throw err;
  }

  if (!outcome.leader) {
    await connection.close?.().catch?.(() => {});
    return {
      isLeader: false,
      refusalReason: outcome.reason,
      resource,
      watchForLoss: () => () => {},
      close: async () => {},
    };
  }

  let stopWatch = null;
  return {
    isLeader: true,
    resource,
    watchForLoss(onLost, opts = {}) {
      if (!stopWatch) stopWatch = watchForConnectionLoss(ex, { onLost, ...opts });
      return stopWatch;
    },
    async close() {
      stopWatch?.();
      await connection.close?.().catch?.(() => {});
    },
  };
}
