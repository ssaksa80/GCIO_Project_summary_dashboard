# Backend Phase 0 — Safe Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the demo server into something safe to put in front of the CIO's office — every request authenticated against Entra ID, roles enforced, actions audited, transport and uploads hardened, running as a Windows service, with a real test suite.

**Architecture:** The Express app is split out of the startup file so tests can drive it in-process. Authentication is OIDC authorization-code + PKCE against Entra, with the session held in an encrypted cookie (no database — that arrives in Phase 1). Roles come from Entra group claims and are enforced by one middleware. Audit events append to a JSONL sink behind an interface, so Phase 1 can swap it for the `audit_event` table without touching call sites. The `domain/` code (sections, summarize, chain) is not touched.

**Tech Stack:** Node 24, Express 4, `openid-client` v5, `iron-webcrypto` for sealed cookies, `helmet`, `express-rate-limit`, `pino`, `node:test` + `supertest`, NSSM for the Windows service, IIS for TLS.

**Spec:** `docs/superpowers/specs/2026-08-24-backend-production-design.md`

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/app.js` | **create** — builds and returns the Express app; no listening, no side effects |
| `server/index.js` | **modify** — startup only: config, logger, ingestion boot, watcher, `listen` |
| `server/config.js` | **create** — reads and validates environment; throws on boot if anything is missing |
| `server/logger.js` | **create** — pino instance + request-id middleware |
| `server/audit.js` | **create** — `appendAudit(event)` behind an interface; JSONL sink today, table in P1 |
| `server/auth/session.js` | **create** — seal/unseal the session cookie |
| `server/auth/oidc.js` | **create** — Entra discovery, auth URL, callback exchange, claim→role mapping |
| `server/auth/middleware.js` | **create** — `attachUser`, `requireAuth`, `requireRole` |
| `server/auth/routes.js` | **create** — `/auth/login`, `/auth/callback`, `/auth/logout`, `/api/me` |
| `server/security.js` | **create** — helmet + CSP, rate limiters, CSRF |
| `server/uploadGuard.js` | **create** — magic-byte sniffing for workbook uploads |
| `server/health.js` | **create** — `/healthz`, `/readyz` |
| `client/src/lib/api.js` | **modify** — send credentials, redirect on 401, carry the CSRF token |
| `client/src/components/TopBar.jsx` | **modify** — show signed-in user, hide Upload unless PM/Admin |
| `client/src/App.jsx` | **modify** — fetch `/api/me`, pass the user down |
| `deploy/install-service.ps1` | **create** — NSSM service install |
| `deploy/iis-site.md` | **create** — IIS reverse proxy + TLS runbook |
| `.env.example` | **create** — every variable, with safe placeholder values |
| `test/domain/*.test.js` | **create** — frozen-fixture tests for the ranking rules |
| `test/auth/*.test.js` | **create** — session, role mapping |
| `test/api/*.test.js` | **create** — authz matrix, CSRF, upload guard, health |

---

### Task 1: Test harness, and split the app out of the startup file

Nothing else can be tested until `app` exists without `listen()`.

**Files:**
- Create: `server/app.js`
- Modify: `server/index.js`
- Modify: `package.json`
- Test: `test/api/boot.test.js`

- [ ] **Step 1: Add the test script and test dependency**

In `package.json`, add to `"scripts"`:

```json
    "test": "node --test test/",
    "test:watch": "node --test --watch test/"
```

Then install supertest:

```bash
npm install --save-dev supertest@7.1.1
```

- [ ] **Step 2: Write the failing test**

Create `test/api/boot.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../../server/app.js";
import { Store } from "../../server/store.js";
import { ingestDirectory } from "../../server/ingest.js";

/** A store loaded with the bundled sample portfolio, for tests that need data. */
export function sampleStore() {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  return store;
}

test("createApp returns an app that serves health without listening", async () => {
  const app = createApp({ store: sampleStore() });
  const res = await request(app).get("/healthz");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../../server/app.js'`.

- [ ] **Step 4: Create `server/app.js`**

Move every route from `server/index.js` into this factory. The factory takes its
dependencies as arguments so tests can supply their own store.

```js
/**
 * Builds the Express application. No listening, no watcher, no process-level
 * handlers — those belong to index.js, so tests can drive the app in-process.
 */
import path from "node:path";
import fs from "node:fs";
import express from "express";
import dayjs from "dayjs";
import multer from "multer";

import { ingestBuffer, WORKBOOK_EXTENSIONS } from "./ingest.js";
import { buildSummary, toRow, computeDetail } from "./summarize.js";
import { getChain } from "./chain.js";
import { buildExcel } from "./exporters/excel.js";
import { buildWord } from "./exporters/word.js";
import { buildHtml } from "./exporters/html.js";
import { buildPptxDeck } from "./exporters/pptx.js";
import { buildTemplate, TEMPLATE_FILENAME } from "./template.js";

const PERIODS = new Set(["daily", "weekly", "monthly", "yearly"]);
const VERSION = "1.0.0";

/**
 * @param {{store: object, dataDir?: string, clientDist?: string, startedAt?: number}} deps
 * @returns {import('express').Express}
 */
export function createApp(deps) {
  const { store } = deps;
  const dataDir = deps.dataDir || path.resolve("data");
  const clientDist = deps.clientDist || path.resolve("client", "dist");
  const startedAt = deps.startedAt || Date.now();

  const app = express();
  app.use(express.json({ limit: "40mb" }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get("/healthz", (req, res) => {
    res.json({ status: "ok", uptimeSec: Math.round((Date.now() - startedAt) / 1000), version: VERSION });
  });

  // --- everything below is moved verbatim from the old index.js ---
  // /api/health, /api/meta, /api/summary, /api/projects, /api/projects/:id,
  // /api/template, /api/ingest/upload, /api/export/:format, /api/events
  // (copy the handler bodies across unchanged; they already work)

  app.use(express.static(clientDist, { index: "index.html", maxAge: "1h" }));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    const index = path.join(clientDist, "index.html");
    if (fs.existsSync(index)) return res.sendFile(index);
    res.status(503).send("GCIO dashboard client is not built yet. Run: npm run build");
  });

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(`[gcio] ${req.method} ${req.path} failed: ${err.stack || err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
  });

  return app;
}
```

- [ ] **Step 5: Reduce `server/index.js` to startup only**

```js
/**
 * Process entry point: load config, build the store, ingest what is on disk,
 * start the watcher, and listen. All routing lives in app.js.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dayjs from "dayjs";

import { createApp } from "./app.js";
import { Store } from "./store.js";
import { ingestDirectory, watchDataDir } from "./ingest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SAMPLE_DIR = path.join(ROOT, "sample-data");
const PORT = Number(process.env.PORT || 8123);

const log = (msg) => console.log(`[gcio ${dayjs().format("HH:mm:ss")}] ${msg}`);
const store = new Store();

fs.mkdirSync(DATA_DIR, { recursive: true });
{
  const fromData = ingestDirectory(store, DATA_DIR);
  if (fromData.files > 0) {
    log(`ingested ${store.projectCount} projects from ${fromData.files} workbook(s) in data/`);
  } else {
    const fromSample = ingestDirectory(store, SAMPLE_DIR);
    if (fromSample.files > 0) {
      store.demoMode = true;
      log(`demo mode: ingested ${store.projectCount} projects from ${fromSample.files} sample workbook(s)`);
    } else if (store.loadCache(DATA_DIR)) {
      log(`restored ${store.projectCount} projects from cache snapshot`);
    } else {
      log("no data yet — waiting for workbooks in data/ or an upload");
    }
  }
  if (store.projectCount > 0) store.lastIngestAt = store.lastIngestAt || new Date().toISOString();
}

watchDataDir(store, DATA_DIR, (batch) => {
  store.saveCache(DATA_DIR);
  store.emit("ingest", { files: batch.files, projectCount: store.projectCount, at: store.lastIngestAt });
  log(`live ingest: ${batch.files.join(", ")} -> ${store.projectCount} projects`);
});

const app = createApp({ store, dataDir: DATA_DIR, clientDist: path.join(ROOT, "client", "dist") });

process.on("unhandledRejection", (err) => console.error(`[gcio] unhandled rejection: ${err && err.stack}`));
process.on("uncaughtException", (err) => console.error(`[gcio] uncaught exception: ${err && err.stack}`));

app.listen(PORT, () => {
  log(`GCIO Project Intelligence listening on http://localhost:${PORT}`);
  log(`watching ${DATA_DIR} for workbooks (24x7 live ingestion)`);
});
```

- [ ] **Step 6: Run the test**

Run: `npm test`
Expected: PASS — 1 test.

- [ ] **Step 7: Confirm the real server still boots**

Run: `npm start`
Expected: the same three log lines as before; `curl http://localhost:8123/api/health` returns 200. Stop it afterwards.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json server/app.js server/index.js test/api/boot.test.js
git commit -m "refactor(server): split the Express app out of startup so it can be tested"
```

---

### Task 2: Frozen-fixture tests for the ranking rules

Write these before touching auth. They are the safety net that proves Phase 0
changed no behaviour.

**Files:**
- Test: `test/domain/sections.test.js`

- [ ] **Step 1: Write the tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildSections } from "../../server/sections.js";
import dayjs from "dayjs";

const TODAY = "2026-08-23";
const ctx = {
  period: "weekly",
  start: dayjs("2026-08-17"),
  end: dayjs("2026-08-23"),
  todayISO: TODAY,
};

/** One project, overridable, with the child arrays the builders expect. */
function project(over = {}) {
  return {
    id: "P-1", name: "Test Project", department: "IT", pillar: "Core",
    owner: "An Owner", sponsor: "A Sponsor", status: "In Progress",
    health: "Green", priority: "Medium", phase: "Execution",
    approvalDate: "2025-01-01", startDate: "2025-06-01",
    targetEndDate: "2026-06-30", actualEndDate: null,
    budget: 1000000, spent: 500000, percentComplete: 50,
    parentId: null, lastUpdated: TODAY,
    milestones: [], updates: [], risks: [], questions: [],
    ...over,
  };
}

