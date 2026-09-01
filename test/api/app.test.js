/**
 * The real application, driven in-process with a fake directory and fake
 * session storage. This is the test that would have caught shipping the
 * dashboard with every route open.
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { Store } from "../../server/store.js";
import { ingestDirectory } from "../../server/ingest.js";
import { memorySessions, memoryRoleMapping, devAuthenticate } from "../../server/devBackends.js";

const config = loadConfig({ NODE_ENV: "test", STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" });

/* The upload route writes accepted workbooks into dataDir. Pointing that at
   the real data/ folder made the suite drop a workbook into the running
   dashboard's watched directory, which then left demo mode. Every app under
   test gets its own throwaway directory instead. */
const scratchDirs = [];
function scratchDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcio-test-data-"));
  scratchDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeApp({ role = "admin", audited = [] } = {}) {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  const app = createApp({
    store,
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ [`gcio-dashboard-${role}s`]: role }),
    audit: { append: async (e) => { audited.push(e); }, recent: async () => [] },
    ldapAuthenticate: devAuthenticate(role),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
  return { app, store, audited };
}

/** Sign in and return an agent carrying the session cookie. */
async function signedIn(app, username = "tester") {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: "anything" });
  assert.equal(res.status, 200, `sign-in failed: ${JSON.stringify(res.body)}`);
  return agent;
}

test("health and readiness need no session, so monitoring keeps working", async () => {
  const { app } = makeApp();
  const anon = request(app);
  assert.equal((await anon.get("/healthz")).status, 200);
  assert.equal((await anon.get("/readyz")).status, 200);
});

test("every portfolio route refuses an anonymous caller", async () => {
  const { app } = makeApp();
  const anon = request(app);
  for (const url of [
    "/api/summary?period=weekly",
    "/api/projects",
    "/api/meta",
    "/api/health",
    "/api/template",
  ]) {
    const res = await anon.get(url);
    assert.equal(res.status, 401, `${url} answered ${res.status} without a session`);
    assert.equal(res.body.error.code, "no_session");
  }
});

test("an anonymous caller cannot export or upload", async () => {
  const { app } = makeApp();
  const anon = request(app);
  assert.equal((await anon.post("/api/export/pptx").send({ period: "weekly" })).status, 401);
  assert.equal((await anon.post("/api/ingest/upload")).status, 401);
});

test("me reports signed out, then signed in with the resolved role", async () => {
  const { app } = makeApp({ role: "pm" });
  const agent = request.agent(app);

  assert.equal((await agent.get("/api/me")).body.authenticated, false);

  await agent.post("/api/auth/login").send({ username: "pat", password: "x" });
  const me = await agent.get("/api/me");
  assert.equal(me.body.authenticated, true);
  assert.equal(me.body.role, "pm");
});

test("a signed-in viewer reads the portfolio and the six sections", async () => {
  const { app } = makeApp({ role: "viewer" });
  const agent = await signedIn(app);

  const summary = await agent.get("/api/summary?period=weekly&date=2026-08-24");
  assert.equal(summary.status, 200);
  /* The six sections the CIO asked for, in order. Not an exact key list:
     annotateChanges also records historyAvailable here, and pinning the whole
     shape means every future addition breaks a test about section order. */
  const sectionKeys = Object.keys(summary.body.sections);
  assert.deepEqual(sectionKeys.filter((k) => k !== "historyAvailable"),
    ["successes", "qri", "priorities", "roadmap", "posture", "documents"]);
  assert.equal(typeof summary.body.sections.historyAvailable, "boolean",
    "the summary must always say whether history was available");
  /* This app is built with no document store wired, which is what a
     deployment that never imported one looks like: the section is present and
     says so, rather than being missing or throwing. */
  assert.equal(summary.body.sections.documents.available, false);

  const projects = await agent.get("/api/projects");
  assert.equal(projects.status, 200);
  assert.ok(projects.body.count > 0);
});

test("a viewer may export but may not upload", async () => {
  const { app } = makeApp({ role: "viewer" });
  const agent = await signedIn(app);

  const exported = await agent.post("/api/export/pptx").send({ period: "weekly", date: "2026-08-24" });
  assert.equal(exported.status, 200);
  assert.match(exported.headers["content-type"], /presentationml/);

  const upload = await agent.post("/api/ingest/upload");
  assert.equal(upload.status, 403);
  assert.equal(upload.body.error.code, "forbidden");
});

