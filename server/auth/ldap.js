/**
 * Directory authentication.
 *
 * Mirrors DEDB's auth/ldap.js: bind as the user (so no service-account password
 * is needed to verify a credential), then read their group memberships. The
 * helpers are exported separately from the network call so the parsing rules
 * can be tested without a directory.
 */
import { Client } from "ldapts";
import { badCredentials, directoryUnavailable, directoryMisconfigured } from "./errors.js";

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
/** Shape a search entry into the identity the rest of the app consumes. */
function identityFrom(entry, sam) {
  const memberOf = Array.isArray(entry.memberOf)
    ? entry.memberOf
    : entry.memberOf ? [entry.memberOf] : [];
  return {
    principal: String(entry.userPrincipalName || entry.sAMAccountName || sam),
    displayName: String(entry.displayName || sam),
    groups: memberOf.map((dn) => cnOf(dn)).filter(Boolean),
  };
}

const USER_ATTRS = ["displayName", "memberOf", "userPrincipalName", "sAMAccountName", "distinguishedName"];

/**
 * Verify a credential and return the identity plus group names.
 *
 * Two paths, chosen by whether a service account is configured.
 *
 * WITH config.bindDN - search-then-bind. Bind as the service account, search for
 * the user, then bind the distinguishedName the DIRECTORY returned. Nothing is
 * constructed: this exists because bindIdentity()'s <user>@<suffix> guess cannot
 * work on a domain carrying more than one UPN suffix, which is the case here -
 * jdoe@example.com and svc_app@example.local live in the same directory, so no
 * single LDAP_UPN_SUFFIX is right for both. Group lookup also moves to the
 * service account, so a user without directory read rights stops resolving to
 * zero groups and being refused as 403 no_access.
 *
 * WITHOUT it - the original single bind as the user. Unchanged, and still what
 * DEDB's auth/ldap.js does; a deployment where user-bind works falls back by
 * removing one setting rather than by shipping code.
 *
 * @param {{username: string, password: string}} credential
 * @param {{url: string, baseDN: string, domain?: string, upnSuffix?: string, bindDN?: string, bindPassword?: string, timeoutMs?: number}} config
 * @param {{ClientCtor?: Function}} [deps] injection point for tests
 * @returns {Promise<{principal: string, displayName: string, groups: string[]}>}
 */
export async function authenticate({ username, password }, config, deps = {}) {
  /* Before ANY bind, and the order matters. LDAP treats a bind carrying a DN and
     an empty password as an unauthenticated bind, which AD accepts - so once the
     search below has supplied a real DN, reaching a bind with a blank password
     would authenticate any known username. */
  if (!username || !password) throw badCredentials();

  const ClientCtor = deps.ClientCtor || Client;
  const newClient = () => new ClientCtor({
    url: config.url,
    timeout: config.timeoutMs || 10000,
    connectTimeout: config.timeoutMs || 10000,
  });

  const sam = toSam(username);
  return config.bindDN
    ? searchThenBind({ sam, password }, config, newClient)
    : bindAsUser({ username, password, sam }, config, newClient);
}

/** Service-account path: bind as the app, find the user, bind as that DN. */
async function searchThenBind({ sam, password }, config, newClient) {
  const svc = newClient();
  try {
    try {
      await svc.bind(config.bindDN, config.bindPassword);
    } catch (err) {
      /* The app's credential, not the user's. Reporting this as 401 would send
         every user in the organisation to retype a password that was never
         wrong - the exact misdirection this module already fixed once. */
      if (isUnreachable(err)) throw directoryUnavailable(err?.message || "connection failed");
      throw directoryMisconfigured(err?.message || "the service account bind was rejected");
    }

    const { searchEntries } = await svc.search(config.baseDN, {
      scope: "sub",
      filter: `(&(objectCategory=person)(sAMAccountName=${escapeFilter(sam)}))`,
      attributes: USER_ATTRS,
    });

    const entry = searchEntries[0];
    if (!entry) throw badCredentials();

    const dn = String(entry.dn || entry.distinguishedName || "");
    /* The directory answered but not usably. Not the user's fault, so not a 401. */
    if (!dn) throw directoryMisconfigured("the directory returned a user with no distinguishedName");

    /* A separate connection for the verification bind. Rebinding the service
       account's own connection would leave it authenticated as the user for
       anything that followed. */
    const asUser = newClient();
    try {
      await asUser.bind(dn, password);
    } catch (err) {
      if (isUnreachable(err)) throw directoryUnavailable(err?.message || "connection failed");
      throw badCredentials();
    } finally {
      try { await asUser.unbind(); } catch { /* already gone */ }
    }

    return identityFrom(entry, sam);
  } catch (err) {
    if (err?.name === "AuthError") throw err;
    throw directoryUnavailable(err?.message || "unknown error");
  } finally {
    try { await svc.unbind(); } catch { /* already gone */ }
  }
}

