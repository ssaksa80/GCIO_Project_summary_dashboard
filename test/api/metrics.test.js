/**
 * The Prometheus exposition, both the pure renderer and the route that
 * serves it. /metrics is open — no session, unlike everything else under
 * /api — which is only defensible while it holds nothing but numbers. The
 * leak test below is the one guarding that: no project name, no person, no
 * filename, no department, no error message, ever.
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import { renderMetrics } from "../../server/metrics.js";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { memorySessions, memoryRoleMapping, devAuthenticate } from "../../server/devBackends.js";

const store = (over = {}) => ({
  projectCount: 34, fileCount: 3, ready: true, demoMode: false,
  lastIngestAt: "2026-08-26T09:00:02.000Z",
  ...over,
});

// ---------------------------------------------------------------- renderer

test("the exposition parses as Prometheus text", async () => {
  const body = await renderMetrics({ store: store(), startedAt: Date.now() - 60_000 });

  for (const line of body.trim().split("\n")) {
    assert.match(line, /^(#\s|[a-z_]+(\{[^}]*\})?\s-?[0-9.e+]+$)/,
      `not a valid exposition line: ${line}`);
  }
  assert.match(body, /^# HELP gcio_up /m);
  assert.match(body, /^# TYPE gcio_up gauge$/m);
  assert.match(body, /^gcio_up 1$/m);
});

test("it reports the portfolio the dashboard is actually serving", async () => {
  const body = await renderMetrics({ store: store(), startedAt: Date.now() });
  assert.match(body, /^gcio_projects 34$/m);
  assert.match(body, /^gcio_source_files 3$/m);
});

test("no series and no label carries anything read from a workbook", async () => {
  /* The endpoint is open at the app and blocked at the proxy. That is only
     safe while it holds nothing but numbers. */
  const body = await renderMetrics({
    store: store(),
    startedAt: Date.now(),
    ingestTiming: { runs: 5, slowestParseMs: 60, slowestPersistMs: 1200, lastFinishedAt: "2026-08-26T09:00:02.000Z" },
    runOutcomes: { applied: 4, unchanged: 1, failed: 0, removed: 0 },
  });

  for (const forbidden of ["master.xlsx", "PRJ-", "Cybersecurity", "@"]) {
    assert.ok(!body.includes(forbidden), `the exposition leaked ${forbidden}`);
  }
  /* Only the outcome vocabulary may appear as a label value. */
  const labels = [...body.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  for (const label of labels) {
    assert.match(label, /^(outcome="(applied|unchanged|failed|removed)"|version="[0-9a-zA-Z.\-+]+")$/,
      `unexpected label: ${label}`);
  }
});

test("run outcomes are one series per outcome, including the zeroes", async () => {
  /* A missing series and a zero read very differently on a graph: one is a
     gap, the other is "nothing failed". Always emit all four. */
  const body = await renderMetrics({
    store: store(), startedAt: Date.now(),
    runOutcomes: { applied: 4, unchanged: 1, failed: 0, removed: 0 },
  });

  for (const outcome of ["applied", "unchanged", "failed", "removed"]) {
    assert.match(body, new RegExp(`^gcio_ingest_runs\\{outcome="${outcome}"\\} \\d+$`, "m"));
  }
});

test("timings appear when history is available and are simply absent when it is not", async () => {
  const withHistory = await renderMetrics({
    store: store(), startedAt: Date.now(),
    ingestTiming: { runs: 5, slowestParseMs: 60, slowestPersistMs: 1200, lastFinishedAt: "2026-08-26T09:00:02.000Z" },
  });
  assert.match(withHistory, /^gcio_ingest_parse_slowest_ms 60$/m);

  const without = await renderMetrics({ store: store(), startedAt: Date.now() });
  assert.ok(!without.includes("gcio_ingest_parse_slowest_ms"),
    "a series was emitted with no data behind it");
  /* But the endpoint still works and still says the app is up. */
  assert.match(without, /^gcio_up 1$/m);
});

