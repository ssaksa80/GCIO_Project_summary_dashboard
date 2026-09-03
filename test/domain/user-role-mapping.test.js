/*
 * Per-user role grants, and how they fold with directory groups.
 *
 * Ports DEDB's model (auth/authz.js + repos/userRoleMapping.js): a person's
 * role is the HIGHEST of what their groups grant and what an admin granted
 * them directly, and no role at all means no access.
 *
 * The subtle part is the key. A principal reaches sign-in as a bare
 * sAMAccountName, but an admin typing a grant may write DOMAIN\user or
 * user@domain, and both must land on the same row - otherwise the grant looks
 * saved, the person still cannot sign in, and nothing anywhere says why.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { userRoleMappingRepo } from "../../server/repos/userRoleMapping.js";
import { resolveAccess, bestRole } from "../../server/auth/authz.js";

/* A stand-in executor recording the SQL it was given. */
function fakeEx(rows = [], { throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (throwOn) throw throwOn;
      return { recordset: rows };
    },
  };
}

const missingTable = Object.assign(new Error("Invalid object name 'dbo.UserRoleMapping'."), { number: 208 });

test("a grant is keyed by the bare sAMAccountName, whatever form it was typed in", async () => {
  const repo = userRoleMappingRepo(fakeEx([
    { Principal: "jdoe", Role: "admin" },
    { Principal: "EXAMPLE\\asmith", Role: "pm" },
    { Principal: "bjones@example.local", Role: "viewer" },
  ]));
  const map = await repo.getMap();
  assert.equal(map["jdoe"], "admin");
  assert.equal(map["asmith"], "pm", "a grant stored as DOMAIN\\user must match the bare name sign-in resolves");
  assert.equal(map["bjones"], "viewer", "and so must one stored as a UPN");
});

test("the map is lower-cased, because the directory is case-insensitive", async () => {
  const repo = userRoleMappingRepo(fakeEx([{ Principal: "JDoe", Role: "admin" }]));
  assert.equal((await repo.getMap())["jdoe"], "admin");
});

test("a missing table degrades to no grants rather than breaking sign-in", async () => {
  /* getMap sits in the login path. A code-only upgrade runs no migrations, so
     on a host that has not migrated yet the table is absent - and a purely
     additive feature must not take authentication down with it. */
  const repo = userRoleMappingRepo(fakeEx([], { throwOn: missingTable }));
  assert.deepEqual(await repo.getMap(), {});
});

test("but LISTING a missing table reports it, rather than showing no grants", async () => {
  /* The opposite call, and the opposite answer. list() is asked by an
     administrator, where "there are no grants" and "the table does not exist"
     are different facts and only one of them has a fix. Conflating them is how
     someone concludes the tool works and their grants disappeared - which is
     exactly what the CLI printed against a real host at migration 11. */
  const repo = userRoleMappingRepo(fakeEx([], { throwOn: missingTable }));
  await assert.rejects(() => repo.list(), /invalid object name/i);
});

test("any other database error is surfaced, not swallowed", async () => {
  /* The tolerance above is narrow on purpose. Swallowing everything would turn
     a broken database into "nobody has any grants", which reads as a
     permissions mystery instead of an outage. */
  const boom = Object.assign(new Error("deadlock victim"), { number: 1205 });
  await assert.rejects(() => userRoleMappingRepo(fakeEx([], { throwOn: boom })).getMap(), /deadlock/);
});

test("setting a grant stores the bare name and records who granted it", async () => {
  const ex = fakeEx();
  await userRoleMappingRepo(ex).set("EXAMPLE\\jdoe", "admin", "asmith");
  const { params } = ex.calls[0];
  const byName = Object.fromEntries(params.map((x) => [x.name, x.value]));
  assert.equal(byName.p, "jdoe", "stored qualified, this row would never match a sign-in");
  assert.equal(byName.r, "admin");
  assert.equal(byName.by, "asmith", "who granted a role is asked about months later");
});

test("a role the application does not know is refused before it reaches the database", async () => {
  /* The table has a CHECK, but a constraint violation surfaces as a 500. This
     is the same validation one layer earlier, where it can say what was wrong. */
  const ex = fakeEx();
  await assert.rejects(() => userRoleMappingRepo(ex).set("jdoe", "superuser", "asmith"), /superuser|role/i);
  assert.equal(ex.calls.length, 0, "nothing should have been written");
});

/* ---- folding the two sources, which is where the behaviour lives ---------- */

const deps = (groupMap, userMap) => ({
  roleMapping: { getMap: async () => groupMap },
  userRoleMapping: { getMap: async () => userMap },
});

test("a direct grant gives access to someone in no mapped group at all", async () => {
  /* The whole point of the feature: an admin can grant a role without asking
     the directory team to create or populate a group. */
  const { role } = await resolveAccess({ principal: "jdoe", groups: [] }, deps({}, { jdoe: "pm" }));
  assert.equal(role, "pm");
});

test("the higher of the group role and the direct grant wins", async () => {
  const withDeps = deps({ "gcio-viewers": "viewer" }, { jdoe: "admin" });
  const { role } = await resolveAccess({ principal: "jdoe", groups: ["GCIO-Viewers"] }, withDeps);
  assert.equal(role, "admin", "a direct grant must be able to raise someone above their group");
});

test("a lower direct grant does not demote someone their group already promoted", async () => {
  /* bestRole takes the highest, so a stale viewer grant cannot quietly strip an
     admin of access. Revoking is done by removing the grant, not by lowering
     it - and the group is the other source, which this must not override. */
  const withDeps = deps({ "gcio-admins": "admin" }, { jdoe: "viewer" });
  const { role } = await resolveAccess({ principal: "jdoe", groups: ["GCIO-Admins"] }, withDeps);
  assert.equal(role, "admin");
});

test("no group role and no grant is refused, exactly as DEDB refuses it", async () => {
  await assert.rejects(
    () => resolveAccess({ principal: "jdoe", groups: ["Domain Users"] }, deps({}, {})),
    (err) => {
      assert.equal(err.status, 403);
      assert.equal(err.code, "no_access");
      return true;
    },
    "authenticating is not authorisation; an unmapped group must never imply a default role",
  );
});

test("the grant is matched case-insensitively against the signed-in principal", async () => {
  const { role } = await resolveAccess({ principal: "JDoe", groups: [] }, deps({}, { jdoe: "admin" }));
  assert.equal(role, "admin");
});

test("resolveAccess still works when no per-user source is wired at all", async () => {
  /* Keeps every existing caller and test that passes only roleMapping working,
     rather than making the new dependency mandatory everywhere at once. */
  const { role } = await resolveAccess(
    { principal: "jdoe", groups: ["GCIO-Admins"] },
    { roleMapping: { getMap: async () => ({ "gcio-admins": "admin" }) } },
  );
  assert.equal(role, "admin");
});

test("bestRole already ranks the three roles this app has", () => {
  assert.equal(bestRole("viewer", "admin"), "admin");
  assert.equal(bestRole("viewer", "pm"), "pm");
  assert.equal(bestRole(null, undefined), null);
});
