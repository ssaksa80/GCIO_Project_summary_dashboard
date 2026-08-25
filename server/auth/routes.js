/**
 * Sign-in, sign-out, and "who am I".
 *
 * Sign-in verifies the credential against the directory, folds the caller's
 * groups to a role, and creates a server-side session. Nothing here trusts the
 * client: the role is resolved server-side on every sign-in, never sent in.
 */
import express from "express";
import { authenticate } from "./ldap.js";
import { resolveAccess } from "./authz.js";
import { computeExpiry } from "../repos/sessions.js";
import { setSessionCookie, clearSessionCookie, SESSION_COOKIE } from "./session.js";
import { AuthError, badCredentials } from "./errors.js";
import { validateWithRefresh, SSO_FAILURE_MESSAGE } from "./entraToken.js";

/**
 * @param {{
 *   config: object,
 *   sessions: object,
 *   roleMapping: object,
 *   audit: {append: Function},
 *   ldapAuthenticate?: Function
 * }} deps
 */
export function authRoutes(deps) {
  const { config, sessions, roleMapping, audit } = deps;
  const ldapAuthenticate = deps.ldapAuthenticate || authenticate;
  const router = express.Router();
  const secure = Boolean(config.isProd);

  const auditFrom = (req, event) =>
    audit.append({ ...event, ip: req.ip, userAgent: req.get?.("user-agent"), requestId: req.id });

  router.post("/api/auth/login", async (req, res, next) => {
    const { username, password } = req.body || {};
    try {
      if (!username || !password) throw badCredentials();

      const identity = await ldapAuthenticate({ username, password }, config.ldap);
      const { role } = await resolveAccess(identity, { roleMapping });

      const sessionId = await sessions.create({
        principal: identity.principal,
        displayName: identity.displayName,
        role,
        groups: identity.groups,
        expiresAt: computeExpiry(config.sessionAbsoluteHours),
        ip: req.ip,
      });

      setSessionCookie(res, sessionId, { secure });
      await auditFrom(req, { actor: identity.principal, action: "signin", subject: role });

      res.json({
        authenticated: true,
        principal: identity.principal,
        displayName: identity.displayName,
        role,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        await auditFrom(req, {
          actor: String(username || "unknown"),
          action: err.code === "no_access" ? "signin.denied" : "signin.failed",
          subject: err.code,
        });
        return res.status(err.status).json({ error: { code: err.code, message: err.message } });
      }
      next(err);
    }
  });

  /**
   * Single sign-on. The browser obtains an Entra ID token (MSAL) and posts it
   * here; the token is the identity claim, so it is validated in full —
   * issuer, audience, signature, expiry, MFA — before any session exists.
   */
  router.post("/api/auth/sso", async (req, res, next) => {
    if (!config.ssoEnabled || !deps.entraJwks) {
      return res.status(404).json({ error: { code: "sso_disabled", message: "single sign-on is not enabled" } });
    }
    const { idToken, nonce } = req.body || {};
    try {
      const verdict = await validateWithRefresh(idToken, config.entra, deps.entraJwks, { nonce });
      if (!verdict.ok) {
        await auditFrom(req, { actor: "unknown", action: "signin.sso.failed", subject: verdict.reason });
        const status = verdict.reason === "no_keys" || verdict.reason === "unknown_kid" ? 503 : 401;
        return res.status(status).json({
          error: { code: verdict.reason, message: SSO_FAILURE_MESSAGE[verdict.reason] || "sign-in failed" },
        });
      }

      const identity = {
        principal: String(verdict.payload.preferred_username || verdict.payload.upn || verdict.sam),
        displayName: String(verdict.payload.name || verdict.sam),
        groups: verdict.groups,
      };
      const { role } = await resolveAccess(identity, { roleMapping });

      const sessionId = await sessions.create({
        principal: identity.principal,
        displayName: identity.displayName,
        role,
        groups: identity.groups,
        expiresAt: computeExpiry(config.sessionAbsoluteHours),
        ip: req.ip,
      });

      setSessionCookie(res, sessionId, { secure });
      await auditFrom(req, { actor: identity.principal, action: "signin.sso", subject: role });
      res.json({ authenticated: true, principal: identity.principal, displayName: identity.displayName, role });
    } catch (err) {
      if (err instanceof AuthError) {
        await auditFrom(req, { actor: "unknown", action: "signin.denied", subject: err.code });
        return res.status(err.status).json({ error: { code: err.code, message: err.message } });
      }
      next(err);
    }
  });

  router.post("/api/auth/logout", async (req, res, next) => {
    try {
      const sid = req.cookies?.[SESSION_COOKIE];
      if (sid) await sessions.destroy(sid);
      clearSessionCookie(res, { secure });
      await auditFrom(req, { actor: req.session?.principal || "anonymous", action: "signout", subject: "" });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/api/me", (req, res) => {
    if (!req.session) {
      return res.json({
        authenticated: false,
        sso: Boolean(config.ssoEnabled),
        devMode: config.authMode === "dev",
        /* Client id and tenant id are public values in a public-client flow;
           the client secret is never sent to a browser. */
        entra: config.ssoEnabled
          ? { clientId: config.entra.clientId, tenantId: config.entra.tenantId }
          : null,
      });
    }
    const { principal, displayName, role, expiresAt } = req.session;
    res.json({ authenticated: true, principal, displayName, role, expiresAt });
  });

  return router;
}