test("a partial ingestTiming shape omits the series rather than rendering 'undefined'", async () => {
  /* A shape missing a field entirely (as opposed to explicitly null) must
     not render as literal text `undefined` -- that is not valid exposition
     and would break a scrape silently. */
  const body = await renderMetrics({
    store: store(), startedAt: Date.now(),
    ingestTiming: { runs: 5, lastFinishedAt: "2026-08-26T09:00:02.000Z" },
  });
  assert.ok(!body.includes("gcio_ingest_parse_slowest_ms"), "an incomplete shape rendered a timing series anyway");
  assert.ok(!body.includes("gcio_ingest_persist_slowest_ms"), "an incomplete shape rendered a timing series anyway");
  assert.ok(!body.includes("undefined"), "the exposition must never contain the literal word 'undefined'");
});

test("gcio_last_ingest_timestamp_seconds is always present, 0 when nothing has ever been ingested", async () => {
  /* Omitting this series when there is no data would make the natural alert
     -- time() - gcio_last_ingest_timestamp_seconds > threshold -- match an
     empty vector and never fire, in exactly the state most worth alerting
     on. 0 reads as maximally stale under that same comparison. */
  const body = await renderMetrics({ store: store({ lastIngestAt: null }), startedAt: Date.now() });
  assert.match(body, /^gcio_last_ingest_timestamp_seconds 0$/m);
});

test("a store that is not ready says so rather than omitting the series", async () => {
  const body = await renderMetrics({ store: store({ ready: false }), startedAt: Date.now() });
  assert.match(body, /^gcio_ready 0$/m);
});

test("demo mode is visible, because a demo dashboard in production is worth an alert", async () => {
  const body = await renderMetrics({ store: store({ demoMode: true }), startedAt: Date.now() });
  assert.match(body, /^gcio_demo_mode 1$/m);
});

test("gcio_ingest_leader is 1 when this process holds the ingest lock", async () => {
  const body = await renderMetrics({ store: store(), startedAt: Date.now(), ingestLeader: true });
  assert.match(body, /^gcio_ingest_leader 1$/m);
});

test("gcio_ingest_leader is 0 when another instance holds the lock", async () => {
  const body = await renderMetrics({ store: store(), startedAt: Date.now(), ingestLeader: false });
  assert.match(body, /^gcio_ingest_leader 0$/m);
});

test("gcio_ingest_leader defaults to 1 (memory mode, and any caller that has not wired the election, both ingest in-process)", async () => {
  const body = await renderMetrics({ store: store(), startedAt: Date.now() });
  assert.match(body, /^gcio_ingest_leader 1$/m);
});

test("uptime is seconds, not milliseconds", async () => {
  const body = await renderMetrics({ store: store(), startedAt: Date.now() - 90_000 });
  const uptime = Number(body.match(/^gcio_uptime_seconds ([0-9.]+)$/m)[1]);
  assert.ok(uptime >= 89 && uptime <= 92, `uptime looks wrong: ${uptime}`);
});

// -------------------------------------------------------------------- route