/** The original path: one bind, as the user, then read their own entry. */
async function bindAsUser({ username, password, sam }, config, newClient) {
  const client = newClient();
  const identity = bindIdentity(username, config);

  try {
    try {
      await client.bind(identity, password);
    } catch (err) {
      /* Never disclose whether it was the account or the password -- but a
         directory we could not REACH is a different answer entirely. */
      if (isUnreachable(err)) throw directoryUnavailable(err?.message || "connection failed");
      throw badCredentials();
    }

    const { searchEntries } = await client.search(config.baseDN, {
      scope: "sub",
      filter: `(&(objectCategory=person)(sAMAccountName=${escapeFilter(sam)}))`,
      attributes: USER_ATTRS,
    });

    const entry = searchEntries[0];
    if (!entry) throw badCredentials();
    return identityFrom(entry, sam);
  } catch (err) {
    if (err?.name === "AuthError") throw err;
    throw directoryUnavailable(err?.message || "unknown error");
  } finally {
    try { await client.unbind(); } catch { /* already gone */ }
  }
}

/** What the admin console's picker shows for each match. */
const SEARCH_ATTRS = ["sAMAccountName", "displayName", "mail"];

/**
 * The most matches one query may return.
 *
 * A two-letter query matches most of a directory, and neither a picker nor the
 * connection between here and the DC benefits from the rest of it.
 */
const SEARCH_LIMIT = 25;

/**
 * Find people by a partial name, for the admin console's user picker.
 *
 * Ports DEDB's searchUsers. Binds as the SERVICE account - the signed-in
 * admin's own credential is not available at this point and must not be
 * needed - and matches the query against the three fields someone would
 * actually type: display name, mail address and account name.
 *
 * This exists so a role is granted to an account that demonstrably exists.
 * Typed by hand, a grant against a typo is stored happily, reports nothing,
 * and looks correct in the table while the person still cannot sign in.
 *
 * DEPARTS FROM DEDB in one respect: DEDB resolves every failure to [] and
 * never throws. Behind a search box that is wrong - "no matches" and "the
 * directory is unreachable" call for different actions, and collapsing them
 * hides an outage behind a result that merely looks disappointing.
 *
 * @param {string} query partial name, mail or account name
 * @param {object} config the ldap config block
 * @param {{ClientCtor?: Function}} [deps]
 * @returns {Promise<Array<{username: string, name: string, mail: string}>>}
 */
export async function searchUsers(query, config, deps = {}) {
  const q = String(query || "").trim();
  /* An empty box would otherwise page the whole directory back on every
     keystroke that cleared the field. */
  if (!q) return [];

  if (!config.bindDN || !config.bindPassword) {
    throw directoryMisconfigured(
      "searching the directory needs a service account; set LDAP_BIND_DN and LDAP_BIND_PASSWORD",
    );
  }

  const ClientCtor = deps.ClientCtor || Client;
  const client = new ClientCtor({
    url: config.url,
    timeout: config.timeoutMs || 10000,
    connectTimeout: config.timeoutMs || 10000,
  });

  try {
    try {
      await client.bind(config.bindDN, config.bindPassword);
    } catch (err) {
      if (isUnreachable(err)) throw directoryUnavailable(err?.message || "connection failed");
      throw directoryMisconfigured(err?.message || "the service account bind was rejected");
    }

    const esc = escapeFilter(q);
    const { searchEntries } = await client.search(config.baseDN, {
      scope: "sub",
      /* Leading wildcards on the two human-facing fields, because an admin
         searches for a surname as readily as a first name. sAMAccountName is
         prefix-only: it is an identifier, and a substring match over it
         returns noise without finding anything a person meant. */
      filter: `(&(objectCategory=person)(|(displayName=*${esc}*)(mail=*${esc}*)(sAMAccountName=${esc}*)))`,
      attributes: SEARCH_ATTRS,
      sizeLimit: SEARCH_LIMIT,
    });

    return (searchEntries || [])
      .slice(0, SEARCH_LIMIT)
      .map((e) => ({
        username: String(e.sAMAccountName || ""),
        /* Falling back to the account name rather than leaving this blank: an
           unlabelled row in a picker cannot be picked. */
        name: String(e.displayName || e.sAMAccountName || ""),
        mail: String(e.mail || ""),
      }))
      .filter((u) => u.username);
  } finally {
    try { await client.unbind(); } catch { /* the search already answered */ }
  }
}
