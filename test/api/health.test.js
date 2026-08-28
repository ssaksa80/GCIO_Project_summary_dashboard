/**
 * /healthz's version field.
 *
 * This is not cosmetic. The release system compares versions at every step —
 * the patch gate refuses an artifact whose base is too old, and deploy.log
 * records what actually reached a host. A literal that never moves makes
 * "did the fix land?" unanswerable, and answers it wrongly rather than
 * failing loudly, which is worse.
 *
 * /metrics already reports the truth via config.version (gcio_build_info).
 * These tests pin the two to the same source so they cannot drift apart
 * again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import request from "supertest";

import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { memorySessions, memoryRoleMapping, devAuthenticate } from "../../server/devBackends.js";

const store = () => ({
  projectCount: 34, fileCount: 3, ready: true, demoMode: false,
  lastIngestAt: "2026-08-26T09:00:02.000Z",
});

/** The app, built the way the other api tests build it. */
function appWith(config) {
  return createApp({
    store: store(),
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-admins": "admin" }),
    audit: { append: async () => {}, recent: async () => [] },
    ldapAuthenticate: devAuthenticate("admin"),
    dataDir: "data",
    clientDist: "client/dist",
  });
}

test("/healthz reports the running build's version, not a hardcoded literal", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const res = await request(appWith(loadConfig({ STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" })))
    .get("/healthz").expect(200);

  assert.equal(res.body.version, pkg.version,
    "a release system built on version comparison cannot have /healthz reporting a stale literal");
});

test("/healthz and /metrics BOTH follow config, so neither can drift to a literal", async () => {
  /* Injecting a version no literal in the tree would ever equal is what makes
     this able to fail. Asserting only that the two endpoints AGREE cannot:
     once both read the same variable, agreement is tautological and a shared
     hardcoded literal would satisfy it perfectly. Drive them from a value
     that must have come from config, and each endpoint is pinned on its own. */
  const config = { ...loadConfig({ STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" }), version: "9.9.9-test" };
  const app = appWith(config);

  const health = await request(app).get("/healthz").expect(200);
  const metrics = await request(app).get("/metrics").expect(200);

  const m = /gcio_build_info\{version="([^"]+)"\}/.exec(metrics.text);
  assert.ok(m, "gcio_build_info is missing from the exposition");

  assert.equal(health.body.version, "9.9.9-test", "/healthz is not following config.version");
  assert.equal(m[1], "9.9.9-test", "/metrics is not following config.version");
});

test("/healthz follows config.version rather than any literal of its own", async () => {
  /* Not the real version: if /healthz were reading a constant, this would
     still come back as that constant and the assertion would catch it. */
  const config = { ...loadConfig({ STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" }), version: "9.9.9-test" };
  const res = await request(appWith(config)).get("/healthz").expect(200);

  assert.equal(res.body.version, "9.9.9-test");
});