test("a pm may upload a real workbook", async () => {
  const { app } = makeApp({ role: "pm" });
  const agent = await signedIn(app);
  const res = await agent.post("/api/ingest/upload")
    .attach("files", "sample-data/GCIO_Portfolio_Master.xlsx");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test("an upload that is not a workbook is refused with a readable reason", async () => {
  const { app } = makeApp({ role: "pm" });
  const agent = await signedIn(app);
  const res = await agent.post("/api/ingest/upload")
    .attach("files", Buffer.from("PK-not-really"), "evil.xlsx");

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.errors[0].error, /not a real \.xlsx/i);
});

test("exports and uploads are audited with the actor and what left the building", async () => {
  const audited = [];
  const { app } = makeApp({ role: "pm", audited });
  const agent = await signedIn(app, "pat");

  await agent.post("/api/export/xlsx").send({ period: "weekly", date: "2026-08-24" });

  const actions = audited.map((a) => a.action);
  assert.ok(actions.includes("signin"), `expected a signin event, got ${actions.join(", ")}`);

  const exported = audited.find((a) => a.action === "export");
  assert.ok(exported, "the export was not audited");
  assert.match(exported.actor, /pat/);
  assert.match(exported.subject, /xlsx weekly/);
});

test("signing out ends the session", async () => {
  const { app } = makeApp();
  const agent = await signedIn(app);
  assert.equal((await agent.get("/api/summary?period=weekly")).status, 200);

  await agent.post("/api/auth/logout").send({});
  assert.equal((await agent.get("/api/summary?period=weekly")).status, 401);
});

/** Like makeApp, but with a caller-supplied audit backend. */
function makeAppWith({ role, auditBackend, ingestRuns = null }) {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  return createApp({
    store,
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ [`gcio-dashboard-${role}s`]: role }),
    audit: auditBackend,
    ingestRuns,
    ldapAuthenticate: devAuthenticate(role),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
}

test("only an admin may read the audit trail", async () => {
  const events = [{ at: "2026-08-24T09:00:00.000Z", actor: "a@x", action: "export", subject: "pptx weekly" }];
  const auditBackend = { append: async () => {}, recent: async () => events };

  const pm = await signedIn(makeAppWith({ role: "pm", auditBackend }));
  const refused = await pm.get("/api/audit");
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "forbidden");

  const admin = await signedIn(makeAppWith({ role: "admin", auditBackend }));
  const res = await admin.get("/api/audit");
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.events[0].action, "export");
});

test("an anonymous caller cannot read the audit trail", async () => {
  const auditBackend = { append: async () => {}, recent: async () => [{ actor: "secret@x" }] };
  const res = await request(makeAppWith({ role: "admin", auditBackend })).get("/api/audit");
  assert.equal(res.status, 401);
});

test("the audit query is bounded and the filter is passed through", async () => {
  let asked = null;
  const auditBackend = { append: async () => {}, recent: async (opts) => { asked = opts; return []; } };
  const admin = await signedIn(makeAppWith({ role: "admin", auditBackend }));

  await admin.get("/api/audit?limit=999999&action=export");
  assert.equal(asked.limit, 1000, "an unbounded limit was accepted");
  assert.equal(asked.action, "export");

  await admin.get("/api/audit?limit=-5");
  assert.equal(asked.limit, 1, "a negative limit was accepted");
  assert.equal(asked.action, null);
});

test("reading the audit trail is itself audited", async () => {
  const written = [];
  const auditBackend = { append: async (e) => { written.push(e); }, recent: async () => [] };
  const admin = await signedIn(makeAppWith({ role: "admin", auditBackend }));

  await admin.get("/api/audit");
  assert.ok(written.some((e) => e.action === "audit.read"), "who read the audit log was not recorded");
});

/* ------------------------------------------------------- ingest run history */

test("an admin can see recent ingest runs, and a pm cannot", async () => {
  const runs = [{
    id: 1, fileName: "master.xlsx", trigger: "watcher",
    startedAt: "2026-08-25T09:00:00.000Z", finishedAt: "2026-08-25T09:00:02.000Z",
    outcome: "applied", projectsSeen: 34, projectsChanged: 3, postureRows: 10, error: null,
  }];
  const ingestRuns = { recent: async () => runs };

  const pmApp = makeAppWith({ role: "pm", auditBackend: { append: async () => {}, recent: async () => [] } });
  const pm = await signedIn(pmApp);
  assert.equal((await pm.get("/api/ingest/runs")).status, 403);

  const adminApp = makeAppWith({
    role: "admin",
    auditBackend: { append: async () => {}, recent: async () => [] },
    ingestRuns,
  });
  const admin = await signedIn(adminApp);
  const res = await admin.get("/api/ingest/runs");
  assert.equal(res.status, 200);
  assert.equal(res.body.runs[0].outcome, "applied");
  assert.equal(res.body.runs[0].projectsChanged, 3);
});

