/*
 * The rest of the admin console's API: Health, Ownership, Settings,
 * Connection, Database, Logs and Security.
 *
 * Ports DEDB's admin routes. The cases pinned here are the ones where getting
 * it wrong is silent - a grant that matches nobody, a setting that saves but
 * does not apply while the screen implies it did, a probe failure rendered as
 * the screen being broken.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { makeTestDeps, asRole, jsonBody } from "./helpers.mjs";

/* ---- everything here is admin-only -------------------------------------- */

test("every admin screen refuses a non-admin", async (t) => {
  const { app } = await makeTestDeps(t);
  const urls = [
    "/api/admin/health", "/api/admin/ownership", "/api/admin/settings",
    "/api/admin/connection", "/api/admin/database", "/api/admin/logs", "/api/admin/security",
  ];
  for (const url of urls) {
    assert.equal((await asRole(app, "pm").get(url)).status, 403, `${url} must be admin-only`);
    assert.equal((await asRole(app, "admin").get(url)).status, 200, `${url} must answer an admin`);
  }
});

/* ---- health -------------------------------------------------------------- */

test("health reports the pieces an operator would otherwise read a log for", async (t) => {
  const { app } = await makeTestDeps(t);
  const h = jsonBody(await asRole(app, "admin").get("/api/admin/health"));
  assert.ok(h.version, "the running version");
  assert.equal(typeof h.uptimeSec, "number");
  assert.ok(h.database, "database state");
  assert.ok(h.directory, "directory state");
  assert.ok(h.migrations, "migration state");
});

test("a database probe that throws does not take the health page down with it", async (t) => {
  /* The page matters most precisely when something is broken, so one failing
     probe must degrade to a reported failure, not a 500. */
  const { app } = await makeTestDeps(t, {
    adminProbes: { async database() { throw new Error("connection refused"); } },
  });
  const res = await asRole(app, "admin").get("/api/admin/health");
  assert.equal(res.status, 200);
  const h = jsonBody(res);
  assert.equal(h.database.up, false);
  assert.match(h.database.detail, /refused/);
});

/* ---- ownership ----------------------------------------------------------- */

test("an owner can be granted a section", async (t) => {
  const { app, ownership } = await makeTestDeps(t);
  const res = await asRole(app, "admin", "asmith")
    .post("/api/admin/ownership", { principalType: "user", principalName: "jdoe", sectionKey: "posture" });
  assert.equal(res.status, 200);
  const rows = await ownership.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].SectionKey, "posture");
  assert.equal(rows[0].GrantedBy, "asmith", "who granted it is what gets asked later");
});

test("a section key the client does not render is refused", async (t) => {
  /* The resolver matches verbatim and never reports a miss, so a bad key would
     become a grant that owns nothing and says nothing. */
  const { app, ownership } = await makeTestDeps(t);
  const res = await asRole(app, "admin")
    .post("/api/admin/ownership", { principalType: "user", principalName: "jdoe", sectionKey: "budget" });
  assert.equal(res.status, 422);
  assert.match(jsonBody(res).error.message, /successes|posture/, "the message must name the valid keys");
  assert.equal((await ownership.list()).length, 0);
});

test("a non-string principal is refused rather than coerced", async (t) => {
  /* String(12345) passes a non-empty check and persists as a junk grant. */
  const { app, ownership } = await makeTestDeps(t);
  const res = await asRole(app, "admin")
    .post("/api/admin/ownership", { principalType: "user", principalName: 12345, sectionKey: "posture" });
  assert.equal(res.status, 422);
  assert.equal((await ownership.list()).length, 0);
});

test("an over-length principal is refused rather than silently truncated", async (t) => {
  /* The column is NVARCHAR(200) and the driver checks type, not length, so an
     over-long value would be truncated on assignment into a name matching
     nobody - a pasted DN instead of a CN is the realistic way in. */
  const { app } = await makeTestDeps(t);
  const res = await asRole(app, "admin").post("/api/admin/ownership",
    { principalType: "user", principalName: "x".repeat(201), sectionKey: "posture" });
  assert.equal(res.status, 422);
});

test("an owner can be revoked", async (t) => {
  const { app, ownership } = await makeTestDeps(t);
  const { id } = jsonBody(await asRole(app, "admin")
    .post("/api/admin/ownership", { principalType: "group", principalName: "GCIO-Security", sectionKey: "posture" }));
  assert.equal((await asRole(app, "admin").delete(`/api/admin/ownership/${id}`)).status, 200);
  assert.equal((await ownership.list()).length, 0);
});