test("an overdue Red critical project outranks a healthy one, with its reasons named", () => {
  const bad = project({
    id: "P-BAD", name: "Late Thing", priority: "Critical", health: "Red",
    targetEndDate: "2026-06-30",
  });
  const good = project({ id: "P-OK", name: "Fine Thing" });

  const { priorities } = buildSections([bad, good], ctx);
  const top = priorities.items[0];

  assert.equal(top.id, "P-BAD");
  assert.match(top.why, /Critical priority/);
  assert.match(top.why, /Red health/);
  assert.match(top.why, /days past target/);
  assert.ok(top.score > priorities.items[1].score);
});

test("scores are capped at 99 so no project can run away with the list", () => {
  const worst = project({
    priority: "Critical", health: "Red", targetEndDate: "2024-01-01",
    budget: 100, spent: 100000,
    risks: [{ title: "r1", severity: "Critical", status: "Open" },
            { title: "r2", severity: "Critical", status: "Open" }],
  });
  const { priorities } = buildSections([worst], ctx);
  assert.ok(priorities.items[0].score <= 99);
});

test("a project on hold produces a derived question naming the hold", () => {
  const held = project({ status: "On Hold", lastUpdated: "2026-06-01" });
  const { qri } = buildSections([held], ctx);
  const derived = qri.questions.filter((q) => q.source === "derived");
  assert.ok(derived.some((q) => /on hold/i.test(q.text)));
});

test("a question written in the workbook outranks a derived one", () => {
  const asked = project({
    questions: [{ text: "Should we proceed?", askedBy: "PM", raisedDate: TODAY,
                  neededBy: null, decisionOwner: "CIO", status: "Open", source: "workbook" }],
    status: "On Hold",
  });
  const { qri } = buildSections([asked], ctx);
  assert.equal(qri.questions[0].source, "workbook");
});

test("counts describe the whole portfolio, not the truncated list", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    project({ id: `P-${i}`, status: "On Hold", lastUpdated: "2026-01-01" }));
  const { qri } = buildSections(many, ctx);
  assert.ok(qri.questions.length <= 12);
  assert.ok(qri.counts.questions >= 30);
});

test("a project at 100% complete is never reported as ahead of plan", () => {
  const done = project({ percentComplete: 100, health: "Green", startDate: "2026-01-01" });
  const { successes } = buildSections([done], ctx);
  assert.equal(successes.recovered.length, 0);
});
```

- [ ] **Step 2: Run them**

Run: `npm test`
Expected: PASS — all six. If any fail, the ranking rules have drifted; fix the
code, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/domain/sections.test.js
git commit -m "test(domain): freeze the section ranking and derivation rules"
```

---

### Task 3: Validated configuration

**Files:**
- Create: `server/config.js`
- Create: `.env.example`
- Test: `test/config.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../server/config.js";

const base = {
  NODE_ENV: "production",
  AUTH_MODE: "entra",
  SESSION_KEY: "x".repeat(32),
  OIDC_TENANT_ID: "tenant", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "secret",
  OIDC_REDIRECT_URI: "https://dash.example/auth/callback",
  GROUP_VIEWER: "g-viewer", GROUP_PM: "g-pm", GROUP_ADMIN: "g-admin",
};

test("a complete production environment loads", () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.authMode, "entra");
  assert.equal(cfg.port, 8123);
  assert.equal(cfg.host, "127.0.0.1");
});

test("a missing secret fails the boot, naming the variable", () => {
  const { OIDC_CLIENT_SECRET, ...missing } = base;
  assert.throws(() => loadConfig(missing), /OIDC_CLIENT_SECRET/);
});

test("a short session key is rejected", () => {
  assert.throws(() => loadConfig({ ...base, SESSION_KEY: "tooshort" }), /SESSION_KEY/);
});

test("dev auth mode is refused in production", () => {
  assert.throws(() => loadConfig({ ...base, AUTH_MODE: "dev" }), /AUTH_MODE=dev/);
});

test("dev auth mode is allowed outside production and needs no Entra settings", () => {
  const cfg = loadConfig({ NODE_ENV: "development", AUTH_MODE: "dev", SESSION_KEY: "y".repeat(32) });
  assert.equal(cfg.authMode, "dev");
  assert.equal(cfg.devRole, "admin");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/config.test.js`
Expected: FAIL — cannot find `server/config.js`.

- [ ] **Step 3: Implement `server/config.js`**

```js
/**
 * Environment configuration, validated once at boot.
 *
 * A missing secret must stop the process with the variable's name, not
 * surface later as a confusing 500 during someone's sign-in.
 */
const ROLES = ["viewer", "pm", "admin"];

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {object} frozen config
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const need = (key) => {
    const value = (env[key] || "").trim();
    if (!value) problems.push(`${key} is required`);
    if (/^(changeme|placeholder|todo)$/i.test(value)) problems.push(`${key} still holds a placeholder value`);
    return value;
  };

  const nodeEnv = env.NODE_ENV || "development";
  const isProd = nodeEnv === "production";
  const authMode = (env.AUTH_MODE || (isProd ? "entra" : "dev")).toLowerCase();

  if (!["entra", "dev"].includes(authMode)) problems.push(`AUTH_MODE must be entra or dev`);
  if (authMode === "dev" && isProd) problems.push("AUTH_MODE=dev is not permitted when NODE_ENV=production");

  const sessionKey = need("SESSION_KEY");
  if (sessionKey && sessionKey.length < 32) problems.push("SESSION_KEY must be at least 32 characters");

  const oidc = { tenantId: "", clientId: "", clientSecret: "", redirectUri: "" };
  const groups = { viewer: "", pm: "", admin: "" };
  if (authMode === "entra") {
    oidc.tenantId = need("OIDC_TENANT_ID");
    oidc.clientId = need("OIDC_CLIENT_ID");
    oidc.clientSecret = need("OIDC_CLIENT_SECRET");
    oidc.redirectUri = need("OIDC_REDIRECT_URI");
    groups.viewer = need("GROUP_VIEWER");
    groups.pm = need("GROUP_PM");
    groups.admin = need("GROUP_ADMIN");
  }

  const devRole = (env.DEV_ROLE || "admin").toLowerCase();
  if (authMode === "dev" && !ROLES.includes(devRole)) problems.push(`DEV_ROLE must be one of ${ROLES.join(", ")}`);

  if (problems.length) {
    throw new Error(`configuration is not usable:\n  - ${problems.join("\n  - ")}`);
  }

  return Object.freeze({
    nodeEnv,
    isProd,
    port: Number(env.PORT || 8123),
    host: env.HOST || "127.0.0.1",
    authMode,
    sessionKey,
    sessionTtlHours: Number(env.SESSION_TTL_HOURS || 8),
    oidc: Object.freeze(oidc),
    groups: Object.freeze(groups),
    devRole,
    auditDir: env.AUDIT_DIR || "audit",
    logLevel: env.LOG_LEVEL || (isProd ? "info" : "debug"),
  });
}

export const ROLE_NAMES = ROLES;
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/config.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Write `.env.example`**

```bash
# Copy to .env and fill in. Never commit .env.
NODE_ENV=development
PORT=8123
HOST=127.0.0.1

