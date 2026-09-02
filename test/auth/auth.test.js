/**
 * Authentication and authorisation.
 *
 * The directory and the database are faked, because what needs proving is the
 * policy: unmapped groups grant nothing, the highest role wins, a filter cannot
 * be rewritten by a hostile username, and a failed sign-in never reveals which
 * half of the credential was wrong.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

import { bestRole, resolveRole, resolveAccess, RANK } from "../../server/auth/authz.js";
import { toSam, bindIdentity, cnOf, escapeFilter, authenticate } from "../../server/auth/ldap.js";
import { attachSession, requireSession, requireRole, SESSION_COOKIE } from "../../server/auth/session.js";
import { authRoutes } from "../../server/auth/routes.js";
import { computeExpiry } from "../../server/repos/sessions.js";

/* ----------------------------------------------------------------- authz */

test("the highest-precedence role wins across several groups", () => {
  const map = { "portfolio viewers": "viewer", "portfolio pms": "pm", "portfolio admins": "admin" };
  assert.equal(resolveRole(["Portfolio Viewers", "Portfolio PMs"], map), "pm");
  assert.equal(resolveRole(["Portfolio Viewers", "Portfolio Admins"], map), "admin");
  assert.equal(resolveRole(["Portfolio Viewers"], map), "viewer");
});

test("groups nobody mapped grant nothing at all", () => {
  const map = { "portfolio viewers": "viewer" };
  assert.equal(resolveRole(["Domain Users", "All Staff"], map), null);
  assert.equal(resolveRole([], map), null);
  assert.equal(resolveRole(undefined, map), null);
});

test("group matching ignores case, as directories do", () => {
  assert.equal(resolveRole(["PORTFOLIO ADMINS"], { "portfolio admins": "admin" }), "admin");
});

test("bestRole folds a per-user grant against a group grant", () => {
  assert.equal(bestRole("viewer", "admin"), "admin");
  assert.equal(bestRole("viewer", null), "viewer");
  assert.equal(bestRole(null, undefined), null);
  assert.equal(bestRole("nonsense"), null);
});

test("resolveAccess refuses a user the directory knows but nothing grants", async () => {
  const deps = { roleMapping: { getMap: async () => ({ "portfolio pms": "pm" }) } };
  await assert.rejects(
    () => resolveAccess({ principal: "someone@x", groups: ["Domain Users"] }, deps),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, "no_access");
      return true;
    }
  );
});

test("roles rank admin over pm over viewer", () => {
  assert.ok(RANK.admin > RANK.pm && RANK.pm > RANK.viewer);
});

/* ------------------------------------------------------------------ ldap */

test("a username is reduced to its sAMAccountName however it was typed", () => {
  assert.equal(toSam("EXAMPLE\\jsmith"), "jsmith");
  assert.equal(toSam("jsmith@example.local"), "jsmith");
  assert.equal(toSam("jsmith"), "jsmith");
});

test("a bare username is qualified from the base DN", () => {
  assert.equal(bindIdentity("jsmith", { baseDN: "DC=example,DC=local" }), "jsmith@example.local");
  assert.equal(bindIdentity("jsmith", { domain: "EXAMPLE" }), "EXAMPLE\\jsmith");
  assert.equal(bindIdentity("EXAMPLE\\jsmith", { baseDN: "DC=example,DC=local" }), "EXAMPLE\\jsmith");
  assert.equal(bindIdentity("jsmith@example.local", { domain: "EXAMPLE" }), "jsmith@example.local");
});

test("a group DN reduces to its common name", () => {
  assert.equal(cnOf("CN=Portfolio Admins,OU=Groups,DC=example,DC=local"), "Portfolio Admins");
  assert.equal(cnOf("not a dn"), null);
});

test("filter metacharacters in a username are escaped, not interpreted", () => {
  assert.equal(escapeFilter("j*smith"), "j\\2asmith");
  assert.equal(escapeFilter("a)(b"), "a\\29\\28b");
  assert.equal(escapeFilter("back\\slash"), "back\\5cslash");
});

