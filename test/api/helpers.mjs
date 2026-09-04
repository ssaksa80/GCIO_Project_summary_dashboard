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
import { memorySessions, memoryRoleMapping, memoryUserRoleMapping } from "../../server/devBackends.js";

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
  const app = createApp({
    store: new Store(),
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping(ROLE_MAP),
    userRoleMapping,
    audit: { append: async () => {}, recent: async () => [] },
    /* The username carries the role for this request: "admin:asmith" signs in
       as asmith holding the admin group. */
    ldapAuthenticate: async ({ username }) => {
      const [role, name] = String(username || "").split(":");
      return { principal: name || role || "tester", groups: [GROUP_FOR[role] || GROUP_FOR.viewer] };
    },
    searchDirectory: opts.searchUsers || (async () => []),
    dataDir,
    clientDist: "client/dist",
  });
  return { app, userRoleMapping };
}

/**
 * A caller signed in as `username` holding `role`.
 *
 * Returns thin get/post/delete wrappers rather than a supertest agent, because
 * every call has to sign in first and the tests read better without that
 * repeated in each one.
 */
export function asRole(app, role, username = "tester") {
  const signIn = async () => {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/login").send({ username: `${role}:${username}`, password: "x" });
    assert.equal(res.status, 200, `sign-in failed: ${JSON.stringify(res.body)}`);
    return agent;
  };
  return {
    async get(url) { return (await signIn()).get(url); },
    async post(url, body) { return (await signIn()).post(url).send(body); },
    async delete(url) { return (await signIn()).delete(url); },
  };
}

/** supertest already parses JSON; this just makes the intent explicit. */
export function jsonBody(res) {
  return res.body;
}
