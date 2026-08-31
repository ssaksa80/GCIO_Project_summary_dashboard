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
 *
 * `close()` itself cannot be trusted to be quick or even to succeed on the
 * happy path - a ten-run and a concurrent-load run both found a real,
 * intermittent leak: under load, `browser.close()` can hang indefinitely,
 * and `child.kill()` on Windows terminates only the process node spawned,
 * not the renderer/GPU processes underneath it, so a hung close() left a
 * full Chrome tree and a live server behind with the test reporting a clean
 * pass. `close()` now bounds every wait with a timeout and escalates to a
 * `taskkill /T /F` tree-kill rather than trusting a single polite attempt,
 * and is idempotent.
 *
 * A test that throws before ever reaching its own close() needed a second
 * mechanism, and the obvious one - a `process.on("exit")` handler - turned
 * out not to be enough on its own: Node only fires "exit" once its event
 * loop drains, and an open Puppeteer connection to a live browser blocks
 * that drain indefinitely (confirmed directly: a bare `puppeteer.launch()`
 * with no matching `close()` kept `node --test` from exiting at all). The
 * exit handler below stays as a genuine last resort, but the real fix is
 * registering `node:test`'s own `after()` hook the moment an app boots -
 * that hook is awaited by the test runner itself before it considers a
 * file done, independent of whatever else is keeping the process's event
 * loop alive, so it reaps a crashed test's app before the process ever
 * needs to drain naturally.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

/**
 * Every booted { browser, server } pair still open, so the after() hook and
 * the exit handler below can reap anything a crashed test file would
 * otherwise strand. Entries are removed once their own close() has run,
 * successfully or not.
 */
const active = new Set();

/**
 * Where Chrome's profile lives. Owned by this harness, not by puppeteer.
 *
 * Given no `userDataDir`, puppeteer creates a temporary profile and removes it
 * on a clean `browser.close()` - a promise this harness cannot keep, because it
 * deliberately tree-kills a close that hangs under load (see the header). A
 * tree-killed Chrome never cleans up after itself, and a `close()` that never
 * returned never cleans up either, so the directory ends up owned by nobody:
 * fourteen of them, 256MB, after one session of repeated runs.
 *
 * Inside the repo rather than under %TEMP% for a second reason. This machine
 * runs Defender for Endpoint, and a profile directory here inherits whatever
 * exclusion the repo already carries. The equivalent exclusion for %TEMP% could
 * only be written as a wildcard, which is a malware-persistence pattern and is
 * correctly refused - so a Temp path is one nobody can legitimately exclude.
 */
const PROFILE_ROOT = path.join(ROOT, ".tmp", "ui-profiles");
export { PROFILE_ROOT };

/** Is this pid still running? `process.kill(pid, 0)` sends no signal and only
 *  probes: ESRCH means gone, EPERM means alive but not ours to touch. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unparseable: treat as live, never delete
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

/**
 * Reclaim profile directories from runs that never reached teardown() - a
 * Ctrl-C, a crashed node, a machine that went down mid-suite.
 *
 * Only directories whose owning pid is gone are touched, and that is the whole
 * safety argument. The two ways to run these suites do not agree about
 * concurrency: `npm run test:ui` passes --test-concurrency=1, the `test` script
 * does not, and its recursive glob over test/ includes test/ui. So
 * `UI_LIVE=1 npm test` - the obvious command, and one
 * docs/accessibility-assessment.md presents as supported - runs these files in
 * parallel processes sharing this one directory. A sweep that deleted
 * everything it found would then delete a sibling's profile out from under a
 * running browser. Do not replace this pid check with a wholesale delete.
 *
 * Best-effort throughout. A sweep that throws must not stop a boot: a leaked
 * directory costs disk, a failed boot costs the whole suite.
 */
export function sweepStaleProfiles() {
  let entries;
  try {
    entries = fs.readdirSync(PROFILE_ROOT, { withFileTypes: true });
  } catch {
    return; // not created yet, which is the common case
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^run-(\d+)-\d+$/.exec(entry.name);
    if (!match) continue;
    if (pidAlive(Number(match[1]))) continue;
    try {
      fs.rmSync(path.join(PROFILE_ROOT, entry.name), { recursive: true, force: true });
      dlog(`swept stale profile dir ${entry.name}`);
    } catch (err) {
      dlog(`could not sweep ${entry.name}:`, err.message);
    }
  }
}

/** Once per process, before the first launch - same guard shape as
 *  ensureAfterHook() below. */