test("a wildcard username cannot rewrite the search filter", async () => {
  let filterUsed = null;
  class FakeClient {
    async bind() {}
    async search(base, opts) {
      filterUsed = opts.filter;
      return { searchEntries: [{ sAMAccountName: "x", displayName: "X", memberOf: [] }] };
    }
    async unbind() {}
  }
  await authenticate({ username: "*", password: "p" }, { url: "ldap://x", baseDN: "DC=x" }, { ClientCtor: FakeClient });
  assert.ok(filterUsed.includes("\\2a"), `filter was not escaped: ${filterUsed}`);
  assert.ok(!filterUsed.includes("=*)"), "a bare wildcard reached the filter");
});

test("a bad password is reported the same way as a missing account", async () => {
  class RejectingClient {
    async bind() { throw new Error("invalid credentials"); }
    async search() { return { searchEntries: [] }; }
    async unbind() {}
  }
  class MissingUserClient {
    async bind() {}
    async search() { return { searchEntries: [] }; }
    async unbind() {}
  }
  const cfg = { url: "ldap://x", baseDN: "DC=x" };

  const wrongPassword = await authenticate({ username: "u", password: "bad" }, cfg, { ClientCtor: RejectingClient }).catch((e) => e);
  const noSuchUser = await authenticate({ username: "u", password: "p" }, cfg, { ClientCtor: MissingUserClient }).catch((e) => e);

  assert.equal(wrongPassword.code, "bad_credentials");
  assert.equal(noSuchUser.code, "bad_credentials");
  assert.equal(wrongPassword.message, noSuchUser.message);
});

test("memberOf is normalised to group names whether it arrives as one or many", async () => {
  class OneGroupClient {
    async bind() {}
    async search() {
      return { searchEntries: [{ sAMAccountName: "u", displayName: "U", memberOf: "CN=Solo,DC=x" }] };
    }
    async unbind() {}
  }
  const identity = await authenticate({ username: "u", password: "p" },
    { url: "ldap://x", baseDN: "DC=x" }, { ClientCtor: OneGroupClient });
  assert.deepEqual(identity.groups, ["Solo"]);
});

/* --------------------------------------------------------------- session */

test("expiry falls back to eight hours when the setting is nonsense", () => {
  const now = new Date("2026-08-24T09:00:00Z");
  assert.equal(computeExpiry("0", now), new Date("2026-08-24T17:00:00Z").toISOString());
  assert.equal(computeExpiry("not a number", now), new Date("2026-08-24T17:00:00Z").toISOString());
  assert.equal(computeExpiry("2", now), new Date("2026-08-24T11:00:00Z").toISOString());
});

/** An app with one route per protection level, backed by a fake sessions repo. */
function guardedApp(session) {
  const sessions = {
    async getLive() { return session; },
    async touch() {},
    async destroy() { return 1; },
  };
  const app = express();
  app.use(cookieParser());
  app.use(attachSession({ sessions }));
  app.get("/api/open", (req, res) => res.json({ ok: true }));
  app.get("/api/read", requireSession, (req, res) => res.json({ role: req.session.role }));
  app.post("/api/upload", requireSession, requireRole("pm"), (req, res) => res.json({ ok: true }));
  app.get("/api/audit", requireSession, requireRole("admin"), (req, res) => res.json({ ok: true }));
  return app;
}

const withCookie = (agent, method, url) =>
  agent[method](url).set("Cookie", `${SESSION_COOKIE}=6f1b2c34-5d6e-4f70-8a9b-0c1d2e3f4a5b`);

test("no session means 401 on protected routes and 200 on open ones", async () => {
  const agent = request(guardedApp(null));
  assert.equal((await agent.get("/api/open")).status, 200);
  const denied = await agent.get("/api/read");
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, "no_session");
});

test("a viewer may read but may not upload", async () => {
  const agent = request(guardedApp({ principal: "v@x", role: "viewer", displayName: "V" }));
  assert.equal((await withCookie(agent, "get", "/api/read")).status, 200);
  const denied = await withCookie(agent, "post", "/api/upload");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "forbidden");
});

