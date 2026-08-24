/**
 * Entra's signing keys, fetched live and cached.
 *
 * Mirrors DEDB's auth/entraJwks.js, including the two lessons its comments
 * record from production:
 *
 *   - A pasted key set goes stale the moment Microsoft rotates a key. That is
 *     survivable for an optional second factor but locks everyone out when SSO
 *     is the primary login, so keys are fetched and refreshed.
 *   - A TLS-inspecting corporate firewall resets a share of handshakes to
 *     login.microsoftonline.com. A single attempt therefore fails often enough
 *     to matter on the one fetch that counts: the forced refetch after a key
 *     rotation, where falling back to the stale cache means the sign-in fails.
 *     Bounded retries take a ~20% per-attempt failure to well under 1%.
 *
 * get() never throws and never leaves the caller without a decision: a live
 * set, the last good cached set, an operator-supplied offline set, or null.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000;   // refresh hourly
const DEFAULT_COOLDOWN_MS = 60 * 1000;   // a bogus kid must not drive a fetch storm
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MAX_TOTAL_MS = 8000;       // this sits in the login path

/** @param {string} tenantId */
export const jwksUrlFor = (tenantId) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/discovery/v2.0/keys`;

/**
 * @param {{
 *   tenantId: string,
 *   offlineKeys?: {keys: object[]}|null,
 *   fetchImpl?: Function,
 *   now?: () => number,
 *   ttlMs?: number, cooldownMs?: number, timeoutMs?: number,
 *   attempts?: number, maxTotalMs?: number,
 *   logger?: object
 * }} options
 */
export function makeEntraJwks({
  tenantId,
  offlineKeys = null,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  attempts = DEFAULT_ATTEMPTS,
  maxTotalMs = DEFAULT_MAX_TOTAL_MS,
  logger = console,
} = {}) {
  const url = jwksUrlFor(tenantId);

  let cached = null;      // last good live set
  let cachedAt = 0;
  let lastAttemptAt = 0;

  const usable = (set) => Boolean(set && Array.isArray(set.keys) && set.keys.length);

  async function fetchOnce() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!usable(body)) throw new Error("key set is empty");
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Try a few times, bounded in total, then give up quietly. */
  async function fetchWithRetry() {
    const deadline = now() + maxTotalMs;
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetchOnce();
      } catch (err) {
        lastError = err;
        if (now() >= deadline || attempt === attempts) break;
      }
    }
    logger.warn?.(`[entra] could not refresh signing keys: ${lastError?.message || "unknown error"}`);
    return null;
  }

  return {
    /**
     * @param {{force?: boolean}} [options] force is for the "unknown kid" case:
     *   a token signed by a key we do not hold means Entra rotated, not that
     *   the token is bad.
     * @returns {Promise<{keys: object[]}|null>}
     */
    async get({ force = false } = {}) {
      const fresh = usable(cached) && now() - cachedAt < ttlMs;
      if (fresh && !force) return cached;

      /* A forced refetch still respects a cooldown, so a stream of bad tokens
         cannot turn into a stream of outbound requests. */
      if (now() - lastAttemptAt < cooldownMs) {
        return usable(cached) ? cached : (usable(offlineKeys) ? offlineKeys : null);
      }

      lastAttemptAt = now();
      const live = await fetchWithRetry();
      if (usable(live)) {
        cached = live;
        cachedAt = now();
        return cached;
      }

      if (usable(cached)) return cached;
      return usable(offlineKeys) ? offlineKeys : null;
    },

    /** For diagnostics on the admin screen. */
    state() {
      return {
        url,
        cachedKeys: usable(cached) ? cached.keys.length : 0,
        cachedAt: cachedAt ? new Date(cachedAt).toISOString() : null,
        offlineKeys: usable(offlineKeys) ? offlineKeys.keys.length : 0,
      };
    },
  };
}