test("ingest runs report cleanly when the store keeps no history", async () => {
  const adminApp = makeAppWith({ role: "admin", auditBackend: { append: async () => {}, recent: async () => [] } });
  const admin = await signedIn(adminApp);
  const res = await admin.get("/api/ingest/runs");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.runs, []);
  assert.equal(res.body.historyEnabled, false);
});

test("a history-backed store with no runs yet is enabled, not disabled", async () => {
  /* historyEnabled says whether there is a database behind this, not whether
     it happens to be empty. Collapsing the two would make a fresh install look
     like an in-memory one. */
  const adminApp = makeAppWith({
    role: "admin",
    auditBackend: { append: async () => {}, recent: async () => [] },
    ingestRuns: { recent: async () => [] },
  });
  const admin = await signedIn(adminApp);
  const res = await admin.get("/api/ingest/runs");
  assert.equal(res.status, 200);
  assert.equal(res.body.historyEnabled, true);
  assert.deepEqual(res.body.runs, []);
});

test("an anonymous caller cannot read ingest runs", async () => {
  const ingestRuns = { recent: async () => [] };
  const adminApp = makeAppWith({
    role: "admin",
    auditBackend: { append: async () => {}, recent: async () => [] },
    ingestRuns,
  });
  const res = await request(adminApp).get("/api/ingest/runs");
  assert.equal(res.status, 401, "an unauthenticated caller must be refused before the role check runs");
  assert.equal(res.body.error.code, "no_session");
});

test("a viewer may not read ingest runs", async () => {
  const ingestRuns = { recent: async () => [] };
  const viewerApp = makeAppWith({
    role: "viewer",
    auditBackend: { append: async () => {}, recent: async () => [] },
    ingestRuns,
  });
  const viewer = await signedIn(viewerApp);
  const res = await viewer.get("/api/ingest/runs");
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "forbidden");
});

test("the ingest runs limit is passed through and clamped", async () => {
  let asked = null;
  const ingestRuns = { recent: async (opts) => { asked = opts; return []; } };
  const admin = await signedIn(makeAppWith({
    role: "admin",
    auditBackend: { append: async () => {}, recent: async () => [] },
    ingestRuns,
  }));

  await admin.get("/api/ingest/runs?limit=25");
  assert.equal(asked.limit, 25);

  await admin.get("/api/ingest/runs?limit=999999");
  assert.equal(asked.limit, 500, "an unbounded limit was accepted");

  await admin.get("/api/ingest/runs?limit=-5");
  assert.equal(asked.limit, 1, "a negative limit was accepted");

  await admin.get("/api/ingest/runs?limit=not-a-number");
  assert.equal(asked.limit, 50, "a non-numeric limit was not defaulted");

  await admin.get("/api/ingest/runs?limit=5&limit=10");
  assert.equal(asked.limit, 50,
    "a duplicated limit parameter arrives as an array, and Number([...]) is NaN -- must fall back to the default, not crash or pick one");
});

test("an open run with no outcome or finish time still serialises", async () => {
  const runs = [{
    id: 7, fileName: "master.xlsx", trigger: "watcher",
    startedAt: "2026-08-25T09:00:00.000Z", finishedAt: null,
    outcome: null, projectsSeen: 0, projectsChanged: 0, postureRows: 0, error: null,
  }];
  const ingestRuns = { recent: async () => runs };
  const admin = await signedIn(makeAppWith({
    role: "admin",
    auditBackend: { append: async () => {}, recent: async () => [] },
    ingestRuns,
  }));

  const res = await admin.get("/api/ingest/runs");
  assert.equal(res.status, 200);
  assert.equal(res.body.runs.length, 1, "the still-open run was dropped rather than reported");
  assert.equal(res.body.runs[0].outcome, null);
  assert.equal(res.body.runs[0].finishedAt, null);
});

test("a failed run's specific error reason reaches the client unaltered", async () => {
  const runs = [{
    id: 8, fileName: "master.xlsx", trigger: "watcher",
    startedAt: "2026-08-25T09:00:00.000Z", finishedAt: "2026-08-25T09:00:01.000Z",
    outcome: "failed", projectsSeen: 34, projectsChanged: 3, postureRows: 10,
    error: "snapshot applied but history not recorded",
  }];
  const ingestRuns = { recent: async () => runs };
  const admin = await signedIn(makeAppWith({
    role: "admin",
    auditBackend: { append: async () => {}, recent: async () => [] },
    ingestRuns,
  }));

  const res = await admin.get("/api/ingest/runs");
  assert.equal(res.status, 200);
  assert.equal(res.body.runs[0].error, "snapshot applied but history not recorded");
});