test("a pm may upload but may not read the audit log", async () => {
  const agent = request(guardedApp({ principal: "p@x", role: "pm", displayName: "P" }));
  assert.equal((await withCookie(agent, "post", "/api/upload")).status, 200);
  assert.equal((await withCookie(agent, "get", "/api/audit")).status, 403);
});

test("an admin may do everything", async () => {
  const agent = request(guardedApp({ principal: "a@x", role: "admin", displayName: "A" }));
  assert.equal((await withCookie(agent, "post", "/api/upload")).status, 200);
  assert.equal((await withCookie(agent, "get", "/api/audit")).status, 200);
});

/* ---------------------------------------------------------------- routes */

function loginApp({ identity, roleMap, audited = [] }) {
  const created = [];
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(attachSession({ sessions: { async getLive() { return null; }, async touch() {} } }));
  app.use(authRoutes({
    config: { isProd: false, sessionAbsoluteHours: "8", ldap: { url: "ldap://x", baseDN: "DC=x" } },
    sessions: {
      async create(input) { created.push(input); return "6f1b2c34-5d6e-4f70-8a9b-0c1d2e3f4a5b"; },
      async destroy() { return 1; },
    },
    roleMapping: { getMap: async () => roleMap },
    audit: { append: async (e) => { audited.push(e); } },
    ldapAuthenticate: async () => {
      if (identity instanceof Error) throw identity;
      return identity;
    },
  }));
  return { app, created, audited };
}

test("a successful sign-in sets an httpOnly cookie and returns the resolved role", async () => {
  const { app, created } = loginApp({
    identity: { principal: "jsmith@example.local", displayName: "J Smith", groups: ["Portfolio PMs"] },
    roleMap: { "portfolio pms": "pm" },
  });

  const res = await request(app).post("/api/auth/login").send({ username: "jsmith", password: "correct" });

  assert.equal(res.status, 200);
  assert.equal(res.body.role, "pm");
  assert.equal(created[0].role, "pm");

  const cookie = res.headers["set-cookie"].join(";");
  assert.match(cookie, /gcio_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test("the client cannot choose its own role", async () => {
  const { app, created } = loginApp({
    identity: { principal: "v@example.local", displayName: "V", groups: ["Portfolio Viewers"] },
    roleMap: { "portfolio viewers": "viewer" },
  });

  const res = await request(app).post("/api/auth/login")
    .send({ username: "v", password: "p", role: "admin" });

  assert.equal(res.body.role, "viewer");
  assert.equal(created[0].role, "viewer");
});

test("a user in no mapped group is refused with 403 and audited as denied", async () => {
  const audited = [];
  const { app } = loginApp({
    identity: { principal: "nobody@example.local", displayName: "N", groups: ["Domain Users"] },
    roleMap: { "portfolio pms": "pm" },
    audited,
  });

  const res = await request(app).post("/api/auth/login").send({ username: "nobody", password: "p" });

  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "no_access");
  assert.equal(audited.at(-1).action, "signin.denied");
});

test("a missing credential is refused without touching the directory", async () => {
  const { app } = loginApp({ identity: new Error("should not be called"), roleMap: {} });
  const res = await request(app).post("/api/auth/login").send({ username: "", password: "" });
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, "bad_credentials");
});

test("me reports signed out before sign-in", async () => {
  const { app } = loginApp({ identity: null, roleMap: {} });
  const res = await request(app).get("/api/me");
  assert.equal(res.body.authenticated, false);
});

/*
 * A directory that cannot be REACHED must not be reported as a bad password.
 *
 * The bind was wrapped in a bare `catch { throw badCredentials() }`, whose
 * comment gives the right reason - never disclose whether it was the account or
 * the password - but applies it too widely. A network failure is not a
 * disclosure concern, and conflating the two tells an operator whose domain
 * controller is down to "check the username and password". They retype
 * passwords, escalate to the wrong team, and never suspect the directory.
 *
 * Verified against the live deployment before fixing: with LDAP_URL pointed at
 * an unreachable host, a sign-in returned the identical 401 bad_credentials it
 * returns for a genuinely wrong password.
 *
 * The non-disclosure property is preserved exactly: a wrong password and a
 * missing account are still indistinguishable (the test above pins that). Only
 * connection-class failures are separated out.
 */
test("an unreachable directory is 503, not a bad password", async () => {
  const cfg = { url: "ldaps://no-such-dc.example:636", baseDN: "DC=x" };

  const cases = [
    ["ECONNREFUSED", Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:636"), { code: "ECONNREFUSED" })],
    ["ENOTFOUND",    Object.assign(new Error("getaddrinfo ENOTFOUND no-such-dc"), { code: "ENOTFOUND" })],
    ["ETIMEDOUT",    Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })],
    ["connect timeout (no code)", new Error("connection timeout")],
  ];

  for (const [label, err] of cases) {
    class UnreachableClient {
      async bind() { throw err; }
      async search() { return { searchEntries: [] }; }
      async unbind() {}
    }
    const result = await authenticate({ username: "u", password: "p" }, cfg, { ClientCtor: UnreachableClient })
      .catch((e) => e);
    assert.equal(result.code, "directory_unavailable", `${label} should report the directory, not the credentials`);
    assert.equal(result.status, 503, `${label} should be 503, not 401`);
  }
});

