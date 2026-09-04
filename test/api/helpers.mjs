/*
 * Shared harness for the admin-console API tests.
 *
 * Follows the makeApp/signedIn shape already used in app.test.js, with one
 * addition: a single app has to answer as different roles across a test, so
 * the directory stand-in reads the role out of the username it is given
 * ("admin:asmith") rather than being fixed when the app is built.
 */
import request from "supertest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { Store } from "../../server/store.js";
import { memorySessions, memoryRoleMapping, memoryUserRoleMapping, memoryOwnership, memorySettings } from "../../server/devBackends.js";

const config = loadConfig({ STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" });

const GROUP_FOR = { admin: "gcio-admins", pm: "gcio-pms", viewer: "gcio-viewers" };
const ROLE_MAP = { "gcio-admins": "admin", "gcio-pms": "pm", "gcio-viewers": "viewer" };

function scratchDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gcio-admin-test-"));
}

/**
 * Build an app with in-memory backends.
 *
 * @param {object} t node:test context, used to clean the scratch dir up
 * @param {{searchUsers?: Function, grants?: Record<string,string>}} [opts]
 */
export async function makeTestDeps(t, opts = {}) {
  const dataDir = scratchDataDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  const userRoleMapping = memoryUserRoleMapping(opts.grants || {});
  const roleMapping = memoryRoleMapping({ ...ROLE_MAP });
  const sessions = memorySessions();
  const ownership = memoryOwnership();
  const settings = memorySettings();
  /* Stand-ins that answer rather than probe. A test overriding one gets
     only the piece it named; the rest keep working, which is how the
     'a failing probe must not take the page down' cases stay honest. */
  const adminProbes = {
    async database() { return { up: true, ms: 1, database: 'test', serverVersion: 'stub', tables: [] }; },
    async migrations() { return { applied: [{ id: 13, name: 'section_ownership_and_settings' }], last: 13 }; },
    async directory() { return { url: 'ldaps://dc.example.test:636', bindDN: 'svc', baseDN: 'DC=x', searchable: true }; },
    async logs() { return { which: 'out', exists: false, lines: [], available: ['out', 'err', 'deploy'] }; },
    ...(opts.adminProbes || {}),
  };
  const app = createApp({
    store: new Store(),
    config,
    sessions,
    roleMapping,
    userRoleMapping,
    audit: { append: async () => {}, recent: async () => [] },
    /* The username carries the role for this request: "admin:asmith" signs in
       as asmith holding the admin group. */
    ldapAuthenticate: async ({ username }) => {
      const [role, name] = String(username || "").split(":");
      return { principal: name || role || "tester", groups: [GROUP_FOR[role] || GROUP_FOR.viewer] };
    },
    searchDirectory: opts.searchUsers || (async () => []),
    ownership,
    settings,
    adminProbes,
    dataDir,
    clientDist: "client/dist",
  });
  return { app, userRoleMapping, roleMapping, sessions, ownership, settings };
}

/**
 * A caller signed in as `username` holding `role`.
 *
 * Returns thin get/post/delete wrappers rather than a supertest agent, because
 * every call has to sign in first and the tests read better without that
 * repeated in each one.
 */
/**
 * A caller signed in as `username` holding `role`.
 *
 * The agent is cached per app+role+username. Signing in on every call looked
 * tidier and tripped the sign-in rate limiter the moment a test made more than
 * ten requests - which the first multi-screen test did, and it failed with
 * "too many sign-in attempts" rather than anything about the screens. The
 * limiter is correct; the harness was wrong to hammer it.
 */
const agents = new WeakMap();

export function asRole(app, role, username = "tester") {
  if (!agents.has(app)) agents.set(app, new Map());
  const perApp = agents.get(app);
  const key = `${role}:${username}`;

  const agent = async () => {
    if (!perApp.has(key)) {
      perApp.set(key, (async () => {
        const a = request.agent(app);
        const res = await a.post("/api/auth/login").send({ username: key, password: "x" });
        assert.equal(res.status, 200, `sign-in failed: ${JSON.stringify(res.body)}`);
        return a;
      })());
    }
    return perApp.get(key);
  };

  return {
    async get(url) { return (await agent()).get(url); },
    async post(url, body) { return (await agent()).post(url).send(body); },
    async put(url, body) { return (await agent()).put(url).send(body); },
    async delete(url) { return (await agent()).delete(url); },
  };
}

/** supertest already parses JSON; this just makes the intent explicit. */
export function jsonBody(res) {
  return res.body;
}