# entra = real sign-in. dev = a fake local user; refused when NODE_ENV=production.
AUTH_MODE=dev
DEV_ROLE=admin

# 32+ random characters. Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
SESSION_KEY=
SESSION_TTL_HOURS=8

# From the Entra app registration
OIDC_TENANT_ID=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
OIDC_REDIRECT_URI=https://dashboard.example.local/auth/callback

# Entra group object IDs (not display names)
GROUP_VIEWER=
GROUP_PM=
GROUP_ADMIN=

AUDIT_DIR=audit
LOG_LEVEL=info
```

- [ ] **Step 6: Ignore the real env file and the audit directory**

Append to `.gitignore`:

```
# Local environment and audit output
.env
audit/
```

- [ ] **Step 7: Commit**

```bash
git add server/config.js test/config.test.js .env.example .gitignore
git commit -m "feat(config): validate environment at boot and fail with the missing name"
```

---

### Task 4: The session cookie

**Files:**
- Create: `server/auth/session.js`
- Test: `test/auth/session.test.js`

- [ ] **Step 1: Install the sealing library**

```bash
npm install iron-webcrypto@1.2.1
```

- [ ] **Step 2: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { sealSession, unsealSession } from "../../server/auth/session.js";

const KEY = "k".repeat(32);
const user = { sub: "abc", name: "A Person", email: "a@example.com", role: "pm" };

test("a sealed session round-trips", async () => {
  const sealed = await sealSession(user, KEY, 8);
  const opened = await unsealSession(sealed, KEY);
  assert.equal(opened.sub, "abc");
  assert.equal(opened.role, "pm");
});

test("the sealed value does not leak its contents", async () => {
  const sealed = await sealSession(user, KEY, 8);
  assert.ok(!sealed.includes("a@example.com"));
  assert.ok(!sealed.includes("pm"));
});

test("a tampered cookie is refused", async () => {
  const sealed = await sealSession(user, KEY, 8);
  const tampered = `${sealed.slice(0, -3)}aaa`;
  assert.equal(await unsealSession(tampered, KEY), null);
});

test("the wrong key cannot open it", async () => {
  const sealed = await sealSession(user, KEY, 8);
  assert.equal(await unsealSession(sealed, "j".repeat(32)), null);
});

test("an expired session is refused", async () => {
  const sealed = await sealSession(user, KEY, -1);
  assert.equal(await unsealSession(sealed, KEY), null);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test test/auth/session.test.js`
Expected: FAIL — cannot find `server/auth/session.js`.

- [ ] **Step 4: Implement `server/auth/session.js`**

```js
/**
 * The session lives in an encrypted cookie, so Phase 0 needs no session store.
 * Phase 1 adds an app_session table for revocation; the interface here does
 * not change when it does.
 */
import * as Iron from "iron-webcrypto";

const SEAL_DEFAULTS = Iron.defaults;

/**
 * @param {{sub: string, name: string, email: string, role: string}} user
 * @param {string} key at least 32 characters
 * @param {number} ttlHours negative values produce an already-expired session
 * @returns {Promise<string>} the cookie value
 */
export async function sealSession(user, key, ttlHours) {
  const payload = { ...user, exp: Date.now() + ttlHours * 3600 * 1000 };
  return Iron.seal(globalThis.crypto, payload, key, SEAL_DEFAULTS);
}

/**
 * @returns {Promise<object|null>} the session, or null if absent, tampered,
 *   sealed with another key, or expired
 */
export async function unsealSession(sealed, key) {
  if (!sealed) return null;
  try {
    const payload = await Iron.unseal(globalThis.crypto, sealed, key, SEAL_DEFAULTS);
    if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "gcio_session";
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/auth/session.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add server/auth/session.js test/auth/session.test.js package.json package-lock.json
git commit -m "feat(auth): encrypted session cookie with expiry and tamper rejection"
```

---

### Task 5: Group-to-role mapping

**Files:**
- Create: `server/auth/oidc.js` (mapping only in this task)
- Test: `test/auth/roles.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { roleFromGroups, RANK } from "../../server/auth/oidc.js";

const groups = { viewer: "g-view", pm: "g-pm", admin: "g-admin" };

test("the highest group wins when a person is in several", () => {
  assert.equal(roleFromGroups(["g-view", "g-pm", "g-admin"], groups), "admin");
  assert.equal(roleFromGroups(["g-view", "g-pm"], groups), "pm");
  assert.equal(roleFromGroups(["g-view"], groups), "viewer");
});

test("no recognised group means no access", () => {
  assert.equal(roleFromGroups(["someone-elses-group"], groups), null);
  assert.equal(roleFromGroups([], groups), null);
  assert.equal(roleFromGroups(undefined, groups), null);
});

test("roles rank so that admin outranks pm outranks viewer", () => {
  assert.ok(RANK.admin > RANK.pm);
  assert.ok(RANK.pm > RANK.viewer);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/auth/roles.test.js`
Expected: FAIL — cannot find `server/auth/oidc.js`.

- [ ] **Step 3: Implement the mapping half of `server/auth/oidc.js`**

```js
/**
 * Entra wiring: discovery, the sign-in URL, the callback exchange, and the
 * mapping from group claims to our three roles.
 */
import { Issuer, generators } from "openid-client";

export const RANK = { viewer: 1, pm: 2, admin: 3 };

/**
 * Highest role the person's group memberships grant.
 * @param {string[]|undefined} claimGroups group object IDs from the token
 * @param {{viewer: string, pm: string, admin: string}} configured
 * @returns {"viewer"|"pm"|"admin"|null} null means no access at all
 */
export function roleFromGroups(claimGroups, configured) {
  const held = new Set(Array.isArray(claimGroups) ? claimGroups : []);
  if (held.has(configured.admin)) return "admin";
  if (held.has(configured.pm)) return "pm";
  if (held.has(configured.viewer)) return "viewer";
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/auth/roles.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/auth/oidc.js test/auth/roles.test.js
git commit -m "feat(auth): map Entra group claims to viewer, pm and admin"
```

---

### Task 6: The Entra client and the sign-in routes

> **Do Task 7 first if you are working strictly in order.** This task mounts
> `attachUser` from `server/auth/middleware.js`, which Task 7 creates. The two
> are interchangeable; they are written in this order because the routes are
> easier to read first.

**Files:**
- Modify: `server/auth/oidc.js`
- Create: `server/auth/routes.js`
- Test: `test/api/auth-dev.test.js`

- [ ] **Step 1: Install the OIDC client and cookie parser**

```bash
npm install openid-client@5.7.0 cookie-parser@1.4.7
```

- [ ] **Step 2: Add the client half of `server/auth/oidc.js`**

Append to the file from Task 5:

```js
/**
 * Discover the tenant and build a client. Called once at boot; Entra's
 * discovery document is stable, so a failure here should stop the process
 * rather than be retried per request.
 * @param {object} cfg from loadConfig()
 */
export async function createOidcClient(cfg) {
  const issuer = await Issuer.discover(
    `https://login.microsoftonline.com/${cfg.oidc.tenantId}/v2.0`
  );
  return new issuer.Client({
    client_id: cfg.oidc.clientId,
    client_secret: cfg.oidc.clientSecret,
    redirect_uris: [cfg.oidc.redirectUri],
    response_types: ["code"],
  });
}