test("a credential rejection is still 401, and still indistinguishable from a missing account", async () => {
  /*
   * The classifier must default to bad_credentials for anything it cannot
   * confidently call a network failure. Guessing "unreachable" on an unfamiliar
   * error would leak that the account exists but the password was wrong.
   */
  const cfg = { url: "ldap://x", baseDN: "DC=x" };
  for (const message of ["invalid credentials", "80090308: LdapErr: DSID-0C0903A9", "something unfamiliar"]) {
    class RejectingClient {
      async bind() { throw new Error(message); }
      async search() { return { searchEntries: [] }; }
      async unbind() {}
    }
    const r = await authenticate({ username: "u", password: "bad" }, cfg, { ClientCtor: RejectingClient }).catch((e) => e);
    assert.equal(r.code, "bad_credentials", `"${message}" must stay bad_credentials - defaulting to unreachable would leak account existence`);
    assert.equal(r.status, 401);
  }
});

/* ---------------------------------------------------------------------------
   Service-account search-then-bind.

   This deployment's directory cannot use the bind-as-user path: bindIdentity()
   constructs <user>@LDAP_UPN_SUFFIX and the domain carries mixed suffixes, so a
   correct password returns 401. Searching by sAMAccountName as a service
   account and then binding the DN the directory returns removes the guess
   rather than reconfiguring it.

   Every test below records the binds in order, because "which principal bound,
   with what, and in what sequence" is the entire behaviour under test and none
   of it is visible from the return value.
   ------------------------------------------------------------------------- */

/** A directory that records binds and answers one user. */
function fakeDirectory({ entry, rejectBindFor = [], unreachableFor = [] } = {}) {
  const binds = [];
  class Fake {
    async bind(dn, password) {
      binds.push({ dn, password });
      if (unreachableFor.includes(dn)) {
        const e = new Error("connect ECONNREFUSED 10.0.0.1:636");
        e.code = "ECONNREFUSED";
        throw e;
      }
      if (rejectBindFor.includes(dn)) throw new Error("invalid credentials");
    }
    async search() { return { searchEntries: entry ? [entry] : [] }; }
    async unbind() {}
  }
  return { Fake, binds };
}

const SVC = "CN=svc,OU=Svc,DC=x";
const USER_DN = "CN=Real User,OU=People,DC=x";
const svcCfg = {
  url: "ldaps://dc:636", baseDN: "DC=x",
  bindDN: SVC, bindPassword: "svc-secret",
};
const anEntry = {
  dn: USER_DN,
  distinguishedName: USER_DN,
  sAMAccountName: "ruser",
  userPrincipalName: "ruser@elsewhere.example",
  displayName: "Real User",
  memberOf: ["CN=GCIO-Dashboard-Admins,DC=x"],
};