test("an error needing JSON escaping reaches the client byte-identical", async () => {
  const tricky = `could not parse C:\\data\\master.xlsx: unexpected token "}" at line 2\nsee log`;
  const runs = [{
    id: 9, fileName: "master.xlsx", trigger: "watcher",
    startedAt: "2026-08-25T09:00:00.000Z", finishedAt: "2026-08-25T09:00:01.000Z",
    outcome: "failed", projectsSeen: 0, projectsChanged: 0, postureRows: 0,
    error: tricky,
  }];
  const ingestRuns = { recent: async () => runs };
  const admin = await signedIn(makeAppWith({
    role: "admin",
    auditBackend: { append: async () => {}, recent: async () => [] },
    ingestRuns,
  }));

  const res = await admin.get("/api/ingest/runs");
  assert.equal(res.status, 200);
  assert.equal(res.body.runs[0].error, tricky,
    "a quote, a backslash, a Windows path and a newline must all survive the JSON round trip");
});

test("reading ingest runs does not write to the audit trail", async () => {
  const written = [];
  const ingestRuns = { recent: async () => [] };
  const admin = await signedIn(makeAppWith({
    role: "admin",
    auditBackend: { append: async (e) => { written.push(e); }, recent: async () => [] },
    ingestRuns,
  }));
  written.length = 0; // drop the sign-in event; only the read below is under test

  await admin.get("/api/ingest/runs");
  assert.equal(written.length, 0,
    "reading ingest runs was audited, which reverses the deliberate decision not to");
});

/* ------------------------------------------------------------ changed-since */

test("the summary reports whether history is available", async () => {
  const { app } = makeApp({ role: "viewer" });
  const agent = await signedIn(app);
  const res = await agent.get("/api/summary?period=weekly&date=2026-08-25");

  assert.equal(res.status, 200);
  /* The in-memory store keeps no history, and must say so rather than
     implying a stable week. */
  assert.equal(res.body.sections.historyAvailable, false);
  assert.equal(res.body.changes, null);
});