/** PKCE + state for one sign-in attempt. */
export function beginLogin(client, cfg) {
  const codeVerifier = generators.codeVerifier();
  const state = generators.state();
  const url = client.authorizationUrl({
    scope: "openid profile email",
    code_challenge: generators.codeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    redirect_uri: cfg.oidc.redirectUri,
  });
  return { url, codeVerifier, state };
}

/**
 * Exchange the code and turn the claims into our user shape.
 * @returns {{sub: string, name: string, email: string, role: string|null}}
 */
export async function completeLogin(client, cfg, params, { codeVerifier, state }) {
  const tokenSet = await client.callback(cfg.oidc.redirectUri, params, {
    code_verifier: codeVerifier,
    state,
  });
  const claims = tokenSet.claims();
  return {
    sub: claims.sub,
    name: claims.name || claims.preferred_username || "Unknown",
    email: claims.email || claims.preferred_username || "",
    role: roleFromGroups(claims.groups, cfg.groups),
  };
}
```

- [ ] **Step 3: Write the failing test (dev mode, no network)**

```js
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { Store } from "../../server/store.js";

const cfg = loadConfig({
  NODE_ENV: "test", AUTH_MODE: "dev", DEV_ROLE: "pm", SESSION_KEY: "k".repeat(32),
});

test("dev sign-in issues a session cookie and /api/me reports the role", async () => {
  const app = createApp({ store: new Store(), config: cfg });
  const agent = request.agent(app);

  const login = await agent.get("/auth/login").redirects(0);
  assert.equal(login.status, 302);
  assert.ok(login.headers["set-cookie"].join(";").includes("gcio_session"));

  const me = await agent.get("/api/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.role, "pm");
  assert.equal(me.body.authenticated, true);
});

test("signing out clears the cookie", async () => {
  const app = createApp({ store: new Store(), config: cfg });
  const agent = request.agent(app);
  await agent.get("/auth/login").redirects(0);

  // Echo the CSRF cookie back, the same way the browser client does. Written
  // this way from the start so the test still passes once Task 12 puts the
  // CSRF check in front of every mutation.
  const primed = await agent.get("/api/me");
  const jar = (primed.headers["set-cookie"] || []).join(";");
  const token = (jar.match(/gcio_csrf=([^;]+)/) || [])[1] || "";

  const out = await agent.post("/auth/logout").set("x-csrf-token", token).redirects(0);
  assert.ok([200, 302].includes(out.status));

  const me = await agent.get("/api/me");
  assert.equal(me.body.authenticated, false);
});
```

- [ ] **Step 4: Run it and watch it fail**

Run: `node --test test/api/auth-dev.test.js`
Expected: FAIL — no `/auth/login` route.

- [ ] **Step 5: Implement `server/auth/routes.js`**

```js
/**
 * Sign-in, callback, sign-out, and "who am I".
 *
 * AUTH_MODE=dev short-circuits the whole OIDC dance with a fixed local user so
 * the dashboard can be worked on without a tenant. loadConfig() refuses that
 * mode when NODE_ENV=production.
 */
import express from "express";
import { sealSession, unsealSession, SESSION_COOKIE } from "./session.js";
import { beginLogin, completeLogin } from "./oidc.js";

const PENDING_COOKIE = "gcio_login";

/**
 * @param {{config: object, client: object|null, audit: Function}} deps
 */
export function authRoutes({ config, client, audit }) {
  const router = express.Router();

  const cookieOptions = {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    path: "/",
  };

  router.get("/auth/login", async (req, res) => {
    if (config.authMode === "dev") {
      const user = { sub: "dev-user", name: "Local Developer", email: "dev@localhost", role: config.devRole };
      const sealed = await sealSession(user, config.sessionKey, config.sessionTtlHours);
      res.cookie(SESSION_COOKIE, sealed, { ...cookieOptions, maxAge: config.sessionTtlHours * 3600 * 1000 });
      audit({ actor: user.email, action: "signin.dev", subject: user.role, req });
      return res.redirect("/");
    }

    const { url, codeVerifier, state } = beginLogin(client, config);
    const pending = await sealSession({ codeVerifier, state, sub: "pending", name: "", email: "", role: null },
      config.sessionKey, 1);
    res.cookie(PENDING_COOKIE, pending, { ...cookieOptions, maxAge: 600000 });
    return res.redirect(url);
  });

  router.get("/auth/callback", async (req, res) => {
    const pending = await unsealSession(req.cookies?.[PENDING_COOKIE], config.sessionKey);
    if (!pending) return res.status(400).send("Sign-in expired. Start again from the dashboard.");
    res.clearCookie(PENDING_COOKIE, cookieOptions);

    let user;
    try {
      user = await completeLogin(client, config, req.query, pending);
    } catch (err) {
      audit({ actor: "unknown", action: "signin.failed", subject: err.message, req });
      return res.status(401).send("Sign-in failed.");
    }

    if (!user.role) {
      audit({ actor: user.email, action: "signin.denied", subject: "no mapped group", req });
      return res.status(403).send(
        "Your account is not a member of any group granted access to this dashboard."
      );
    }

    const sealed = await sealSession(user, config.sessionKey, config.sessionTtlHours);
    res.cookie(SESSION_COOKIE, sealed, { ...cookieOptions, maxAge: config.sessionTtlHours * 3600 * 1000 });
    audit({ actor: user.email, action: "signin", subject: user.role, req });
    return res.redirect("/");
  });

  router.post("/auth/logout", (req, res) => {
    audit({ actor: req.user?.email || "anonymous", action: "signout", subject: "", req });
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ ok: true });
  });

  router.get("/api/me", (req, res) => {
    if (!req.user) return res.json({ authenticated: false });
    const { sub, name, email, role } = req.user;
    res.json({ authenticated: true, sub, name, email, role });
  });

  return router;
}
```

- [ ] **Step 6: Mount it in `server/app.js`**

Add near the top of `createApp`, after `express.json`:

```js
import cookieParser from "cookie-parser";
import { authRoutes } from "./auth/routes.js";
import { attachUser } from "./auth/middleware.js";
```

and inside the factory:

```js
  const config = deps.config;
  const audit = deps.audit || (() => {});
  app.use(cookieParser());
  app.use(attachUser(config));
  app.use(authRoutes({ config, client: deps.oidcClient || null, audit }));
```

- [ ] **Step 7: Run the tests**

Run: `node --test test/api/auth-dev.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 8: Commit**

```bash
git add server/auth/oidc.js server/auth/routes.js server/app.js test/api/auth-dev.test.js package.json package-lock.json
git commit -m "feat(auth): Entra sign-in with PKCE, plus a dev mode for local work"
```

---

### Task 7: Enforcement middleware

**Files:**
- Create: `server/auth/middleware.js`
- Test: `test/auth/middleware.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { requireAuth, requireRole, attachUser } from "../../server/auth/middleware.js";
import { sealSession, SESSION_COOKIE } from "../../server/auth/session.js";
import cookieParser from "cookie-parser";
import { loadConfig } from "../../server/config.js";

const cfg = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", SESSION_KEY: "k".repeat(32) });

function appWith(role) {
  const app = express();
  app.use(cookieParser());
  app.use(attachUser(cfg));
  app.get("/open", (req, res) => res.json({ ok: true }));
  app.get("/private", requireAuth, (req, res) => res.json({ who: req.user.role }));
  app.post("/upload", requireAuth, requireRole("pm"), (req, res) => res.json({ ok: true }));
  app.get("/audit", requireAuth, requireRole("admin"), (req, res) => res.json({ ok: true }));
  return { app, role };
}

async function agentAs(role) {
  const { app } = appWith(role);
  const agent = request.agent(app);
  if (role) {
    const sealed = await sealSession(
      { sub: "u", name: "U", email: `${role}@example.com`, role }, cfg.sessionKey, 8);
    agent.jar.setCookie(`${SESSION_COOKIE}=${sealed}; Path=/`);
  }
  return agent;
}

test("an anonymous request is refused with 401", async () => {
  const agent = await agentAs(null);
  assert.equal((await agent.get("/private")).status, 401);
});

test("a viewer may read but may not upload", async () => {
  const agent = await agentAs("viewer");
  assert.equal((await agent.get("/private")).status, 200);
  assert.equal((await agent.post("/upload")).status, 403);
});

test("a pm may upload but may not read the audit log", async () => {
  const agent = await agentAs("pm");
  assert.equal((await agent.post("/upload")).status, 200);
  assert.equal((await agent.get("/audit")).status, 403);
});

test("an admin may do everything", async () => {
  const agent = await agentAs("admin");
  assert.equal((await agent.post("/upload")).status, 200);
  assert.equal((await agent.get("/audit")).status, 200);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/auth/middleware.test.js`