const config = loadConfig({ NODE_ENV: "test", STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" });

function makeApp({ storeOver = {}, ingestRuns = null, isIngestLeader } = {}) {
  return createApp({
    store: store(storeOver),
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-admins": "admin" }),
    audit: { append: async () => {} },
    ingestRuns,
    isIngestLeader,
    ldapAuthenticate: devAuthenticate("admin"),
    dataDir: "data",
    clientDist: "client/dist",
  });
}

test("GET /metrics answers an anonymous caller, because a scraper cannot sign in", async () => {
  const app = makeApp();
  const res = await request(app).get("/metrics");
  assert.equal(res.status, 200);
});

test("GET /metrics uses the Prometheus exposition content type", async () => {
  const app = makeApp();
  const res = await request(app).get("/metrics");
  assert.equal(res.headers["content-type"], "text/plain; version=0.0.4; charset=utf-8");
});

test("GET /metrics carries the running build's version from package.json", async () => {
  const app = makeApp();
  const res = await request(app).get("/metrics");
  assert.match(res.text, /^gcio_build_info\{version="[0-9]+\.[0-9]+\.[0-9]+"\} 1$/m);
});

test("GET /metrics still returns the base series when ingest history fails to load", async () => {
  /* Monitoring that goes dark exactly when the database does is worse than no
     monitoring: the route must degrade, not fail. */
  const ingestRuns = {
    timingSummary: async () => { throw new Error("connection reset"); },
    countByOutcome: async () => { throw new Error("connection reset"); },
  };
  const app = makeApp({ ingestRuns });
  const res = await request(app).get("/metrics");

  assert.equal(res.status, 200);
  assert.match(res.text, /^gcio_up 1$/m);
  assert.match(res.text, /^gcio_projects 34$/m);
  assert.ok(!res.text.includes("gcio_ingest_runs"), "an outcome series survived a failed history read");
  assert.ok(!res.text.includes("gcio_ingest_parse_slowest_ms"), "a timing series survived a failed history read");
});

test("GET /metrics renders history series when ingestRuns answers", async () => {
  const ingestRuns = {
    timingSummary: async () => ({ runs: 5, slowestParseMs: 60, slowestPersistMs: 1200, lastFinishedAt: "2026-08-26T09:00:02.000Z" }),
    countByOutcome: async () => ({ applied: 4, unchanged: 1, failed: 0, removed: 0 }),
  };
  const app = makeApp({ ingestRuns });
  const res = await request(app).get("/metrics");

  assert.equal(res.status, 200);
  assert.match(res.text, /^gcio_ingest_runs\{outcome="applied"\} 4$/m);
  assert.match(res.text, /^gcio_ingest_runs\{outcome="failed"\} 0$/m);
  assert.match(res.text, /^gcio_ingest_parse_slowest_ms 60$/m);
});

test("GET /metrics reflects the live election result, not just a snapshot from boot", async () => {
  /* isIngestLeader is a function, not a plain boolean, precisely because a
     leader can lose its connection mid-run (see leaderElection.test.js) --
     the scrape must see that flip without the app being rebuilt. */
  let leader = true;
  const app = makeApp({ isIngestLeader: () => leader });

  const first = await request(app).get("/metrics");
  assert.match(first.text, /^gcio_ingest_leader 1$/m);

  leader = false;
  const second = await request(app).get("/metrics");
  assert.match(second.text, /^gcio_ingest_leader 0$/m);
});

test("GET /metrics defaults gcio_ingest_leader to 1 when no election is wired (STORE=memory)", async () => {
  const app = makeApp();
  const res = await request(app).get("/metrics");
  assert.match(res.text, /^gcio_ingest_leader 1$/m);
});

test("GET /metrics still renders the base series when there is no history backend at all", async () => {
  /* ingestRuns is null on the in-memory store — no database behind it. */
  const app = makeApp({ ingestRuns: null });
  const res = await request(app).get("/metrics");

  assert.equal(res.status, 200);
  assert.match(res.text, /^gcio_up 1$/m);
  assert.ok(!res.text.includes("gcio_ingest_runs"));
});

test("GET /metrics still returns 200 and gcio_up 1 when the store itself throws", async () => {
  /* An unreachable store is exactly when a scraper most needs to see the
     process is still alive -- reading it must degrade the same way a failed
     ingest-history read does, not turn into a 500 from the global handler. */
  const brokenStore = {
    get projectCount() { throw new Error("disk read failed"); },
    fileCount: 0,
    demoMode: false,
    lastIngestAt: null,
  };
  const app = createApp({
    store: brokenStore,
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-admins": "admin" }),
    audit: { append: async () => {} },
    ingestRuns: null,
    ldapAuthenticate: devAuthenticate("admin"),
    dataDir: "data",
    clientDist: "client/dist",
  });

  const res = await request(app).get("/metrics");

  assert.equal(res.status, 200);
  assert.match(res.text, /^gcio_up 1$/m);
  assert.match(res.text, /^gcio_ready 0$/m);
});
