/**
 * Session cookie helpers and the Express middleware that enforces them.
 *
 * Mirrors DEDB's auth/session.js: the cookie is an opaque id, validation goes
 * through the sessions repository, and last-seen is updated best-effort so a
 * slow write never blocks a request.
 */
import { RANK } from "./authz.js";

export const SESSION_COOKIE = "gcio_session";

const cookieOptions = (secure) => ({
  httpOnly: true,
  secure: Boolean(secure),
  sameSite: "strict",
  path: "/",
});

export function setSessionCookie(res, sessionId, { secure } = {}) {
  res.cookie(SESSION_COOKIE, sessionId, cookieOptions(secure));
}

export function clearSessionCookie(res, { secure } = {}) {
  res.clearCookie(SESSION_COOKIE, cookieOptions(secure));
}

/**
 * Attach req.session when the cookie names a live session. Never rejects — use
 * requireSession for that — so public routes can still see who is calling.
 * @param {{sessions: object, idleMinutes?: number}} deps
 */
export function attachSession({ sessions, idleMinutes = 240 }) {
  return async (req, res, next) => {
    try {
      const sid = req.cookies?.[SESSION_COOKIE];
      req.session = sid ? await sessions.getLive(sid, idleMinutes) : null;
      if (req.session) {
        Promise.resolve(sessions.touch(sid, req.ip)).catch(() => {});
      }
      next();
    } catch (err) {
      /* A database outage must not masquerade as "signed out": surface it. */
      next(err);
    }
  };
}

/** 401 unless a live session is attached. Run attachSession first. */
export function requireSession(req, res, next) {
  if (!req.session) {
    return res.status(401).json({
      error: { code: "no_session", message: "not authenticated", login: "/api/auth/login" },
    });
  }
  next();
}

/**
 * 403 unless the session's role is at least `minimum`.
 * @param {"viewer"|"pm"|"admin"} minimum
 */
export function requireRole(minimum) {
  const floor = RANK[minimum];
  if (!floor) throw new Error(`unknown role '${minimum}'`);
  return (req, res, next) => {
    const held = RANK[req.session?.role] || 0;
    if (held < floor) {
      return res.status(403).json({
        error: { code: "forbidden", message: `this action requires the ${minimum} role` },
      });
    }
    next();
  };
}