Expected: FAIL — cannot find `server/auth/middleware.js`.

- [ ] **Step 3: Implement `server/auth/middleware.js`**

```js
/**
 * Three middlewares: read the session onto req.user, demand a session, and
 * demand a minimum role. Ordering matters — attachUser must run first.
 */
import { unsealSession, SESSION_COOKIE } from "./session.js";
import { RANK } from "./oidc.js";

/** Populates req.user when a valid session cookie is present. Never rejects. */
export function attachUser(config) {
  return async (req, res, next) => {
    req.user = await unsealSession(req.cookies?.[SESSION_COOKIE], config.sessionKey);
    next();
  };
}

/** 401 when there is no session. */
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "authentication required", login: "/auth/login" });
  next();
}

/**
 * 403 unless the session's role is at least `minimum`.
 * @param {"viewer"|"pm"|"admin"} minimum
 */
export function requireRole(minimum) {
  const floor = RANK[minimum];
  return (req, res, next) => {
    const held = RANK[req.user?.role] || 0;
    if (held < floor) {
      return res.status(403).json({ error: `this action requires the ${minimum} role` });
    }
    next();
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/auth/middleware.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add server/auth/middleware.js test/auth/middleware.test.js
git commit -m "feat(auth): requireAuth and requireRole enforcement"
```

---

### Task 8: The audit sink

**Files:**
- Create: `server/audit.js`
- Test: `test/audit.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAudit } from "../server/audit.js";

test("events append as one JSON object per line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcio-audit-"));
  const audit = createAudit({ dir });

  audit({ actor: "a@example.com", action: "export", subject: "pptx weekly" });
  audit({ actor: "b@example.com", action: "signin", subject: "pm" });

  const file = path.join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);

  const first = JSON.parse(lines[0]);
  assert.equal(first.actor, "a@example.com");
  assert.equal(first.action, "export");
  assert.ok(first.at);
});

test("a failing sink never breaks the request", () => {
  const audit = createAudit({ dir: "/nonexistent/\u0000/path" });
  assert.doesNotThrow(() => audit({ actor: "x", action: "y", subject: "z" }));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/audit.test.js`
Expected: FAIL — cannot find `server/audit.js`.

- [ ] **Step 3: Implement `server/audit.js`**

```js
/**
 * Append-only audit sink.
 *
 * Phase 0 writes JSONL, one file per day. Phase 1 swaps the sink for the
 * audit_event table; call sites keep the same appendAudit(event) shape.
 * An audit failure must never fail the user's request — it is logged instead.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {{dir: string, logger?: {error: Function}}} options
 * @returns {(event: {actor: string, action: string, subject?: string, req?: object}) => void}
 */
export function createAudit({ dir, logger = console }) {
  return function appendAudit(event) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(),
        actor: event.actor || "anonymous",
        action: event.action,
        subject: event.subject || "",
        ip: event.req?.ip || "",
        userAgent: event.req?.get?.("user-agent") || "",
        requestId: event.req?.id || "",
      });
      const file = path.join(dir, `audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
      fs.appendFileSync(file, `${line}\n`, "utf8");
    } catch (err) {
      logger.error?.(`[audit] could not record ${event.action}: ${err.message}`);
    }
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/audit.test.js`
Expected: PASS — 2 tests.

- [ ] **Step 5: Commit**

```bash
git add server/audit.js test/audit.test.js
git commit -m "feat(audit): append-only JSONL sink that cannot fail a request"
```

---

### Task 9: Upload magic-byte guard

**Files:**
- Create: `server/uploadGuard.js`
- Test: `test/uploadGuard.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { looksLikeWorkbook } from "../server/uploadGuard.js";

test("a real xlsx is accepted", () => {
  const buf = fs.readFileSync("sample-data/GCIO_Portfolio_Master.xlsx");
  assert.equal(looksLikeWorkbook(buf, "GCIO_Portfolio_Master.xlsx").ok, true);
});

test("a text file renamed to .xlsx is refused", () => {
  const buf = Buffer.from("id,name\n1,not a workbook\n", "utf8");
  const verdict = looksLikeWorkbook(buf, "evil.xlsx");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not a real .xlsx/i);
});

test("csv is accepted on content as well as extension", () => {
  const buf = Buffer.from("Project ID,Project Name\nP-1,Thing\n", "utf8");
  assert.equal(looksLikeWorkbook(buf, "portfolio.csv").ok, true);
});

test("an executable is refused whatever it is called", () => {
  const buf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);
  assert.equal(looksLikeWorkbook(buf, "portfolio.xlsx").ok, false);
});