test("it binds as the service account first, then as the DN the directory returned", async () => {
  const { Fake, binds } = fakeDirectory({ entry: anEntry });
  const identity = await authenticate({ username: "ruser", password: "user-pw" }, svcCfg, { ClientCtor: Fake });

  assert.equal(binds.length, 2, `expected two binds, got ${binds.length}`);
  assert.equal(binds[0].dn, SVC, "the first bind must be the service account");
  assert.equal(binds[0].password, "svc-secret");
  assert.equal(binds[1].dn, USER_DN, "the second bind must use the DN from the search");
  assert.equal(binds[1].password, "user-pw");
  assert.equal(identity.principal, "ruser@elsewhere.example");
  assert.deepEqual(identity.groups, ["GCIO-Dashboard-Admins"]);
});

test("the user's bind never uses a constructed UPN, even when a suffix is configured", async () => {
  const { Fake, binds } = fakeDirectory({ entry: anEntry });
  await authenticate({ username: "ruser", password: "user-pw" },
    { ...svcCfg, upnSuffix: "wrong.example" }, { ClientCtor: Fake });

  assert.equal(binds[1].dn, USER_DN);
  assert.ok(!binds[1].dn.includes("wrong.example"),
    "the configured suffix leaked into the bind identity - this is the bug the design removes");
});

test("a rejected SERVICE ACCOUNT is a 503, never a 401 blamed on the user", async () => {
  const { Fake } = fakeDirectory({ entry: anEntry, rejectBindFor: [SVC] });
  const err = await authenticate({ username: "ruser", password: "user-pw" }, svcCfg,
    { ClientCtor: Fake }).catch((e) => e);

  assert.equal(err.status, 503, "a wrong service-account password must not be reported as the user's fault");
  assert.equal(err.code, "directory_misconfigured");
  assert.ok(!/password/i.test(err.message) || /service/i.test(err.message),
    "the message must not send an end user to retype their own password");
});

test("an unreachable directory is still 503 unavailable, not misconfigured", async () => {
  const { Fake } = fakeDirectory({ entry: anEntry, unreachableFor: [SVC] });
  const err = await authenticate({ username: "ruser", password: "p" }, svcCfg,
    { ClientCtor: Fake }).catch((e) => e);

  assert.equal(err.status, 503);
  assert.equal(err.code, "directory_unavailable");
});

test("a wrong user password and an unknown account stay indistinguishable", async () => {
  const wrong = fakeDirectory({ entry: anEntry, rejectBindFor: [USER_DN] });
  const missing = fakeDirectory({ entry: null });

  const a = await authenticate({ username: "ruser", password: "bad" }, svcCfg, { ClientCtor: wrong.Fake }).catch((e) => e);
  const b = await authenticate({ username: "nobody", password: "p" }, svcCfg, { ClientCtor: missing.Fake }).catch((e) => e);

  assert.equal(a.code, "bad_credentials");
  assert.equal(b.code, "bad_credentials");
  assert.equal(a.message, b.message);
  assert.equal(a.status, b.status);
});

test("an empty password is refused BEFORE any bind is attempted", async () => {
  /* LDAP treats a bind carrying a DN and an empty password as an unauthenticated
     bind, and AD accepts it. Once the search has supplied a real DN, a missing
     guard here would authenticate any known username with a blank password. */
  const { Fake, binds } = fakeDirectory({ entry: anEntry });
  const err = await authenticate({ username: "ruser", password: "" }, svcCfg, { ClientCtor: Fake }).catch((e) => e);

  assert.equal(err.code, "bad_credentials");
  assert.equal(binds.length, 0, "a bind was attempted with an empty password");
});

test("without a bindDN the original single-bind path is used unchanged", async () => {
  const { Fake, binds } = fakeDirectory({ entry: anEntry });
  await authenticate({ username: "ruser", password: "user-pw" },
    { url: "ldap://x", baseDN: "DC=x", upnSuffix: "example.local" }, { ClientCtor: Fake });

  assert.equal(binds.length, 1, "fallback mode must bind exactly once");
  assert.equal(binds[0].dn, "ruser@example.local", "fallback must still construct the UPN as before");
});
