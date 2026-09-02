/*
 * A service account is two settings, and either one alone is a trap.
 *
 * server/auth/ldap.js chooses its whole bind strategy on `config.bindDN` being
 * truthy. So LDAP_BIND_DN set with LDAP_BIND_PASSWORD empty does not degrade to
 * the old path - it takes the search-then-bind path and binds with an empty
 * password, which AD treats as an ANONYMOUS bind. That bind usually SUCCEEDS,
 * the subsequent search returns nothing, and every user in the organisation
 * gets 401 with a correct password. Nothing in the logs says "misconfigured".
 *
 * The reverse - a password with no DN - is quieter and just as wrong: the app
 * ignores the credential entirely and keeps guessing UPNs, so an operator who
 * believes they configured a service account has not.
 *
 * Both are configuration errors, and this file pins that they are reported as
 * configuration errors at load, next to the other fail-closed checks, rather
 * than becoming an authentication mystery at 9am.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../../server/config.js";

const ldapBase = {
  STORE: "memory",
  AUTH_MODE: "ldap",
  LDAP_URL: "ldaps://dc.example.test:636",
  LDAP_BASE_DN: "DC=example,DC=test",
};

test("a bind DN with no password is refused at load, not at sign-in", () => {
  assert.throws(
    () => loadConfig({ ...ldapBase, LDAP_BIND_DN: "svc@example.test" }),
    /LDAP_BIND_PASSWORD/,
    "LDAP_BIND_DN alone selects search-then-bind and binds anonymously; every sign-in fails with a correct password and nothing reports why",
  );
});

test("a bind password with no DN is refused at load", () => {
  assert.throws(
    () => loadConfig({ ...ldapBase, LDAP_BIND_PASSWORD: "s3cret" }),
    /LDAP_BIND_DN/,
    "the credential would be ignored in silence and the app would keep guessing UPNs",
  );
});

test("the complaint names both settings, so the fix is obvious from the message", () => {
  let message = "";
  try { loadConfig({ ...ldapBase, LDAP_BIND_DN: "svc@example.test" }); }
  catch (err) { message = err.message; }
  assert.match(message, /LDAP_BIND_DN/);
  assert.match(message, /LDAP_BIND_PASSWORD/);
});

/* The two states that must keep working, or this guard is a regression. */
test("both set together is accepted and selects search-then-bind", () => {
  const cfg = loadConfig({ ...ldapBase, LDAP_BIND_DN: "svc@example.test", LDAP_BIND_PASSWORD: "s3cret" });
  assert.equal(cfg.ldap.bindDN, "svc@example.test");
  assert.ok(cfg.ldap.bindPassword, "the password must survive load or the bind cannot happen");
});

test("neither set is accepted and keeps the original bind-as-user path", () => {
  const cfg = loadConfig(ldapBase);
  assert.equal(cfg.ldap.bindDN, "", "an empty bindDN is what server/auth/ldap.js tests to stay on the old path");
});

/*
 * Whitespace only, because .env files collect it and `LDAP_BIND_DN= ` looks
 * exactly like `LDAP_BIND_DN=` to a human and nothing like it to a parser.
 * bindDN is trimmed at load, so this must land on the same side as empty.
 */
test("a whitespace-only bind DN counts as unset, not as a configured account", () => {
  const cfg = loadConfig({ ...ldapBase, LDAP_BIND_DN: "   " });
  assert.equal(cfg.ldap.bindDN, "");
});

/* AUTH_MODE=dev never reads these, so the guard must not fire outside ldap. */
test("the guard does not fire when AUTH_MODE is not ldap", () => {
  assert.doesNotThrow(
    () => loadConfig({ STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin", LDAP_BIND_DN: "svc@example.test" }),
  );
});
