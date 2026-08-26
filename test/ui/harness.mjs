/**
 * A real browser against the real client, served by a real server.
 *
 * STORE=memory and AUTH_MODE=dev, so no database and no directory are needed
 * and the bundled sample portfolio is what renders. The port is ephemeral
 * because this machine already has something on 8123 and a test suite must
 * not care what else is running.
 *
 * This is the harness Tasks 2-5 are written against. Exported surface:
 *   - findBrowser()               locate a Chrome/Edge executable
 *   - startDashboard(opts)        boot the app, sign in, return a page
 *   - startDashboardSignedOut()   boot the app, stop at the sign-in screen
 *
 * Both start functions resolve to { page, baseUrl, close }. `close()` does
 * not resolve until the spawned server process has actually exited -
 * killing it is not the same thing, and a leaked node process per test file
 * is how a suite ends up unable to bind a port.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

/**
 * Where Chrome is. puppeteer-core does not download one, so this has to say.
 *
 * Four scripts hardcoded the same path before this existed; a machine without
 * Chrome in that exact location failed with a message that did not mention
 * Chrome. Look in the usual places, allow an override, and if none is found
 * say what to do about it.
 */
const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

export function findBrowser() {
  const found = CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      "no Chrome or Edge found. Set CHROME_PATH to the executable, e.g.\n" +
      "  CHROME_PATH='C:/Program Files/Google/Chrome/Application/chrome.exe'\n" +
      `looked in:\n${CANDIDATES.map((p) => `  ${p}`).join("\n")}`
    );
  }
  return found;
}

/** An OS-assigned free port, so two runs can never collide. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Walk a tree the same way `annotateChanges` in server/sections.js does,
 * keying on `node.projectId || node.id`. The stub layer has to find a
 * project id by the same convention the real annotator uses, rather than
 * inventing its own.
 */
function firstProjectId(node, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = firstProjectId(entry, seen);
      if (found) return found;
    }
    return null;
  }
  const id = node.projectId || node.id;
  if (typeof id === "string") return id;
  for (const value of Object.values(node)) {
    const found = firstProjectId(value, seen);
    if (found) return found;
  }
  return null;
}

/** Attach `change` to every node in the tree carrying the given project id. */
function attachChange(node, projectId, change, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const entry of node) attachChange(entry, projectId, change, seen);
    return;
  }
  const id = node.projectId || node.id;
  if (id === projectId) node.change = change;
  for (const value of Object.values(node)) attachChange(value, projectId, change, seen);
}

/** Plain recursive merge: objects merge key-by-key, anything else (including
 *  arrays) from the patch replaces the base outright. */
function deepMerge(base, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = { ...(base && typeof base === "object" ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(base?.[key], value);
  }
  return out;
}

/**
 * Turn a stub option into the body a test should see, given the server's
 * genuine response.
 *
 * Two shapes are supported:
 *   - `{ changeForFirstProject: <change> }` finds the first project id in
 *     the real response (same `projectId || id` convention as the server's
 *     own annotator) and attaches that change to every node carrying it.
 *   - anything else is deep-merged over the real response, key by key.
 */
function shapeStub(real, stubs) {
  if (stubs && typeof stubs === "object" && "changeForFirstProject" in stubs) {
    const clone = structuredClone(real);
    const id = firstProjectId(clone);
    if (!id) throw new Error("changeForFirstProject: no project id found in the real /api/summary response");
    attachChange(clone, id, stubs.changeForFirstProject);
    return clone;
  }
  return deepMerge(real, stubs);
}

/**
 * Intercept /api/summary and merge a stub over the real response, so a test
 * gets genuine sample data plus the history the sample data cannot have.
 *
 * The real response is fetched directly from the server (not through the
 * page), forwarding the browser's own request headers - including its
 * session cookie - so the fetch is authenticated exactly as the page's
 * request would have been.
 */
async function applyStubs(page, stubs) {
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const url = new URL(req.url());
    if (req.method() !== "GET" || url.pathname !== "/api/summary") {
      req.continue();
      return;
    }
    try {
      const headers = { ...req.headers() };
      delete headers.host;
      delete headers.connection;
      const upstream = await fetch(req.url(), { headers });
      const real = await upstream.json();
      const body = JSON.stringify(shapeStub(real, stubs));
      await req.respond({
        status: upstream.status,
        contentType: "application/json",
        body,
      });
    } catch (err) {
      // A broken stub should fail the test loudly, not hang the request.
      await req.respond({
        status: 599,
        contentType: "text/plain",
        body: `harness stub error: ${err.stack || err.message}`,
      });
    }
  });
}