test("a store that knows what changed puts it on the summary", async () => {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  const first = store.all()[0];
  store.changesSince = async () => new Map([
    [first.id, { headline: "health Green to Red", worst: "worse",
                 fields: { health: { from: "Green", to: "Red", direction: "worse" } },
                 since: "2026-08-18T00:00:00.000Z" }],
  ]);

  const app = createApp({
    store, config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-viewers": "viewer" }),
    audit: { append: async () => {} },
    ldapAuthenticate: devAuthenticate("viewer"),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
  const agent = await signedIn(app);
  const res = await agent.get("/api/summary?period=weekly&date=2026-08-25");

  assert.equal(res.body.sections.historyAvailable, true);
  assert.equal(res.body.changes.wentRed, 1);

  /* successes has no flat "items" list in this codebase's section shape --
     "delivered" is its per-project array and carries `id` the same way. */
  const annotated = [
    ...res.body.sections.priorities.items,
    ...res.body.sections.priorities.watchlist,
    ...res.body.sections.successes.delivered,
  ].find((item) => item.id === first.id);
  assert.ok(annotated, "expected the changed project to appear in a section");
  assert.equal(annotated.change.worst, "worse");
});

test("a history query that fails does not take down the briefing", async () => {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  store.changesSince = async () => { throw new Error("database is down"); };

  const app = createApp({
    store, config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-viewers": "viewer" }),
    audit: { append: async () => {} },
    ldapAuthenticate: devAuthenticate("viewer"),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
  const agent = await signedIn(app);
  const res = await agent.get("/api/summary?period=weekly&date=2026-08-25");

  assert.equal(res.status, 200, "a history failure blanked the dashboard");
  assert.equal(res.body.sections.historyAvailable, false);
  assert.ok(res.body.sections.priorities.items.length > 0, "the portfolio itself did not survive");
});

test("a failure reading when history begins does not blank the dashboard", async () => {
  /* The in-memory store's historyStartedAt can never throw, so nothing in the
     rest of the suite covers this path -- and it is the same 500 that a
     failing changesSince would have caused before it was guarded. */
  const store = new Store();
  ingestDirectory(store, "sample-data");
  store.changesSince = async () => new Map();
  store.historyStartedAt = async () => { throw new Error("history table is unreachable"); };

  const app = createApp({
    store, config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-viewers": "viewer" }),
    audit: { append: async () => {} },
    ldapAuthenticate: devAuthenticate("viewer"),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
  const agent = await signedIn(app);
  const res = await agent.get("/api/summary?period=weekly&date=2026-08-25");

  assert.equal(res.status, 200, "a history failure blanked the dashboard");
  assert.equal(res.body.historyStartedAt, null);
  assert.ok(res.body.sections.priorities.items.length > 0, "the portfolio itself did not survive");
  /* changesSince still worked, so history is available -- just not its start. */
  assert.equal(res.body.sections.historyAvailable, true);
});

test("the export route's history guards are exercised too, not just /api/summary", async () => {
  /* /api/export/:format carries the identical loadChanges/loadHistoryStart
     wiring as /api/summary. Every other test in this file hits /api/summary,
     so without this one a future edit that broke only the export handler
     would pass the whole suite while reintroducing the exact 500 the guard
     fix was for. */
  const store = new Store();
  ingestDirectory(store, "sample-data");
  store.changesSince = async () => new Map();
  store.historyStartedAt = async () => { throw new Error("history table is unreachable"); };

  const app = createApp({
    store, config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-viewers": "viewer" }),
    audit: { append: async () => {} },
    ldapAuthenticate: devAuthenticate("viewer"),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
  const agent = await signedIn(app);
  const res = await agent.post("/api/export/html").send({ period: "weekly", date: "2026-08-25" });

  assert.equal(res.status, 200, "a history failure blanked the export");
  assert.match(res.headers["content-type"], /text\/html/);
});

/* ------------------------------------------------------------- SSO config */

const ssoConfig = loadConfig({
  NODE_ENV: "test", STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "viewer",
  SSO_ENABLED: "true",
  ENTRA_TENANT_ID: "tenant-abc",
  ENTRA_CLIENT_ID: "client-123",
  ENTRA_CLIENT_SECRET: "super-secret-value",
});

function makeSsoApp() {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  return createApp({
    store,
    config: ssoConfig,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-viewers": "viewer" }),
    audit: { append: async () => {}, recent: async () => [] },
    ldapAuthenticate: devAuthenticate("viewer"),
    entraJwks: { get: async () => ({ keys: [] }) },
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
}

test("with SSO off the client is told so, and given no Entra details", async () => {
  const res = await request(makeApp().app).get("/api/me");
  assert.equal(res.body.sso, false);
  assert.equal(res.body.entra, null);
});

test("with SSO on the public client details are published", async () => {
  const res = await request(makeSsoApp()).get("/api/me");
  assert.equal(res.body.sso, true);
  assert.equal(res.body.entra.clientId, "client-123");
  assert.equal(res.body.entra.tenantId, "tenant-abc");
});

test("the client secret is never sent to a browser", async () => {
  const res = await request(makeSsoApp()).get("/api/me");
  assert.ok(!JSON.stringify(res.body).includes("super-secret-value"),
    "the Entra client secret was exposed to an anonymous caller");
});

test("the SSO endpoint answers 404 when single sign-on is switched off", async () => {
  const res = await request(makeApp().app).post("/api/auth/sso").send({ idToken: "anything" });
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, "sso_disabled");
});

test("an SSO token that validates against nothing is refused, not accepted", async () => {
  const res = await request(makeSsoApp()).post("/api/auth/sso").send({ idToken: "not.a.token" });
  assert.equal(res.status, 503, "an unverifiable token must never create a session");
  assert.equal(res.body.error.code, "no_keys");
});

test("security headers are set on every response", async () => {
  const { app } = makeApp();
  const res = await request(app).get("/healthz");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.match(res.headers["content-security-policy"], /default-src 'self'/);
  assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
});

test("the session cookie is httpOnly and SameSite=Strict, which is the CSRF defence", async () => {
  const { app } = makeApp();
  const res = await request(app).post("/api/auth/login").send({ username: "pat", password: "x" });
  const cookie = res.headers["set-cookie"].join(";");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test("repeated sign-in attempts are throttled", async () => {
  const { app } = makeApp();
  const agent = request(app);
  let limited = false;
  for (let i = 0; i < 14; i += 1) {
    const res = await agent.post("/api/auth/login").send({ username: "pat", password: "x" });
    if (res.status === 429) {
      limited = true;
      assert.equal(res.body.error.code, "rate_limited");
      break;
    }
  }
  assert.ok(limited, "sign-in was never throttled");
});
