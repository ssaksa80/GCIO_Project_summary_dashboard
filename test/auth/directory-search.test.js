/*
 * Directory search, for the admin console's user picker.
 *
 * Ports DEDB's searchUsers (server/src/auth/ldap.js): bind as the service
 * account, match a partial string against displayName, mail and
 * sAMAccountName, and return a small capped list.
 *
 * It exists so an admin grants a role to an account that demonstrably EXISTS.
 * Typing a principal by hand stores a grant against a typo, which nothing
 * reports - the person simply still cannot sign in, and the grant sitting in
 * the table looks correct.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { searchUsers } from "../../server/auth/ldap.js";

function fakeDirectory({ entries = [], rejectBindFor = [], unreachableFor = [] } = {}) {
  const binds = [];
  const searches = [];
  class Fake {
    async bind(dn, password) {
      binds.push({ dn, password });
      if (unreachableFor.includes(dn)) {
        const e = new Error("connect ECONNREFUSED 198.51.100.10:636");
        e.code = "ECONNREFUSED";
        throw e;
      }
      if (rejectBindFor.includes(dn)) throw new Error("invalid credentials");
    }
    async search(base, opts) {
      searches.push({ base, opts });
      return { searchEntries: entries };
    }
    async unbind() {}
  }
  return { Fake, binds, searches };
}

const SVC = "CN=svc,OU=Svc,DC=x";
const cfg = {
  url: "ldaps://dc:636",
  baseDN: "DC=x",
  bindDN: SVC,
  bindPassword: "svc-secret",
  timeoutMs: 1000,
};

const PEOPLE = [
  { sAMAccountName: "jdoe", displayName: "Jane Doe", mail: "jane.doe@example.local" },
  { sAMAccountName: "asmith", displayName: "Alan Smith", mail: "alan.smith@example.local" },
];

test("a search binds as the SERVICE account, never as the person being searched for", async () => {
  const dir = fakeDirectory({ entries: PEOPLE });
  await searchUsers("doe", cfg, { ClientCtor: dir.Fake });
  assert.equal(dir.binds.length, 1);
  assert.equal(dir.binds[0].dn, SVC, "the admin's own credential is not available here, and must not be needed");
});

test("results are flattened to what the picker needs", async () => {
  const dir = fakeDirectory({ entries: PEOPLE });
  const out = await searchUsers("doe", cfg, { ClientCtor: dir.Fake });
  assert.deepEqual(out[0], { username: "jdoe", name: "Jane Doe", mail: "jane.doe@example.local" });
  assert.equal(out.length, 2);
});

test("the query is escaped before it reaches the filter", async () => {
  /* A search box is user input going into an LDAP filter. Without escaping,
     `*)(objectClass=*` rewrites the query into one that matches everything. */
  const dir = fakeDirectory({ entries: [] });
  await searchUsers("*)(objectClass=*", cfg, { ClientCtor: dir.Fake });
  const filter = dir.searches[0].opts.filter;
  assert.equal(filter.includes("(objectClass=*)"), false, "the injected clause survived into the filter");
  assert.ok(filter.includes("\\2a"), "an asterisk in the query must be escaped, not passed through");
});

test("it searches the three fields a person would type", async () => {
  const dir = fakeDirectory({ entries: [] });
  await searchUsers("doe", cfg, { ClientCtor: dir.Fake });
  const filter = dir.searches[0].opts.filter;
  for (const field of ["displayName", "mail", "sAMAccountName"]) {
    assert.ok(filter.includes(field), `an admin may search by ${field}`);
  }
});

test("a blank query returns nothing without touching the directory", async () => {
  /* An empty search box would otherwise page the entire directory back on
     every keystroke that cleared the field. */
  const dir = fakeDirectory({ entries: PEOPLE });
  assert.deepEqual(await searchUsers("   ", cfg, { ClientCtor: dir.Fake }), []);
  assert.equal(dir.binds.length, 0, "nothing should have been asked of the directory");
});

test("results are capped, so a two-letter query cannot return the whole company", async () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ sAMAccountName: `u${i}`, displayName: `User ${i}` }));
  const dir = fakeDirectory({ entries: many });
  const out = await searchUsers("u", cfg, { ClientCtor: dir.Fake });
  assert.ok(out.length <= 25, `expected a capped list, got ${out.length}`);
});

test("an entry with no display name still shows something usable", async () => {
  const dir = fakeDirectory({ entries: [{ sAMAccountName: "svc01" }] });
  const [row] = await searchUsers("svc", cfg, { ClientCtor: dir.Fake });
  assert.equal(row.username, "svc01");
  assert.equal(row.name, "svc01", "a blank label in the picker is unpickable");
});

test("searching without a service account configured is refused, not silently empty", async () => {
  /* Search is only possible as the service account. Returning [] would read as
     "no such user" and send an admin looking for a directory problem that is
     really a configuration one. */
  const dir = fakeDirectory({ entries: PEOPLE });
  await assert.rejects(
    () => searchUsers("doe", { ...cfg, bindDN: "", bindPassword: "" }, { ClientCtor: dir.Fake }),
    /service account|bindDN|not configured/i,
  );
});

/*
 * A deliberate departure from DEDB, which resolves every failure to [] and
 * never throws. For a background lookup that is reasonable; for a search box
 * it is not - "no matches" and "the directory is unreachable" demand different
 * actions from the admin, and collapsing them hides an outage behind a result
 * that looks merely disappointing.
 */
test("an unreachable directory is reported as unavailable, not as no matches", async () => {
  const dir = fakeDirectory({ entries: [], unreachableFor: [SVC] });
  await assert.rejects(() => searchUsers("doe", cfg, { ClientCtor: dir.Fake }), (err) => {
    assert.equal(err.status, 503);
    return true;
  });
});

test("a rejected service credential is reported as misconfigured, not as no matches", async () => {
  const dir = fakeDirectory({ entries: [], rejectBindFor: [SVC] });
  await assert.rejects(() => searchUsers("doe", cfg, { ClientCtor: dir.Fake }), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.code, "directory_misconfigured");
    return true;
  });
});
