/*
 * The admin console's API: list, grant and revoke per-user roles, and search
 * the directory for someone to grant to.
 *
 * Ports DEDB's routes/admin.js user-roles endpoints. Everything here is
 * admin-only, and every change records who made it.
 *
 * The cases that matter are the ones where a mistake is silent: granting to a
 * name nobody validated, granting a role the app does not know, and an admin
 * removing their own last route back in.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../../server/app.js";
import { makeTestDeps, asRole, jsonBody } from "./helpers.mjs";

test("listing grants is admin-only", async (t) => {
  const { app } = await makeTestDeps(t);
  for (const role of ["viewer", "pm"]) {
    const res = await asRole(app, role).get("/api/admin/user-roles");
    assert.equal(res.status, 403, `${role} must not read who has what role`);
  }
  assert.equal((await asRole(app, "admin").get("/api/admin/user-roles")).status, 200);
});

test("an admin grants a role, and the grant records who made it", async (t) => {
  const { app, userRoleMapping } = await makeTestDeps(t);
  const res = await asRole(app, "admin", "asmith")
    .post("/api/admin/user-roles", { principal: "jdoe", role: "pm" });
  assert.equal(res.status, 200);
  const rows = await userRoleMapping.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Principal, "jdoe");
  assert.equal(rows[0].Role, "pm");
  assert.equal(rows[0].GrantedBy, "asmith", "who granted a role is what gets asked about later");
});

test("a role the application does not know is refused with 422, not stored", async (t) => {
  const { app, userRoleMapping } = await makeTestDeps(t);
  const res = await asRole(app, "admin").post("/api/admin/user-roles", { principal: "jdoe", role: "superuser" });
  assert.equal(res.status, 422);
  assert.match(jsonBody(res).error.message, /admin|pm|viewer/, "the message must say what the valid roles are");
  assert.equal((await userRoleMapping.list()).length, 0);
});

test("a missing principal is refused", async (t) => {
  const { app } = await makeTestDeps(t);
  assert.equal((await asRole(app, "admin").post("/api/admin/user-roles", { role: "pm" })).status, 422);
  assert.equal((await asRole(app, "admin").post("/api/admin/user-roles", { principal: "  ", role: "pm" })).status, 422);
});

test("granting twice updates the row rather than failing or duplicating", async (t) => {
  const { app, userRoleMapping } = await makeTestDeps(t);
  await asRole(app, "admin").post("/api/admin/user-roles", { principal: "jdoe", role: "viewer" });
  await asRole(app, "admin").post("/api/admin/user-roles", { principal: "jdoe", role: "admin" });
  const rows = await userRoleMapping.list();
  assert.equal(rows.length, 1, "a second grant for the same person must not create a second row");
  assert.equal(rows[0].Role, "admin");
});

test("a grant is stored against the bare account name however it was typed", async (t) => {
  /* Sign-in resolves a bare sAMAccountName. A grant stored as EXAMPLE\\jdoe
     would never match it - the console would show the grant, and the person
     would still be refused. */
  const { app, userRoleMapping } = await makeTestDeps(t);
  await asRole(app, "admin").post("/api/admin/user-roles", { principal: "EXAMPLE\\jdoe", role: "pm" });
  assert.equal((await userRoleMapping.list())[0].Principal, "jdoe");
});

test("revoking removes the grant", async (t) => {
  const { app, userRoleMapping } = await makeTestDeps(t);
  await asRole(app, "admin").post("/api/admin/user-roles", { principal: "jdoe", role: "pm" });
  const res = await asRole(app, "admin").delete("/api/admin/user-roles/jdoe");
  assert.equal(res.status, 200);
  assert.equal((await userRoleMapping.list()).length, 0);
});

test("revoking is admin-only", async (t) => {
  const { app, userRoleMapping } = await makeTestDeps(t);
  await asRole(app, "admin").post("/api/admin/user-roles", { principal: "jdoe", role: "pm" });
  assert.equal((await asRole(app, "pm").delete("/api/admin/user-roles/jdoe")).status, 403);
  assert.equal((await userRoleMapping.list()).length, 1, "the grant must still be there");
});

/*
 * The lockout case. An admin whose access comes ONLY from a direct grant can
 * revoke it from themselves and lose the console with it - and with no other
 * admin, nobody can put it back without database access or the AD group.
 * Refusing costs nothing; the recovery costs a maintenance window.
 */
test("an admin cannot revoke their own last remaining admin grant", async (t) => {
  const { app, userRoleMapping } = await makeTestDeps(t);
  await asRole(app, "admin").post("/api/admin/user-roles", { principal: "asmith", role: "admin" });
  const res = await asRole(app, "admin", "asmith").delete("/api/admin/user-roles/asmith");
  assert.equal(res.status, 409);
  assert.match(jsonBody(res).error.message, /last|yourself|lock/i);
  assert.equal((await userRoleMapping.list()).length, 1, "the grant must survive the refusal");
});

test("an admin may revoke their own grant when another admin grant remains", async (t) => {
  const { app, userRoleMapping } = await makeTestDeps(t);
  await asRole(app, "admin").post("/api/admin/user-roles", { principal: "asmith", role: "admin" });
  await asRole(app, "admin").post("/api/admin/user-roles", { principal: "bjones", role: "admin" });
  assert.equal((await asRole(app, "admin", "asmith").delete("/api/admin/user-roles/asmith")).status, 200);
  assert.equal((await userRoleMapping.list()).length, 1);
});

test("an admin may lower their own role only while another admin remains", async (t) => {
  /* Same hazard by a different route: demoting yourself is revoking your admin
     access, and bestRole means the grant no longer carries it. */
  const { app } = await makeTestDeps(t);
  await asRole(app, "admin").post("/api/admin/user-roles", { principal: "asmith", role: "admin" });
  const res = await asRole(app, "admin", "asmith").post("/api/admin/user-roles", { principal: "asmith", role: "viewer" });
  assert.equal(res.status, 409, "this leaves nobody able to grant it back");
});

/* ---- the directory picker ------------------------------------------------ */

test("directory search is admin-only", async (t) => {
  const { app } = await makeTestDeps(t);
  assert.equal((await asRole(app, "pm").get("/api/admin/directory?q=doe")).status, 403);
});

test("directory search returns matches for the picker", async (t) => {
  const { app } = await makeTestDeps(t, {
    searchUsers: async () => [{ username: "jdoe", name: "Jane Doe", mail: "jane.doe@example.local" }],
  });
  const res = await asRole(app, "admin").get("/api/admin/directory?q=doe");
  assert.equal(res.status, 200);
  assert.deepEqual(jsonBody(res), [{ username: "jdoe", name: "Jane Doe", mail: "jane.doe@example.local" }]);
});

test("an empty query returns an empty list rather than an error", async (t) => {
  const { app } = await makeTestDeps(t, { searchUsers: async () => [] });
  const res = await asRole(app, "admin").get("/api/admin/directory?q=");
  assert.equal(res.status, 200);
  assert.deepEqual(jsonBody(res), []);
});

test("a directory outage surfaces as 503, not as an empty result", async (t) => {
  /* "No matches" and "the directory is down" require different actions from
     the admin. Collapsing them hides an outage behind a disappointing result. */
  const { app } = await makeTestDeps(t, {
    searchUsers: async () => {
      const e = new Error("connect ECONNREFUSED");
      e.status = 503; e.code = "directory_unavailable";
      throw e;
    },
  });
  const res = await asRole(app, "admin").get("/api/admin/directory?q=doe");
  assert.equal(res.status, 503);
  assert.equal(jsonBody(res).error.code, "directory_unavailable");
});