let sweptThisProcess = false;
function ensureSwept() {
  if (sweptThisProcess) return;
  sweptThisProcess = true;
  sweepStaleProfiles();
}

/**
 * `node:test`'s own after() is registered at most once per process, the
 * first time anything boots. It is the primary net for "a test threw
 * before calling close()": node:test awaits this before it considers the
 * file finished, which does not depend on the process's event loop
 * draining the way process.on("exit") does.
 *
 * This sweep calls `entry.close` - the same idempotent close() the app
 * itself returned - never `teardown(entry)` directly. A test's own
 * `t.after(() => app.close())` and this file-level sweep can both still be
 * live at once (node:test does not guarantee one fully finishes before the
 * other starts), and calling teardown() twice concurrently on the same
 * entry is exactly how two browser.close() attempts raced each other and
 * produced an unreliable result. Routing both callers through the same
 * `closed` guard is what makes the second caller a true no-op.
 */
let afterHookRegistered = false;
function ensureAfterHook() {
  if (afterHookRegistered) return;
  afterHookRegistered = true;
  after(async () => {
    for (const entry of [...active]) {
      await (entry.close ? entry.close() : teardown(entry)).catch(() => {});
      active.delete(entry);
    }
  });
}

/* Opt-in diagnostics, HARNESS_DEBUG=1. This is what actually found the
   double-teardown race below: a test's own t.after(close) and the
   after()-hook sweep can both be live for the same entry at once, and the
   two interleaved close() attempts produced inconsistent, hard-to-read
   results until this traced each one. Cheap enough, and useful enough
   under load, to leave in rather than pull back out. */
const DEBUG = process.env.HARNESS_DEBUG === "1";
function dlog(...args) {
  if (DEBUG) console.error(`[harness ${new Date().toISOString()}]`, ...args);
}

/**
 * Force-kill a process and everything under it. `child.kill()` on Windows
 * is not a tree kill - it terminates the process node spawned but not its
 * descendants, which is exactly what let a headless Chrome's renderer
 * processes survive a "successful" close(). `taskkill /T` is the standard
 * escalation. Silently a no-op if the pid is already gone.
 */
function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      const out = execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
      dlog(`taskkill /PID ${pid} /T /F ->`, out.trim());
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch (err) {
    dlog(`taskkill /PID ${pid} /T /F threw:`, err.stdout?.toString?.() || err.message);
    // Already exited, or never existed. Either way, nothing left to do.
  }
}

/** Race a promise against a timeout. The original promise is always given a
 *  handler, win or lose, so an abandoned rejection never surfaces later as
 *  an unhandled rejection. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Resolve once `child` has exited, or reject after `ms`. Resolves
 *  immediately if the child has already exited. */
function waitForExit(child, ms, label) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return withTimeout(new Promise((resolve) => child.once("exit", resolve)), ms, label);
}

/**
 * Last resort: if a test file throws (or the whole process is killed)
 * before a booted app's own close() runs, nothing has torn down the server
 * or the browser. This fires on every normal and abnormal exit of this
 * process and force-kills whatever is still tracked. Exit handlers must be
 * synchronous, which is exactly what killProcessTree is.
 */
process.on("exit", () => {
  for (const entry of active) {
    killProcessTree(entry.browser?.process()?.pid);
    killProcessTree(entry.server.pid);
  }
});

/**
 * Tear down one { server, browser } entry, bounded so this can never hang -
 * the shared implementation behind both the app's own close() and the
 * early-failure cleanup in boot() below.
 *
 * Each half gets one polite attempt with a timeout, then a tree-kill by pid
 * if the polite attempt did not land. `browser.close()` hanging under load,
 * and `child.kill()` not being a tree kill on Windows, are exactly the two
 * ways this leaked a full Chrome tree and a live server behind a test that
 * had already reported a clean pass.
 */