test("an unknown extension is refused", () => {
  assert.equal(looksLikeWorkbook(Buffer.from("x"), "notes.txt").ok, false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/uploadGuard.test.js`
Expected: FAIL — cannot find `server/uploadGuard.js`.

- [ ] **Step 3: Implement `server/uploadGuard.js`**

```js
/**
 * An upload must be what its extension claims. Extension checks alone let a
 * renamed executable into the watched folder, where a human might later run it.
 */
import path from "node:path";

const ZIP = [0x50, 0x4b, 0x03, 0x04];          // xlsx / xlsm are ZIP containers
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];         // legacy xls

const startsWith = (buf, sig) => sig.every((byte, i) => buf[i] === byte);

/**
 * @param {Buffer} buffer file contents
 * @param {string} filename original name
 * @returns {{ok: boolean, reason?: string}}
 */
export function looksLikeWorkbook(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (![".xlsx", ".xlsm", ".xls", ".csv"].includes(ext)) {
    return { ok: false, reason: `${ext || "that"} is not a supported workbook type` };
  }
  if (!buffer || buffer.length < 8) {
    return { ok: false, reason: "the file is empty or truncated" };
  }
  if (ext === ".xlsx" || ext === ".xlsm") {
    const ok = startsWith(buffer, ZIP) || startsWith(buffer, ZIP_EMPTY);
    return ok ? { ok: true } : { ok: false, reason: `not a real ${ext} — the contents are not a workbook` };
  }
  if (ext === ".xls") {
    const ok = startsWith(buffer, OLE2);
    return ok ? { ok: true } : { ok: false, reason: "not a real .xls — the contents are not a workbook" };
  }
  // CSV: reject anything with NUL bytes in the first block, which text never has.
  const head = buffer.subarray(0, 512);
  if (head.includes(0x00)) return { ok: false, reason: "not a real .csv — the contents are binary" };
  return { ok: true };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/uploadGuard.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add server/uploadGuard.js test/uploadGuard.test.js
git commit -m "feat(security): verify uploads by content, not just by extension"
```

---

### Task 10: Helmet, CSP, rate limits and CSRF

**Files:**
- Create: `server/security.js`
- Test: `test/api/security.test.js`

- [ ] **Step 1: Install**

```bash
npm install helmet@8.1.0 express-rate-limit@7.5.0
```

- [ ] **Step 2: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { applySecurity, issueCsrfToken, CSRF_COOKIE, CSRF_HEADER } from "../../server/security.js";
import { loadConfig } from "../../server/config.js";

const cfg = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", SESSION_KEY: "k".repeat(32) });

function app() {
  const a = express();
  a.use(cookieParser());
  a.use(express.json());
  applySecurity(a, cfg);
  a.get("/api/thing", (req, res) => res.json({ ok: true }));
  a.post("/api/thing", (req, res) => res.json({ ok: true }));
  return a;
}

test("security headers are set", async () => {
  const res = await request(app()).get("/api/thing");
  assert.ok(res.headers["content-security-policy"]);
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
});

test("a post without a CSRF token is refused", async () => {
  const res = await request(app()).post("/api/thing").send({});
  assert.equal(res.status, 403);
  assert.match(res.body.error, /csrf/i);
});

test("a post with a matching token and cookie is allowed", async () => {
  const agent = request.agent(app());
  const primed = await agent.get("/api/thing");
  const token = primed.headers["set-cookie"].join(";").match(new RegExp(`${CSRF_COOKIE}=([^;]+)`))[1];
  const res = await agent.post("/api/thing").set(CSRF_HEADER, token).send({});
  assert.equal(res.status, 200);
});

test("a token that does not match the cookie is refused", async () => {
  const agent = request.agent(app());
  await agent.get("/api/thing");
  const res = await agent.post("/api/thing").set(CSRF_HEADER, "not-the-token").send({});
  assert.equal(res.status, 403);
});

test("issueCsrfToken produces unguessable values", () => {
  const a = issueCsrfToken();
  const b = issueCsrfToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test test/api/security.test.js`
Expected: FAIL — cannot find `server/security.js`.

- [ ] **Step 4: Implement `server/security.js`**

```js
/**
 * Transport and request hardening.
 *
 * CSRF uses the double-submit pattern: a readable cookie plus a header the
 * browser will only send from our own origin. Combined with SameSite=Lax on
 * the session cookie, that is enough for a same-origin app with no CORS.
 */
import crypto from "node:crypto";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

export const CSRF_COOKIE = "gcio_csrf";
export const CSRF_HEADER = "x-csrf-token";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export const issueCsrfToken = () => crypto.randomBytes(32).toString("base64url");

/** @param {import('express').Express} app @param {object} config */
export function applySecurity(app, config) {
  app.set("trust proxy", "loopback");

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The bundler inlines a small style block; fonts ship with the client.
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'", "https://login.microsoftonline.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd ? { maxAge: 15552000, includeSubDomains: true } : false,
  }));
  app.use(helmet.frameguard({ action: "sameorigin" }));

  app.use((req, res, next) => {
    if (!req.cookies?.[CSRF_COOKIE]) {
      res.cookie(CSRF_COOKIE, issueCsrfToken(), {
        httpOnly: false, secure: config.isProd, sameSite: "lax", path: "/",
      });
    }
    next();
  });

  app.use((req, res, next) => {
    if (SAFE.has(req.method)) return next();
    if (req.path === "/auth/callback") return next();
    const cookie = req.cookies?.[CSRF_COOKIE];
    const header = req.get(CSRF_HEADER);
    if (!cookie || !header || cookie !== header) {
      return res.status(403).json({ error: "CSRF token missing or does not match" });
    }
    next();
  });

  const limiter = (windowMs, max, message) => rateLimit({
    windowMs, max, standardHeaders: true, legacyHeaders: false,
    message: { error: message },
  });

  app.use("/auth/login", limiter(15 * 60 * 1000, 30, "too many sign-in attempts, try again shortly"));
  app.use("/api/ingest/upload", limiter(60 * 60 * 1000, 60, "upload limit reached for this hour"));
  app.use("/api/export", limiter(60 * 60 * 1000, 120, "export limit reached for this hour"));
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/api/security.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```bash
git add server/security.js test/api/security.test.js package.json package-lock.json
git commit -m "feat(security): helmet, CSP, CSRF double-submit and rate limits"
```

---

### Task 11: Logging with request ids, and health endpoints

**Files:**
- Create: `server/logger.js`
- Create: `server/health.js`
- Test: `test/api/health.test.js`

- [ ] **Step 1: Install**

```bash
npm install pino@9.6.0 pino-http@10.4.0
```

- [ ] **Step 2: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { healthRoutes } from "../../server/health.js";
import { Store } from "../../server/store.js";
import { ingestDirectory } from "../../server/ingest.js";

test("healthz is always ok while the process runs", async () => {
  const app = express();
  app.use(healthRoutes({ store: new Store(), startedAt: Date.now(), maxIngestAgeMs: 60000 }));
  const res = await request(app).get("/healthz");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});

test("readyz is not ready when nothing has ever been ingested", async () => {
  const app = express();
  app.use(healthRoutes({ store: new Store(), startedAt: Date.now(), maxIngestAgeMs: 60000 }));
  const res = await request(app).get("/readyz");
  assert.equal(res.status, 503);
  assert.equal(res.body.ready, false);
  assert.match(res.body.reason, /no data/i);
});

test("readyz is ready with fresh data", async () => {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  store.lastIngestAt = new Date().toISOString();
  const app = express();
  app.use(healthRoutes({ store, startedAt: Date.now(), maxIngestAgeMs: 60000 }));
  const res = await request(app).get("/readyz");
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, true);
  assert.equal(res.body.projects, store.projectCount);
});

test("readyz turns unready when the last ingest is too old", async () => {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  store.lastIngestAt = new Date(Date.now() - 10 * 60000).toISOString();
  const app = express();
  app.use(healthRoutes({ store, startedAt: Date.now(), maxIngestAgeMs: 60000 }));
  const res = await request(app).get("/readyz");
  assert.equal(res.status, 503);
  assert.match(res.body.reason, /stale/i);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test test/api/health.test.js`
Expected: FAIL — cannot find `server/health.js`.

- [ ] **Step 4: Implement `server/logger.js`**

```js
/**
 * Structured logs with a correlation id per request. Row contents are never
 * logged — only counts, ids and outcomes.
 */
import crypto from "node:crypto";
import pino from "pino";
import pinoHttp from "pino-http";

export function createLogger(config) {
  return pino({
    level: config.logLevel,
    redact: { paths: ["req.headers.cookie", "req.headers.authorization"], remove: true },
  });
}

export function requestLogging(logger) {
  return pinoHttp({
    logger,
    genReqId: (req) => req.headers["x-request-id"] || crypto.randomUUID(),
    customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
  });
}
```

- [ ] **Step 5: Implement `server/health.js`**

```js
/**
 * Liveness and readiness.
 *
 * readyz answers "should this instance be serving": it needs data, and that
 * data must be fresh enough that the watcher is evidently still working.
 * Monitoring alerts on this, so it must never be optimistic.
 */
import express from "express";

/**
 * @param {{store: object, startedAt: number, maxIngestAgeMs?: number, version?: string}} deps
 */
export function healthRoutes({ store, startedAt, maxIngestAgeMs = 26 * 3600 * 1000, version = "1.0.0" }) {
  const router = express.Router();

  router.get("/healthz", (req, res) => {
    res.json({ status: "ok", uptimeSec: Math.round((Date.now() - startedAt) / 1000), version });
  });

  router.get("/readyz", (req, res) => {
    if (!store.projectCount || !store.lastIngestAt) {
      return res.status(503).json({ ready: false, reason: "no data has been ingested yet" });
    }
    const ageMs = Date.now() - new Date(store.lastIngestAt).getTime();
    if (ageMs > maxIngestAgeMs) {
      return res.status(503).json({
        ready: false,
        reason: `last ingest is stale (${Math.round(ageMs / 60000)} minutes ago)`,
        projects: store.projectCount,
      });
    }
    res.json({ ready: true, projects: store.projectCount, lastIngestAt: store.lastIngestAt });
  });

  return router;
}
```

- [ ] **Step 6: Run the tests**

Run: `node --test test/api/health.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 7: Commit**

```bash
git add server/logger.js server/health.js test/api/health.test.js package.json package-lock.json
git commit -m "feat(ops): structured logging with request ids, and health endpoints"
```

---

### Task 12: Wire everything into the app and protect every route

**Files:**
- Modify: `server/app.js`
- Modify: `server/index.js`
- Test: `test/api/authz-matrix.test.js`

- [ ] **Step 1: Write the failing test — the authorisation matrix**

```js
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { Store } from "../../server/store.js";
import { ingestDirectory } from "../../server/ingest.js";
import { sealSession, SESSION_COOKIE } from "../../server/auth/session.js";
import { CSRF_COOKIE, CSRF_HEADER } from "../../server/security.js";

const cfg = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", SESSION_KEY: "k".repeat(32) });

function makeApp() {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  return createApp({ store, config: cfg, audit: () => {} });
}

async function as(app, role) {
  const agent = request.agent(app);
  if (role) {
    const sealed = await sealSession({ sub: "u", name: role, email: `${role}@x`, role }, cfg.sessionKey, 8);
    agent.jar.setCookie(`${SESSION_COOKIE}=${sealed}; Path=/`);
  }
  return agent;
}

/** Prime the CSRF cookie and return the header value to echo back. */
async function csrf(agent) {
  const res = await agent.get("/api/health");
  const cookies = res.headers["set-cookie"] || [];
  const match = cookies.join(";").match(new RegExp(`${CSRF_COOKIE}=([^;]+)`));
  return match ? match[1] : "";
}

test("anonymous callers cannot read any portfolio data", async () => {
  const app = makeApp();
  const agent = await as(app, null);
  for (const url of ["/api/summary?period=weekly", "/api/projects", "/api/meta", "/api/template"]) {
    assert.equal((await agent.get(url)).status, 401, `${url} should be 401`);
  }
});

test("health endpoints stay open for monitoring", async () => {
  const app = makeApp();
  const agent = await as(app, null);
  assert.equal((await agent.get("/healthz")).status, 200);
  assert.equal((await agent.get("/readyz")).status, 200);
});

test("a viewer can read and export but cannot upload", async () => {
  const app = makeApp();
  const agent = await as(app, "viewer");
  const token = await csrf(agent);

  assert.equal((await agent.get("/api/summary?period=weekly")).status, 200);
  assert.equal((await agent.post("/api/export/pptx").set(CSRF_HEADER, token)
    .send({ period: "weekly", date: "2026-08-23" })).status, 200);
  assert.equal((await agent.post("/api/ingest/upload").set(CSRF_HEADER, token)).status, 403);
});

test("a pm can upload", async () => {
  const app = makeApp();
  const agent = await as(app, "pm");
  const token = await csrf(agent);
  const res = await agent.post("/api/ingest/upload")
    .set(CSRF_HEADER, token)
    .attach("files", "sample-data/GCIO_Portfolio_Master.xlsx");
  assert.equal(res.status, 200);
});

test("an upload that is not a workbook is rejected with a readable reason", async () => {
  const app = makeApp();
  const agent = await as(app, "pm");
  const token = await csrf(agent);
  const res = await agent.post("/api/ingest/upload")
    .set(CSRF_HEADER, token)
    .attach("files", Buffer.from("not a workbook"), "evil.xlsx");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.match(res.body.errors[0].error, /not a real/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/api/authz-matrix.test.js`
Expected: FAIL — data routes still answer 200 anonymously.

- [ ] **Step 3: Rewrite the head of `createApp` in `server/app.js`**

```js
export function createApp(deps) {
  const { store, config } = deps;
  const dataDir = deps.dataDir || path.resolve("data");
  const clientDist = deps.clientDist || path.resolve("client", "dist");
  const startedAt = deps.startedAt || Date.now();
  const audit = deps.audit || (() => {});

  const app = express();
  app.use(cookieParser());
  app.use(express.json({ limit: "40mb" }));

  // Monitoring must not need a session, so health mounts before auth.
  app.use(healthRoutes({ store, startedAt }));

  applySecurity(app, config);
  app.use(attachUser(config));
  app.use(authRoutes({ config, client: deps.oidcClient || null, audit }));

  // Everything under /api except /api/me now needs a session.
  app.use("/api", (req, res, next) => (req.path === "/me" ? next() : requireAuth(req, res, next)));
```

Add the imports at the top of the file:

```js
import cookieParser from "cookie-parser";
import { applySecurity } from "./security.js";
import { attachUser, requireAuth, requireRole } from "./auth/middleware.js";
import { authRoutes } from "./auth/routes.js";
import { healthRoutes } from "./health.js";
import { looksLikeWorkbook } from "./uploadGuard.js";
```

- [ ] **Step 4: Put the role check and the content check on the upload route**

Replace the upload route's signature and add the guard inside its loop:

```js
  app.post("/api/ingest/upload", requireRole("pm"), upload.array("files", 20), wrap(async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no files received (multipart field name: files)" });
    const ingested = [];
    const errors = [];
    for (const f of files) {
      const safe = path.basename(f.originalname).replace(/[^\w.\- ()]/g, "_");

      const verdict = looksLikeWorkbook(f.buffer, safe);
      if (!verdict.ok) {
        errors.push({ file: safe, error: verdict.reason });
        audit({ actor: req.user.email, action: "upload.rejected", subject: `${safe}: ${verdict.reason}`, req });
        continue;
      }

      const parsed = ingestBuffer(f.buffer, safe, dayjs().format("YYYY-MM-DD"));
      if (!parsed.ok) {
        errors.push({ file: safe, error: parsed.error });
        continue;
      }
      const finalPath = path.join(dataDir, safe);
      const tmpPath = `${finalPath}.uploading`;
      fs.writeFileSync(tmpPath, f.buffer);
      fs.renameSync(tmpPath, finalPath);
      ingested.push({ file: safe, projects: parsed.projects.length });
      audit({ actor: req.user.email, action: "upload", subject: `${safe} (${parsed.projects.length} projects)`, req });
    }
    res.json({ ok: errors.length === 0, ingested, errors });
  }));
```

- [ ] **Step 5: Audit every export**

In the export route, immediately before `res.send(...)`:

```js
  audit({ actor: req.user.email, action: "export", subject: `${format} ${period} ${date}`, req });
```

- [ ] **Step 6: Pass config and audit from `server/index.js`**

```js
import { loadConfig } from "./config.js";
import { createLogger, requestLogging } from "./logger.js";
import { createAudit } from "./audit.js";
import { createOidcClient } from "./auth/oidc.js";

const config = loadConfig(process.env);
const logger = createLogger(config);
const audit = createAudit({ dir: path.join(ROOT, config.auditDir), logger });
const oidcClient = config.authMode === "entra" ? await createOidcClient(config) : null;

const app = createApp({
  store, config, audit, oidcClient,
  dataDir: DATA_DIR,
  clientDist: path.join(ROOT, "client", "dist"),
});
app.use(requestLogging(logger));

app.listen(config.port, config.host, () => {
  logger.info(`GCIO Project Intelligence listening on http://${config.host}:${config.port} (auth: ${config.authMode})`);
  logger.info(`watching ${DATA_DIR} for workbooks`);
});
```

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS — every test, including the five in the matrix.

- [ ] **Step 8: Commit**

```bash
git add server/app.js server/index.js test/api/authz-matrix.test.js
git commit -m "feat(security): require authentication for every data route and audit uploads and exports"
```

---

### Task 13: Client — sign-in state, CSRF, and role-aware UI

**Files:**
- Modify: `client/src/lib/api.js`
- Modify: `client/src/App.jsx`
- Modify: `client/src/components/TopBar.jsx`

- [ ] **Step 1: Teach the fetch helpers about CSRF and 401**

In `client/src/lib/api.js`, add near the top:

```js
/** The CSRF cookie is readable by design; echo it back on every mutation. */
function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)gcio_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/** A 401 means the session has gone; send the user to sign in again. */
function handleUnauthorized(res) {
  if (res.status === 401) {
    window.location.href = "/auth/login";
    return true;
  }
  return false;
}
```

Then in `getJSON`, after the fetch:

```js
  if (handleUnauthorized(res)) return new Promise(() => {}); // navigation in flight
```

and in `postJSON`, `downloadExport` and `uploadWorkbooks`, add the header:

```js
    headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken() },
```

For `uploadWorkbooks`, which posts FormData, set only the CSRF header:

```js
  const res = await fetch("/api/ingest/upload", {
    method: "POST",
    headers: { "x-csrf-token": csrfToken() },
    body: form,
  });
```

- [ ] **Step 2: Fetch the signed-in user in `client/src/App.jsx`**

Add to the state block:

```js
  const [me, setMe] = useState(null);
```

Add an effect beside the existing ones:

```js
  useEffect(() => {
    getJSON("/api/me").then(setMe).catch(() => setMe({ authenticated: false }));
  }, []);
```

Pass it to the top bar:

```js
      <TopBar
        period={period}
        onPeriod={setPeriod}
        date={date}
        onDate={setDate}
        theme={theme}
        onTheme={setTheme}
        font={font}
        onFont={setFont}
        health={health}
        me={me}
        onUpload={() => setUploadOpen(true)}
      />
```

- [ ] **Step 3: Show the user and gate Upload in `client/src/components/TopBar.jsx`**

Change the signature:

```js
export default function TopBar({ period, onPeriod, date, onDate, theme, onTheme, font, onFont, health, me, onUpload }) {
```

Replace the Upload button with a gated one, and add the identity chip beside it:

```jsx
        {(me?.role === "pm" || me?.role === "admin") && (
          <button type="button" className="btn" onClick={onUpload}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
            Upload
          </button>
        )}

        {me?.authenticated && (
          <span className="who" title={`${me.email} · ${me.role}`}>
            {me.name} <i>{me.role}</i>
          </span>
        )}
```

- [ ] **Step 4: Style the identity chip in `client/src/styles.css`**

```css
.who {
  font-size: 11.5px; color: var(--ink-2); display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border: 1px solid var(--hairline-soft); border-radius: 999px;
}
.who i {
  font-style: normal; font-size: 9.5px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--accent-ink); background: var(--accent); border-radius: 999px; padding: 1px 7px; font-weight: 700;
}
```

- [ ] **Step 5: Build and check by hand**

```bash
npm run build
```

Then with `AUTH_MODE=dev DEV_ROLE=viewer npm start`, open `http://localhost:8123`:
Expected: the dashboard loads, the identity chip reads "Local Developer viewer",
and the Upload button is absent. Restart with `DEV_ROLE=pm` and it reappears.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/api.js client/src/App.jsx client/src/components/TopBar.jsx client/src/styles.css
git commit -m "feat(client): sign-in state, CSRF header, and role-gated upload"
```

---

### Task 14: Windows service and IIS

**Files:**
- Create: `deploy/install-service.ps1`
- Create: `deploy/iis-site.md`
- Modify: `README.md`

- [ ] **Step 1: Write `deploy/install-service.ps1`**

```powershell
<#
  Installs GCIO Project Intelligence as a Windows service using NSSM.
  Run from an elevated PowerShell prompt in the repository root:

      .\deploy\install-service.ps1 -EnvFile C:\gcio\.env

  NSSM must already be on PATH: https://nssm.cc/download
#>
param(
  [string]$ServiceName = "GCIOProjectIntelligence",
  [string]$EnvFile = "$PSScriptRoot\..\.env",
  [string]$NodeExe = (Get-Command node).Source
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$entry = Join-Path $root "server\index.js"
$logDir = Join-Path $root "logs"

if (-not (Test-Path $EnvFile)) { throw "environment file not found: $EnvFile" }
New-Item -ItemType Directory -Force $logDir | Out-Null

nssm install $ServiceName $NodeExe $entry
nssm set $ServiceName AppDirectory $root
nssm set $ServiceName AppStdout (Join-Path $logDir "service-out.log")
nssm set $ServiceName AppStderr (Join-Path $logDir "service-err.log")
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateBytes 10485760
nssm set $ServiceName Start SERVICE_AUTO_START
nssm set $ServiceName AppExit Default Restart
nssm set $ServiceName AppRestartDelay 5000

# Environment: NSSM takes NAME=VALUE pairs separated by newlines.
$pairs = Get-Content $EnvFile | Where-Object { $_ -match "^\s*[A-Z_]+=" -and $_ -notmatch "^\s*#" }
nssm set $ServiceName AppEnvironmentExtra ($pairs -join "`n")

Start-Service $ServiceName
Get-Service $ServiceName
Write-Host "Installed. Check readiness: curl http://127.0.0.1:8123/readyz"
```

- [ ] **Step 2: Write `deploy/iis-site.md`**

````markdown
# IIS in front of the dashboard

The Node process listens on `127.0.0.1:8123` and never terminates TLS itself.
IIS holds the certificate and proxies to it.

## Prerequisites

- IIS with **URL Rewrite** and **Application Request Routing** installed
- The corporate certificate in the machine store, bound to the site's host name

## Steps

1. Create a site — e.g. `GCIO Dashboard` — bound to `https://dashboard.<domain>`
   on port 443 with the certificate. Remove any port 80 binding, or add a
   rewrite rule that redirects http to https.
2. Enable the proxy: **IIS Manager → server node → Application Request Routing
   Cache → Server Proxy Settings → Enable proxy**.
3. Put this `web.config` in the site root:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Proxy to GCIO" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:8123/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <!-- 20 workbooks at 25 MB, plus multipart overhead -->
        <requestLimits maxAllowedContentLength="545259520" />
      </requestFiltering>
    </security>
    <httpProtocol>
      <customHeaders>
        <remove name="X-Powered-By" />
      </customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
```

4. Allow the `X-Forwarded-Proto` server variable: **URL Rewrite → View Server
   Variables → Add → `HTTP_X_FORWARDED_PROTO`**.
5. Register the redirect URI in the Entra app registration:
   `https://dashboard.<domain>/auth/callback`.

## Verify

```powershell
curl.exe -I https://dashboard.<domain>/healthz     # 200
curl.exe -I http://127.0.0.1:8123/healthz          # 200, localhost only
```

From another machine, `http://<server>:8123` must **fail** — the Node process
binds loopback only.
````

- [ ] **Step 3: Add an operations section to `README.md`**

Insert before the Layout section:

```markdown
## Running it for real

Phase 0 adds sign-in and hardening. See
`docs/superpowers/specs/2026-08-24-backend-production-design.md`.

1. Copy `.env.example` to `.env` and fill it in. `SESSION_KEY` must be 32+
   random characters:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. Register the app in Entra ID; set `OIDC_*` and the three `GROUP_*` object IDs.
3. `npm ci && npm run build`
4. Install the service: `.\deploy\install-service.ps1`
5. Put IIS in front for TLS: `deploy/iis-site.md`

Local development without a tenant: `AUTH_MODE=dev DEV_ROLE=pm npm start`.
That mode is refused when `NODE_ENV=production`.
```

- [ ] **Step 4: Commit**

```bash
git add deploy/install-service.ps1 deploy/iis-site.md README.md
git commit -m "docs(deploy): Windows service installer and IIS TLS runbook"
```

---

### Task 15: Close out the phase

**Files:**
- Modify: `docs/superpowers/specs/2026-08-24-backend-production-design.md`

- [ ] **Step 1: Run everything**

```bash
npm test
npm run build
node scripts/pptx-audit.mjs exports/api_pptx.pptx
```

Expected: all tests pass; the build succeeds; the audit reports 0 problems.
Regenerate the deck first if `exports/` is empty — start the server and
`curl -X POST http://localhost:8123/api/export/pptx ...` as an authenticated
user, or call `buildPptxDeck` directly as `scripts/pptx-smoketest.mjs` does.

- [ ] **Step 2: Verify the two behaviours the phase exists for**

```bash
# 1. Anonymous access is refused
curl -i http://127.0.0.1:8123/api/summary?period=weekly     # expect 401

# 2. The process is not reachable off-box
#    From another machine:
curl -i http://<server>:8123/healthz                         # expect connection refused
```

- [ ] **Step 3: Mark P0 done in the spec**

In the Rollout table, change the P0 row's status to `delivered 2026-__-__`
with the commit range.

- [ ] **Step 4: Commit and tag**

```bash
git add docs/superpowers/specs/2026-08-24-backend-production-design.md
git commit -m "docs(spec): mark Phase 0 delivered"
git tag -a v1.1.0-p0 -m "Phase 0: authenticated, hardened, service-packaged pilot"
git push origin main --tags
```

---

## Self-review against the spec

| Spec requirement | Task |
| --- | --- |
| Entra OIDC + PKCE | 6 |
| Session cookie, encrypted, expiring | 4 |
| Three roles from Entra groups | 5, 7 |
| Audit of sign-in, upload, export | 8, 12 |
| helmet + CSP | 10 |
| CSRF | 10 |
| Rate limits | 10 |
| Upload magic bytes | 9, 12 |
| Bind loopback, trust proxy from localhost | 10 (`trust proxy`), 12 (`listen(host)`), 14 (IIS) |
| Secrets from environment, fail loudly | 3 |
| pino logs with correlation id | 11 |
| `/healthz`, `/readyz` | 11 |
| Windows service | 14 |
| Domain tests, API authz tests, upload tests, export gate | 2, 7, 9, 12, 15 |
| `STORE=memory` demo path keeps working | 1, 12 (every test uses the in-memory store) |

**Deferred to later phases by design:** PostgreSQL, the file vault, history and
trends, `question_asked` ageing, `/metrics`, the advisory-lock role split,
worker-thread parsing, and backup/restore drills. Phase 0 changes no ranking
rule and no export layout.