/* ---- settings ------------------------------------------------------------ */

test("settings are described with their current values", async (t) => {
  const { app } = await makeTestDeps(t);
  const rows = jsonBody(await asRole(app, "admin").get("/api/admin/settings"));
  assert.ok(Array.isArray(rows) && rows.length, "the known settings are listed");
  assert.ok(rows.every((r) => "key" in r && "live" in r), "each says whether it applies without a restart");
});

test("saving reports which settings actually took effect", async (t) => {
  /* The honest distinction, and the whole reason DEDB returns it: a screen that
     implies a restart-only setting applied immediately is lying to an operator
     who will then wonder why nothing changed. */
  const { app, settings } = await makeTestDeps(t);
  const res = await asRole(app, "admin")
    .put("/api/admin/settings", { sessionIdleMinutes: "45", sessionAbsoluteHours: "12" });
  assert.equal(res.status, 200);
  const body = jsonBody(res);
  assert.deepEqual(body.appliedLive, ["sessionIdleMinutes"], "only the live one");
  assert.deepEqual(body.needsRestart, ["sessionAbsoluteHours"], "and the other is named as needing a restart");
  assert.equal((await settings.getMap()).sessionIdleMinutes, "45", "both are still persisted");
  assert.equal((await settings.getMap()).sessionAbsoluteHours, "12");
});

test("a setting this build does not know is still stored, not dropped", async (t) => {
  /* An older build reading a newer database must not delete a value it does not
     recognise the moment someone saves. */
  const { app, settings } = await makeTestDeps(t);
  await asRole(app, "admin").put("/api/admin/settings", { somethingNewer: "keep me" });
  assert.equal((await settings.getMap()).somethingNewer, "keep me");
  const rows = jsonBody(await asRole(app, "admin").get("/api/admin/settings"));
  assert.ok(rows.some((r) => r.key === "somethingNewer" && r.unknown), "and it is shown, marked unknown");
});

/* ---- connection ---------------------------------------------------------- */

test("connection is honest that it cannot be edited here", async (t) => {
  const { app } = await makeTestDeps(t);
  const c = jsonBody(await asRole(app, "admin").get("/api/admin/connection"));
  assert.equal(c.editable, false);
  assert.match(c.why, /\.env|freezes/, "and says why, so the screen is not just disabled");
});

test("connection never returns a password, only whether one is set", async (t) => {
  const { app } = await makeTestDeps(t);
  const c = jsonBody(await asRole(app, "admin").get("/api/admin/connection"));
  const flat = JSON.stringify(c);
  assert.equal(/"password"\s*:/.test(flat), false, "no password field at all");
  assert.equal("passwordSet" in c.database, true, "only the boolean");
  assert.equal("bindPasswordSet" in c.directory, true);
});

test("a failing directory test is a result, not a server error", async (t) => {
  /* The probe ran and produced an answer. Returning 5xx would make the screen
     look broken when it is doing exactly its job. */
  const { app } = await makeTestDeps(t, {
    adminProbes: {
      async directory() { const e = new Error("connect ECONNREFUSED"); e.code = "directory_unavailable"; throw e; },
    },
  });
  const res = await asRole(app, "admin").post("/api/admin/connection/test-directory", {});
  assert.equal(res.status, 200);
  assert.equal(jsonBody(res).ok, false);
  assert.match(jsonBody(res).message, /ECONNREFUSED/);
});

/* ---- security ------------------------------------------------------------ */

test("security counts every route to admin, because zero locks everyone out", async (t) => {
  const { app } = await makeTestDeps(t, { grants: { jdoe: "admin" } });
  const s = jsonBody(await asRole(app, "admin").get("/api/admin/security"));
  assert.ok(s.authorisation.adminGroups.includes("gcio-admins"), "the group route");
  assert.ok(s.authorisation.adminGrants.includes("jdoe"), "and the direct grant");
  assert.equal(s.authorisation.adminRoutesTotal, 2);
  assert.equal(s.authorisation.refusesWithoutRole, true);
});

test("security never leaks a secret, only whether it is sealed", async (t) => {
  const { app } = await makeTestDeps(t);
  const flat = JSON.stringify(jsonBody(await asRole(app, "admin").get("/api/admin/security")));
  assert.equal(/password"\s*:\s*"/.test(flat), false, "no password value anywhere");
  assert.match(flat, /bindPasswordSealed/, "only the sealed flag");
});