async function teardown(entry) {
  const { server, browser } = entry;

  if (browser) {
    const browserPid = browser.process()?.pid;
    const t0 = Date.now();
    try {
      await withTimeout(browser.close(), 5_000, "browser.close()");
      dlog(`browser.close() resolved normally for pid ${browserPid} after ${Date.now() - t0}ms`);
    } catch (err) {
      dlog(`browser.close() for pid ${browserPid} did not land after ${Date.now() - t0}ms:`, err.message);
      killProcessTree(browserPid);
    }
  }

  if (server.exitCode === null && server.signalCode === null) {
    dlog(`server.kill() pid ${server.pid}`);
    server.kill();
    try {
      await waitForExit(server, 5_000, "server exit after kill()");
      dlog(`server pid ${server.pid} exited after kill()`);
    } catch (err) {
      dlog(`server pid ${server.pid} did not exit after kill():`, err.message);
      killProcessTree(server.pid);
      await waitForExit(server, 3_000, "server exit after taskkill").catch((err2) => {
        dlog(`server pid ${server.pid} did not exit even after taskkill:`, err2.message);
        /* Nothing further to try from here. If this process itself is about
           to end, the exit handler above is the true last resort. */
      });
    }
  }
}

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
 *  start functions below.
 *
 * The server is tracked in `active` from the moment it is spawned - before
 * the browser even exists - and the whole body runs under a try/catch that
 * tears down whatever was created so far before rethrowing. Without that, a
 * failure partway through boot (the server never printing "listening on",
 * the browser failing to launch, sign-in never finding its selector) would
 * leave that partial state behind forever: nobody holds a `close()` for an
 * app that never finished booting. */
async function boot({ role = "admin", stubs = null } = {}) {
  /* Without a built client, the server still starts and prints "listening
     on" fine - it only 503s on the first page request (app.js's static
     fallback: "GCIO dashboard client is not built yet. Run: npm run
     build"). Puppeteer never sees that message; it just never finds
     ".signin input" and the caller gets a bare 30s TimeoutError with no clue
     what was actually wrong. Checking here, before anything is spawned,
     turns that into an immediate, actionable failure instead of a 30s wait
     per test file that ends the same way anyway. */
  const clientEntry = path.join(ROOT, "client", "dist", "index.html");
  if (!fs.existsSync(clientEntry)) {
    throw new Error("client/dist is missing - run `npm run build` first, then re-run the UI suite.");
  }

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

  const entry = { server, browser: null };
  active.add(entry);
  ensureAfterHook();

  try {
    let output = "";
    const onOut = (chunk) => { output += String(chunk); };
    const onErr = (chunk) => { output += String(chunk); };
    server.stdout.on("data", onOut);
    server.stderr.on("data", onErr);

    /* Wait for the line the server actually prints, not a fixed delay. A
       sleep long enough to be safe on a slow machine is long enough to
       waste minutes across a suite. */
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
    entry.browser = browser;

    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    /*
      Make the page believe it is the focused window.

      Emulation.setFocusEmulationEnabled forces the renderer to treat the page
      as focused regardless of whether the OS window is, which is the right
      baseline for any suite that presses keys: without it, whether Tab does
      anything depends on OS window focus, which a test cannot control.

      It is not a cure for this harness's input flakiness - that was measured
      before and after, with no improvement (see test/ui/keyboard.test.js, which
      retries on input loss for that reason). It is kept because it removes one
      real variable, not because it removed the symptom.

      Wrapped, because a protocol that does not offer it should degrade to the
      old flaky-but-working behaviour rather than failing every UI suite.
    */
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    } catch (err) {
      if (DEBUG) console.error("focus emulation unavailable:", err.message);
    }

    if (stubs) await applyStubs(page, stubs);

    const baseUrl = `http://127.0.0.1:${port}`;
    await page.goto(baseUrl, { waitUntil: "networkidle0" });

    let closed = false;

    /**
     * Tear down the browser and the server, bounded so this can never hang
     * the suite - and idempotent, so a test that calls it via both t.after
     * and the file-level after() sweep does not double up. Stored on
     * `entry` too, so that sweep calls this exact function rather than
     * teardown() directly - see ensureAfterHook() for why that matters.
     */
    async function close() {
      if (closed) return;
      closed = true;
      try {
        await teardown(entry);
      } finally {
        active.delete(entry);
      }
    }
    entry.close = close;

    return { page, baseUrl, close };
  } catch (err) {
    /* Boot did not finish, so nobody will ever receive a close() to call.
       Tear down whatever got created before letting the failure propagate. */
    await teardown(entry).catch(() => {});
    active.delete(entry);
    throw err;
  }
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
  try {
    await signIn(app.page);
  } catch (err) {
    /* boot() already succeeded and handed back a real close() - if sign-in
       then fails, this is the only place that close() will ever be called
       from, since the caller never receives `app` to register its own
       cleanup. */
    await app.close().catch(() => {});
    throw err;
  }
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
  try {
    await app.page.waitForSelector(".signin input");
  } catch (err) {
    await app.close().catch(() => {});
    throw err;
  }
  return app;
}
