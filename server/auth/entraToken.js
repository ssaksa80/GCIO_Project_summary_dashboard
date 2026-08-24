/**
 * Entra ID token validation for single sign-on.
 *
 * Mirrors DEDB's auth/entraToken.js. The distinction that matters there and
 * here: a token signed by a key we do not hold is not a bad token, it is a
 * stale key set, and it is reported separately so the caller can refetch once
 * and retry rather than refusing a legitimate sign-in.
 *
 * On the SSO path the token *is* the identity claim: nothing is known about
 * the caller beforehand, so there is nothing to bind it against. On an
 * MFA-second-factor path the caller already knows who the user should be and
 * passes expectedPrincipal, which binds the token to that identity.
 */
import { jwtVerify, createLocalJWKSet } from "jose";
import { toSam } from "./ldap.js";

/**
 * @param {string} idToken
 * @param {{issuer: string, clientId: string, jwks: {keys: object[]}, requireMfaClaim?: boolean}} cfg
 * @param {{nonce?: string, expectedPrincipal?: string, expectedMail?: string}} [expectations]
 * @returns {Promise<{ok: true, payload: object, sam: string, groups: string[]}|{ok: false, reason: string}>}
 */
export async function validateEntraIdToken(idToken, cfg, { nonce, expectedPrincipal, expectedMail } = {}) {
  if (!idToken) return { ok: false, reason: "no_token" };
  if (!cfg?.jwks?.keys?.length) return { ok: false, reason: "no_keys" };

  let payload;
  try {
    const jwks = createLocalJWKSet(cfg.jwks);
    ({ payload } = await jwtVerify(idToken, jwks, { issuer: cfg.issuer, audience: cfg.clientId }));
  } catch (err) {
    /* Stale key set, not a bad token: the caller should refetch and retry. */
    if (err?.code === "ERR_JWKS_NO_MATCHING_KEY") return { ok: false, reason: "unknown_kid" };
    if (err?.code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    return { ok: false, reason: "verify" };
  }

  if (nonce && payload.nonce !== nonce) return { ok: false, reason: "nonce" };

  if (cfg.requireMfaClaim !== false) {
    const amr = Array.isArray(payload.amr) ? payload.amr : [];
    if (!amr.includes("mfa")) return { ok: false, reason: "no_mfa" };
  }

  const upn = String(payload.preferred_username || payload.upn || payload.email || "");
  const sam = toSam(upn).toLowerCase();

  /* Binding applies only when the caller already knows who this should be.
     With neither expectation supplied there is nothing to bind against, and
     enforcing it would reject every SSO token. */
  if (expectedPrincipal || expectedMail) {
    const mailOk = expectedMail && payload.email
      && String(payload.email).toLowerCase() === String(expectedMail).toLowerCase();
    if (sam !== String(expectedPrincipal || "").toLowerCase() && !mailOk) {
      return { ok: false, reason: "identity" };
    }
  }

  return {
    ok: true,
    payload,
    sam,
    /* Entra emits group object IDs in `groups`; roleMapping is keyed on
       whatever the directory calls them, so both forms work. */
    groups: Array.isArray(payload.groups) ? payload.groups.map(String) : [],
  };
}

/**
 * Validate, and if the key set turns out to be stale, refetch once and retry.
 * This is the function routes should call.
 *
 * @param {string} idToken
 * @param {{issuer: string, clientId: string, requireMfaClaim?: boolean}} cfg
 * @param {{get: Function}} jwksSource from makeEntraJwks
 * @param {object} [expectations]
 */
export async function validateWithRefresh(idToken, cfg, jwksSource, expectations = {}) {
  const keys = await jwksSource.get();
  let result = await validateEntraIdToken(idToken, { ...cfg, jwks: keys || { keys: [] } }, expectations);

  if (result.ok || (result.reason !== "unknown_kid" && result.reason !== "no_keys")) return result;

  const refreshed = await jwksSource.get({ force: true });
  if (!refreshed) return result;
  result = await validateEntraIdToken(idToken, { ...cfg, jwks: refreshed }, expectations);
  return result;
}

/** Messages safe to show a user; anything else is deliberately vague. */
export const SSO_FAILURE_MESSAGE = {
  no_token: "no sign-in token was supplied",
  no_keys: "the identity provider's signing keys could not be retrieved",
  unknown_kid: "the identity provider's signing keys could not be retrieved",
  expired: "that sign-in has expired — please try again",
  no_mfa: "multi-factor authentication is required to use this dashboard",
  nonce: "sign-in failed, please try again",
  identity: "sign-in failed, please try again",
  verify: "sign-in failed, please try again",
};