/**
 * Sign in through the real form. Read from `client/src/components/SignIn.jsx`:
 * the SSO button carries class `signin-sso` in addition to `signin-submit`,
 * so `.signin-submit` alone matches both buttons. `scripts/e2e-sso.mjs`
 * sidesteps this with `.signin button[type="submit"]`, which only ever
 * matches the real submit - use that here too, and do not assume SSO is off.
 */
async function signIn(page, { username = "pat", password = "whatever" } = {}) {
  await page.waitForSelector(".signin input");
  await page.type('input[autocomplete="username"]', username);
  await page.type('input[type="password"]', password);
  await Promise.all([
    page.click('.signin button[type="submit"]'),
    page.waitForSelector(".sec-nav", { timeout: 20_000 }),
  ]);
}

/** Boot the server and browser, land on the sign-in screen. Shared by both
 *  start functions below. */
async function boot({ role = "admin", stubs = null } = {}) {
  const port = await freePort();
  const server = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      STORE: "memory",
      AUTH_MODE: "dev",
      DEV_ROLE: role,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const onOut = (chunk) => { output += String(chunk); };
  const onErr = (chunk) => { output += String(chunk); };
  server.stdout.on("data", onOut);
  server.stderr.on("data", onErr);

  /* Wait for the line the server actually prints, not a fixed delay. A sleep
     long enough to be safe on a slow machine is long enough to waste minutes
     across a suite. */
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`server did not start within 30s. Output so far:\n${output}`));
    }, 30_000);
    const onData = (chunk) => {
      if (String(chunk).includes("listening on")) {
        clearTimeout(timer);
        server.stdout.off("data", onData);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}. Output so far:\n${output}`));
    });
  });

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });

  if (stubs) await applyStubs(page, stubs);

  const baseUrl = `http://127.0.0.1:${port}`;
  await page.goto(baseUrl, { waitUntil: "networkidle0" });

  return {
    page,
    baseUrl,
    async close() {
      await browser.close();
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill();
      /* Killing is not the same as having exited; a leaked node process per
         test file is how a suite ends up unable to bind a port. */
      await exited;
    },
  };
}

/**
 * Boot the app and open a signed-in page.
 * @param {{role?: "viewer"|"pm"|"admin", stubs?: object}} [options] stubs are
 *        applied via a request interceptor, so a test can render states the
 *        sample data cannot produce - history, a specific change, etc.
 * @returns {Promise<{page: object, baseUrl: string, close: () => Promise<void>}>}
 */
export async function startDashboard({ role = "admin", stubs = null } = {}) {
  const app = await boot({ role, stubs });
  await signIn(app.page);
  return app;
}

/**
 * Boot the app and stop at the sign-in screen, for tests of the sign-in
 * gate itself (Task 4). No credentials are submitted.
 * @param {{role?: "viewer"|"pm"|"admin"}} [options]
 * @returns {Promise<{page: object, baseUrl: string, close: () => Promise<void>}>}
 */
export async function startDashboardSignedOut({ role = "admin" } = {}) {
  const app = await boot({ role, stubs: null });
  await app.page.waitForSelector(".signin input");
  return app;
}
