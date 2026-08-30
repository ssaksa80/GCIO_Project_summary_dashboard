/**
 * Directory authentication.
 *
 * Mirrors DEDB's auth/ldap.js: bind as the user (so no service-account password
 * is needed to verify a credential), then read their group memberships. The
 * helpers are exported separately from the network call so the parsing rules
 * can be tested without a directory.
 */
import { Client } from "ldapts";
import { badCredentials, directoryUnavailable } from "./errors.js";

/** "DOMAIN\\user", "user@domain" or "user" -> "user". */
export function toSam(user) {
  const s = String(user || "");
  if (s.includes("\\")) return s.split("\\").pop();
  if (s.includes("@")) return s.split("@")[0];
  return s;
}

/** "DC=example,DC=local" -> "example.local" */
function upnFromBaseDN(baseDN) {
  const dcs = String(baseDN || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^DC=/i.test(s))
    .map((s) => s.slice(3));
  return dcs.length ? dcs.join(".") : "";
}

/**
 * Turn a bare username into something bindable, so people do not have to type
 * the domain. Already-qualified input is returned unchanged.
 */
/**
 * Could this bind failure only be a network problem?
 *
 * Deliberately conservative: anything not confidently a connection failure
 * falls through to bad_credentials. Guessing "unreachable" on an unfamiliar
 * error would leak that the account exists but the password was wrong, which is
 * precisely the disclosure the surrounding code exists to prevent. A wrong
 * guess in this direction costs only the old, less helpful message.
 *
 * @param {any} err
 * @returns {boolean}
 */
function isUnreachable(err) {
  const code = String(err?.code || "");
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH",
       "ENETUNREACH", "ECONNRESET", "EAI_AGAIN", "EPIPE"].includes(code)) {
    return true;
  }
  const msg = String(err?.message || "").toLowerCase();
  return /connect(ion)? (timeout|refused|reset|failed)|getaddrinfo|socket hang up|unable to connect|host unreachable|network is unreachable/.test(msg);
}

export function bindIdentity(user, config = {}) {
  const s = String(user || "");
  if (!s || s.includes("\\") || s.includes("@")) return s;
  const suffix = config.upnSuffix
    || upnFromBaseDN(config.baseDN)
    || (String(config.domain || "").includes(".") ? config.domain : "");
  if (suffix) return `${s}@${suffix}`;
  if (config.domain) return `${config.domain}\\${s}`;
  return s;
}

/** "CN=Portfolio Viewers,OU=Groups,DC=x" -> "Portfolio Viewers" */
export function cnOf(dn) {
  const m = /^CN=([^,]+)/i.exec(String(dn));
  return m ? m[1] : null;
}

/**
 * RFC 4515 escaping for a value placed inside a search filter. Without this, a
 * username containing `*` or `)` rewrites the filter.
 */
export function escapeFilter(value) {
  return String(value ?? "").replace(/[\\*()\0]/g, (c) => ({
    "\\": "\\5c", "*": "\\2a", "(": "\\28", ")": "\\29", "\0": "\\00",
  }[c]));
}

/**
 * Verify a credential and return the identity plus group names.
 *
 * @param {{username: string, password: string}} credential
 * @param {{url: string, baseDN: string, domain?: string, upnSuffix?: string, timeoutMs?: number}} config
 * @param {{ClientCtor?: Function}} [deps] injection point for tests
 * @returns {Promise<{principal: string, displayName: string, groups: string[]}>}
 */
export async function authenticate({ username, password }, config, deps = {}) {
  if (!username || !password) throw badCredentials();

  const ClientCtor = deps.ClientCtor || Client;
  const client = new ClientCtor({
    url: config.url,
    timeout: config.timeoutMs || 10000,
    connectTimeout: config.timeoutMs || 10000,
  });

  const identity = bindIdentity(username, config);
  const sam = toSam(username);

  try {
    try {
      await client.bind(identity, password);
    } catch (err) {
      /* Never disclose whether it was the account or the password -- but a
         directory we could not REACH is a different answer entirely. Telling
         someone whose domain controller is down to "check the username and
         password" sends them to retype passwords and escalate to the wrong
         team; it was doing exactly that, verified against the live deployment.

         Only connection-class failures are separated out. Everything else
         stays indistinguishable, so a wrong password and a missing account
         still look identical -- which is what the non-disclosure is for. */
      if (isUnreachable(err)) throw directoryUnavailable(err?.message || "connection failed");
      throw badCredentials();
    }

    const { searchEntries } = await client.search(config.baseDN, {
      scope: "sub",
      filter: `(&(objectCategory=person)(sAMAccountName=${escapeFilter(sam)}))`,
      attributes: ["displayName", "memberOf", "userPrincipalName", "sAMAccountName"],
    });

    const entry = searchEntries[0];
    if (!entry) throw badCredentials();

    const memberOf = Array.isArray(entry.memberOf)
      ? entry.memberOf
      : entry.memberOf ? [entry.memberOf] : [];

    return {
      principal: String(entry.userPrincipalName || entry.sAMAccountName || sam),
      displayName: String(entry.displayName || sam),
      groups: memberOf.map((dn) => cnOf(dn)).filter(Boolean),
    };
  } catch (err) {
    if (err?.name === "AuthError") throw err;
    throw directoryUnavailable(err?.message || "unknown error");
  } finally {
    try {
      await client.unbind();
    } catch {
      /* the socket is already gone; nothing to close */
    }
  }
}
