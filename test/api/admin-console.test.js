/*
 * The rest of the admin console's API: group->role mappings, and live sessions.
 *
 * Mirrors what DEDB's admin app reads on its Roles and Sessions screens. The
 * per-user grants and the directory picker are covered in
 * admin-user-roles.test.js; this file is the other half.
 *
 * The cases worth pinning are the ones where a mistake locks somebody out or
 * quietly does nothing: removing the mapping that grants your own admin, and
 * revoking a session that is not yours.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { makeTestDeps, asRole, jsonBody } from "./helpers.mjs";

/* ---- group -> role mappings ---------------------------------------------- */

test("listing group mappings is admin-only", async (t) => {
  const { app } = await makeTestDeps(t);
  assert.equal((await asRole(app, "pm").get("/api/admin/roles")).status, 403);
  assert.equal((await asRole(app, "admin").get("/api/admin/roles")).status, 200);
});

test("the mappings that decide everyone's access are listed", async (t) => {
  const { app } = await makeTestDeps(t);
  const rows = jsonBody(await asRole(app, "admin").get("/api/admin/roles"));
  assert.ok(Array.isArray(rows));
  assert.ok(rows.some((r) => String(r.groupName).toLowerCase() === "gcio-admins"),
    "the harness maps gcio-admins to admin, so it must appear");
});

test("an admin can map a directory group to a role", async (t) => {
  const { app, roleMapping } = await makeTestDeps(t);
  const res = await asRole(app, "admin").post("/api/admin/roles", { groupName: "GCIO-Readers", role: "viewer" });
  assert.equal(res.status, 200);
  assert.equal((await roleMapping.getMap())["gcio-readers"], "viewer");
});

test("a role the application does not know is refused, and nothing is written", async (t) => {
  const { app, roleMapping } = await makeTestDeps(t);
  const before = Object.keys(await roleMapping.getMap()).length;
  const res = await asRole(app, "admin").post("/api/admin/roles", { groupName: "GCIO-Readers", role: "superuser" });
  assert.equal(res.status, 422);
  assert.match(jsonBody(res).error.message, /admin|pm|viewer/);
  assert.equal(Object.keys(await roleMapping.getMap()).length, before);
});

test("a blank group name is refused", async (t) => {
  const { app } = await makeTestDeps(t);
  assert.equal((await asRole(app, "admin").post("/api/admin/roles", { groupName: "  ", role: "viewer" })).status, 422);
});

test("an admin can remove a mapping", async (t) => {
  const { app, roleMapping } = await makeTestDeps(t);
  await asRole(app, "admin").post("/api/admin/roles", { groupName: "GCIO-Readers", role: "viewer" });
  assert.equal((await asRole(app, "admin").delete("/api/admin/roles/GCIO-Readers")).status, 200);
  assert.equal((await roleMapping.getMap())["gcio-readers"], undefined);
});

/*
 * The lockout that the per-user guard does not cover. Someone whose admin comes
 * from a GROUP can delete that group's mapping and lose the console, with no
 * direct grant to fall back on. Refusing costs nothing; recovering needs the
 * break-glass CLI or a database edit.
 */
test("an admin cannot remove the group mapping that is their own only route to admin", async (t) => {
  const { app, roleMapping } = await makeTestDeps(t);
  const res = await asRole(app, "admin").delete("/api/admin/roles/gcio-admins");
  assert.equal(res.status, 409);
  assert.match(jsonBody(res).error.message, /own|last|lock/i);
  assert.equal((await roleMapping.getMap())["gcio-admins"], "admin", "the mapping must survive the refusal");
});

test("but may remove it when a direct grant keeps them admin", async (t) => {
  /* With a per-user grant in place the group mapping is no longer their only
     route, so removing it cannot lock them out. */
  const { app, roleMapping } = await makeTestDeps(t, { grants: { tester: "admin" } });
  assert.equal((await asRole(app, "admin").delete("/api/admin/roles/gcio-admins")).status, 200);
  assert.equal((await roleMapping.getMap())["gcio-admins"], undefined);
});

/* ---- live sessions -------------------------------------------------------- */

test("listing sessions is admin-only", async (t) => {
  const { app } = await makeTestDeps(t);
  assert.equal((await asRole(app, "pm").get("/api/admin/sessions")).status, 403);
  assert.equal((await asRole(app, "admin").get("/api/admin/sessions")).status, 200);
});

test("a signed-in person appears in the session list", async (t) => {
  const { app } = await makeTestDeps(t);
  const rows = jsonBody(await asRole(app, "admin", "asmith").get("/api/admin/sessions"));
  assert.ok(rows.some((s) => String(s.principal).includes("asmith")), "the caller's own session must be listed");
});

test("the list never exposes a session id that would let one be stolen", async (t) => {
  /* A session id is a bearer token. Listing them to an admin screen would put
     every live credential in a response, a log and a browser cache. */
  const { app } = await makeTestDeps(t);
  const rows = jsonBody(await asRole(app, "admin").get("/api/admin/sessions"));
  for (const s of rows) {
    assert.equal("sessionId" in s, false, "a raw session id must never leave the server");
    assert.equal("id" in s && /^[0-9a-f-]{36}$/i.test(String(s.id)), false);
  }
});

test("an admin can revoke everyone's sessions for a principal", async (t) => {
  const { app, sessions } = await makeTestDeps(t);
  await asRole(app, "pm", "bjones").get("/api/summary");
  const res = await asRole(app, "admin").delete("/api/admin/sessions/bjones");
  assert.equal(res.status, 200);
  assert.equal((await sessions.list()).some((s) => String(s.principal).includes("bjones")), false);
});

test("revoking is admin-only", async (t) => {
  const { app } = await makeTestDeps(t);
  assert.equal((await asRole(app, "pm").delete("/api/admin/sessions/bjones")).status, 403);
});
