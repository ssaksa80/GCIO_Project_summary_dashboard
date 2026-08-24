/**
 * Security headers and a login throttle. Both dependency-free, mirroring
 * DEDB's src/middleware/securityHeaders.js and the throttle in its auth routes.
 *
 * On CSRF: DEDB carries no CSRF token, and neither does this. The session
 * cookie is SameSite=Strict, the app is same-origin with no CORS, and every
 * state-changing route requires that cookie — so a cross-site form post
 * arrives with no session and is refused as unauthenticated. Adding tokens on
 * top would be belt-and-braces; the decision is recorded here so nobody has to
 * rediscover why it is absent.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  /* The bundler inlines a small style block, and the client sets inline styles
     for chart geometry; fonts ship with the client, so nothing is external. */
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** @param {{https?: boolean}} [options] */
export function securityHeaders({ https = false } = {}) {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", CSP);
    if (https) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

/**
 * Per-IP attempt throttle. Sweeps expired entries once per window so the map
 * cannot grow without bound.
 *
 * @param {{max?: number, windowMs?: number, now?: () => number}} [options]
 * @returns {(ip: string) => boolean} false once the caller is over the limit
 */
export function makeRateLimiter({ max = 10, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  let nextSweep = now() + windowMs;

  return function allow(ip) {
    const t = now();
    if (t > nextSweep) {
      for (const [key, record] of hits) if (t > record.reset) hits.delete(key);
      nextSweep = t + windowMs;
    }
    const record = hits.get(ip) || { count: 0, reset: t + windowMs };
    if (t > record.reset) {
      record.count = 0;
      record.reset = t + windowMs;
    }
    record.count += 1;
    hits.set(ip, record);
    return record.count <= max;
  };
}

/** Express wrapper around makeRateLimiter, for one route. */
export function rateLimit(options = {}) {
  const allow = makeRateLimiter(options);
  return (req, res, next) => {
    if (allow(req.ip)) return next();
    res.status(429).json({
      error: { code: "rate_limited", message: options.message || "too many attempts, try again shortly" },
    });
  };
}
