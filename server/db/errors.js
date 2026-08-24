/**
 * Connection-failure classification.
 *
 * Mirrors DEDB's db/errors.js: the supervisor needs to tell "this pool is dead,
 * reconnect" apart from "that query was wrong", because only the first should
 * tear down and rebuild the pool.
 */

const CONNECTION_CODES = new Set([
  "ECONNCLOSED", "ECONNRESET", "ETIMEOUT", "ESOCKET", "ENOTOPEN",
  "ELOGIN", "EALREADYCONNECTING", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
]);

const CONNECTION_TEXT = /connection is closed|connection lost|socket hang up|not connected|failed to connect|no connection is available/i;

/**
 * @param {Error & {code?: string}} err
 * @returns {boolean} true when the pool itself is gone, rather than the query
 */
export function isConnectionError(err) {
  if (!err) return false;
  if (err.code && CONNECTION_CODES.has(String(err.code))) return true;
  return CONNECTION_TEXT.test(String(err.message || ""));
}

/** A 503 the API layer renders as a clean "database unavailable" envelope. */
export function dbUnavailable(detail = "database unavailable") {
  const err = new Error(detail);
  err.status = 503;
  err.code = "db_unavailable";
  return err;
}
