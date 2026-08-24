/**
 * The Executor interface every repository is written against:
 *
 *     query(text, params) -> { recordset }
 *     tx(fn)              -> runs fn(txExecutor) inside one transaction
 *
 * Mirrors DEDB's db/executor.js, including the detail that earned its keep
 * there: the pool may be handed in as a **getter**, so a reconnect swaps a live
 * pool in without every repository being rebuilt. A null resolution raises a
 * clean 503 rather than a TypeError deep inside a route.
 */
import sql from "mssql";
import { isConnectionError, dbUnavailable } from "./errors.js";

/** Errors that are ordinary control flow for callers, so they are not logged. */
const TOLERATED_SQL_ERRORS = new Set([
  208,  // invalid object name — table not migrated yet
  207,  // invalid column name — column not migrated yet
  2627, // primary key / unique violation
  2601, // duplicate key in a unique index
]);

const bind = (request, params) => {
  for (const p of params || []) request.input(p.name, p.type, p.value);
  return request;
};

/**
 * @param {object|Function} poolOrTx a live pool/Transaction, or a zero-arg getter
 * @param {{onConnectionError?: Function, logger?: object}} [options]
 */
export function makeExecutor(poolOrTx, { onConnectionError, logger = console } = {}) {
  const resolvePool = () => {
    const p = typeof poolOrTx === "function" ? poolOrTx() : poolOrTx;
    if (p == null) throw dbUnavailable();
    return p;
  };

  async function query(text, params) {
    const pool = resolvePool();
    try {
      return await bind(pool.request(), params).query(text);
    } catch (err) {
      if (isConnectionError(err)) {
        onConnectionError?.(err);
        throw dbUnavailable(err.message);
      }
      if (!TOLERATED_SQL_ERRORS.has(err.number)) {
        logger.error?.(`[db] query failed: ${err.number ?? "?"} - ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Run fn inside a transaction. The callback receives an executor bound to the
   * transaction, so repositories compose without knowing they are in one.
   */
  async function tx(fn) {
    const pool = resolvePool();
    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    const scoped = makeExecutor(transaction, { onConnectionError, logger });
    try {
      const result = await fn(scoped);
      await transaction.commit();
      return result;
    } catch (err) {
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        logger.error?.(`[db] rollback failed: ${rollbackErr.message}`);
      }
      throw err;
    }
  }

  return { query, tx };
}

export { sql };
