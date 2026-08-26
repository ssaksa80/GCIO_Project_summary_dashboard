# Frontend Phase 4 — Testing The Thing People Actually Look At

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put automated tests on the dashboard itself, and produce an honest assessment of its accessibility. Today 256 tests cover the server and none of them touch `client/src`.

**Architecture:** Real Chrome driving the real built client against a real server, using the `puppeteer-core` pattern four scripts in this repo already use. One shared harness. The suite self-skips unless asked for, exactly like the live SQL suite, so `npm test` stays hermetic and fast.

**Tech Stack:** Node 24, `node:test`, `puppeteer-core` (already a devDependency), `axe-core` (one new devDependency), React 18, Vite 6.

**Builds on:** `v1.4.0-p3`

---

## Why a browser and not jsdom

The obvious choice is Vitest plus jsdom plus `@testing-library/react` — three new dependencies in a project that hand-rolls its own OOXML writer to avoid one.

The deciding argument is not dependency count, it is that **jsdom would not have caught the UI defects this project has actually had.** Every one of them was a rendering defect:

- The PowerPoint cover ran two lines together, because a line feed inside a text run is not a line break. Found by exporting a deck and reading the XML.
- A neutral change would have been painted green, because the badge had three states and the data has four.
- Colour rules scoped under a parent class silently did nothing elsewhere — a defect this project hit once already, in `.rag` under `.kpi`.

jsdom does not compute styles, does not lay anything out, and would have passed all three. A real browser catches them, and `puppeteer-core` is already here with a working pattern in `scripts/e2e-signin.mjs`.

The cost is honest: browser tests are slower and easier to write flakily. The mitigation is to keep the suite small, wait on selectors rather than timeouts, and gate it behind an explicit flag so nobody pays for it on every commit.

**If a task in this plan seems to need jsdom or a component-level renderer, stop and report it.** Something has been misread.

---

## What this phase will not do

**It will not fix accessibility findings.** The audit reports; fixing is a separate decision, deliberately. The brand palette is fixed — 40% Pantone 281 C, 40% 354 C, 15% 375 C, and the named secondaries — and if a contrast ratio conflicts with a mandated colour that is a conversation, not a unilateral code change. A task that quietly adjusts a brand colour to make an audit pass has substituted its own judgment for the organisation's.

**It will not chase coverage.** Twenty components exist. Testing all of them equally would produce a slow suite that nobody runs. The tests here go where the risk is: what the CIO reads, what has broken before, and what no server test can see.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `test/ui/harness.mjs` | **create** — find Chrome, boot the server, open a page, sign in, tear down |
| `test/ui/render.test.js` | **create** — the five sections and the KPI strip actually render |
| `test/ui/changes.test.js` | **create** — the four badge states and their computed colours; the no-history line |
| `test/ui/interaction.test.js` | **create** — the sign-in gate, the drawer, section navigation |
| `test/ui/accessibility.test.js` | **create** — axe against the real pages, reporting |
| `docs/accessibility-assessment.md` | **create** — what the audit found, and what it would cost |
| `scripts/{capture-screens,compress-screens,e2e-signin,e2e-sso}.mjs` | **modify** — use the harness's browser lookup instead of four hardcoded paths |
| `package.json` | **modify** — `axe-core`, and a `test:ui` script |
| `README.md` | **modify** — how to run it |

**Rebuild after touching `client/src`.** The harness serves `client/dist`, so a
component edit that is not rebuilt silently tests the previous bundle and you
chase a ghost. `npm run build` before any run that follows a component change.

**Commands are bash.** Run them in Git Bash. The PowerShell form of `VAR=1 cmd` is `$env:VAR = "1"; cmd`.

---

### Task 1: The harness

Everything else depends on this being solid. A flaky harness produces a suite nobody trusts, which is worse than no suite.

**Files:**
- Create: `test/ui/harness.mjs`
- Modify: `scripts/capture-screens.mjs`, `scripts/compress-screens.mjs`, `scripts/e2e-signin.mjs`, `scripts/e2e-sso.mjs`

- [ ] **Step 1: Centralise the browser lookup**

Four scripts hardcode `C:/Program Files/Google/Chrome/Application/chrome.exe`. That is four places to fix when a machine differs, and it fails with an unhelpful error when it does.

```js
/**
 * Where Chrome is. puppeteer-core does not download one, so this has to say.
 *
 * Four scripts hardcoded the same path before this existed; a machine without
 * Chrome in that exact location failed with a message that did not mention
 * Chrome. Look in the usual places, allow an override, and if none is found say
 * what to do about it.
 */
import fs from "node:fs";

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
```

Then change all four scripts to import it. Keep their behaviour otherwise
identical — this is a lookup change, not a rewrite.

- [ ] **Step 2: The harness itself**

```js
/**
 * A real browser against the real client, served by a real server.
 *
 * STORE=memory and AUTH_MODE=dev, so no database and no directory are needed
 * and the bundled sample portfolio is what renders. The port is ephemeral
 * because this machine already has something on 8123 and a test suite must not
 * care what else is running.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import puppeteer from "puppeteer-core";
import { findBrowser } from "./harness.mjs";   // adjust if you split the file

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
 * Boot the app and open a signed-in page.
 * @param {{role?: string, stubs?: object}} [options] stubs are applied via a
 *        request interceptor, so a test can render states the sample data
 *        cannot produce — history, an empty portfolio, a failure.
 * @returns {Promise<{page: object, close: () => Promise<void>, baseUrl: string}>}
 */
export async function startDashboard({ role = "admin", stubs = null } = {}) {
  const port = await freePort();
  const server = spawn(process.execPath, ["server/index.js"], {
    env: { ...process.env, STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: role, PORT: String(port), NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  /* Wait for the line the server actually prints, not a fixed delay. A sleep
     long enough to be safe on a slow machine is long enough to waste minutes
     across a suite. */
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start within 30s")), 30_000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening on")) { clearTimeout(timer); resolve(); }
    });
    server.on("exit", (code) => reject(new Error(`server exited early with code ${code}`)));
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
  await signIn(page);

  return {
    page,
    baseUrl,
    async close() {
      await browser.close();
      server.kill();
      /* Killing is not the same as having exited; a leaked node process per
         test file is how a suite ends up unable to bind a port. */
      await new Promise((resolve) => server.on("exit", resolve));
    },
  };
}
```

`applyStubs` and `signIn` are yours to write. For `signIn`, read
`client/src/components/SignIn.jsx` and `scripts/e2e-signin.mjs` — that script
already signs in successfully and is the reference. Note the Microsoft button
uses class `signin-sso`, deliberately distinct from the form submit, so a
selector that matches both would click the wrong one.

For `applyStubs`, use `page.setRequestInterception` to intercept
`/api/summary` and respond with a modified body — take the real response, merge
the stub over it, and return it. That way a test asking for change badges gets
real sample data plus the history the sample data cannot have, rather than a
hand-built payload that drifts from the real shape.

- [ ] **Step 3: Prove the harness before writing tests on it**

Write `test/ui/harness.test.js` with one test: start the dashboard, assert the
page title or a known element exists, close it. Run it. Then run it **three
times in a row** and confirm it passes every time and leaves no node process
behind:

```bash
UI_LIVE=1 node --test test/ui/harness.test.js
```

```bash
for i in 1 2 3; do UI_LIVE=1 node --test test/ui/harness.test.js || echo "RUN $i FAILED"; done
```

Then check nothing leaked:

```bash
powershell -NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Select-Object Id,StartTime"
```

Compare against what was running before. **A harness that leaks a process per
run is not finished**, however green the test is.

- [ ] **Step 4: Gate the suite**

Every UI test file starts with the same gate the live SQL suite uses, so
`npm test` stays hermetic:

```js
const ui = process.env.UI_LIVE === "1";
test("...", { skip: !ui }, async (t) => { /* ... */ });
```

Add to `package.json`:

```json
    "test:ui": "node --test \"test/ui/**/*.test.js\""
```

Confirm `npm test` still reports the same totals as before this task — the UI
files are inside its glob and must self-skip, not fail.

- [ ] **Step 5: Commit**

```bash
git add test/ui/harness.mjs test/ui/harness.test.js scripts package.json
git commit -m "test(ui): a harness that drives the real client in a real browser"
```

---

### Task 2: The sections render

**The harness API Task 1 settled on**, which Tasks 2 to 5 are written against:

- `startDashboard({ role, stubs })` and `startDashboardSignedOut({ role })`, both
  returning `{ page, baseUrl, close }`. `close()` waits for the server to exit.
- `stubs` is deep-merged over the REAL `/api/summary` response, so a test gets
  genuine sample data plus whatever it needs on top. Objects merge recursively;
  arrays and scalars are replaced wholesale.
- `changeForFirstProject` is a special key: the harness finds the first project
  id in the real response using the same `node.projectId || node.id` convention
  `annotateChanges` uses, and attaches the given change to every node carrying
  it. Never hardcode a project id — the sample data can change.
- A broken stub responds 599 with the error in the body, so it fails loudly
  rather than hanging.
- Sign-in uses `.signin button[type="submit"]`. Do NOT use `.signin-submit` —
  the SSO button carries that class too.

**Files:**
- Create: `test/ui/render.test.js`

- [ ] **Step 1: Write the tests**

The CIO reads five sections in a fixed order. That order was an explicit
instruction and nothing currently guards it.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "./harness.mjs";

const ui = process.env.UI_LIVE === "1";

test("the dashboard renders what the CIO asked for", { skip: !ui }, async (t) => {
  const app = await startDashboard();
  t.after(() => app.close());
  const { page } = app;

  await t.test("the five sections appear, in the order they were asked for", async () => {
    /* Successes first, then QRI, Priorities, Roadmap, Posture last. This order
       was an explicit instruction and no test guarded it until now. */
    const headings = await page.$$eval("h2, h3", (els) => els.map((e) => e.textContent.trim()));
    const order = ["Successes", "Questions", "Priorities", "Roadmap", "Posture"];

    const found = order.map((needle) => headings.findIndex((h) => h.includes(needle)));
    assert.ok(found.every((i) => i >= 0), `a section is missing: ${JSON.stringify(headings)}`);
    assert.deepEqual([...found].sort((a, b) => a - b), found, `sections are out of order: ${headings}`);
  });

  await t.test("the KPI strip shows real numbers, not placeholders", async () => {
    const text = await page.$eval(".kpi, .kpi-strip", (el) => el.textContent);
    assert.match(text, /\d/, "no digits in the KPI strip");
    assert.ok(!/NaN|undefined|null/.test(text), `the KPI strip shows a non-value: ${text}`);
  });

  await t.test("nothing anywhere on the page reads NaN or undefined", async () => {
    /* This has bitten before: a formatter given a null renders the word rather
       than nothing, and it looks like data until someone reads it. */
    const body = await page.$eval("body", (el) => el.innerText);
    for (const bad of ["NaN", "undefined", "[object Object]", "Invalid Date"]) {
      assert.ok(!body.includes(bad), `the page shows "${bad}"`);
    }
  });

  await t.test("every section has content, not just a heading", async () => {
    /* An empty section renders as a heading and nothing else, which reads as
       "nothing to report" rather than "the builder threw". */
    for (const name of ["successes", "qri", "priorities", "roadmap", "posture"]) {
      /* li, tr AND [data-row]: Successes and Priorities render their repeating
         content as plain divs, so a li/tr-only selector reported them empty
         however much data they held. */
      const count = await page.$$eval(
        `[data-section="${name}"] li, [data-section="${name}"] tr, [data-section="${name}"] [data-row]`,
        (els) => els.length).catch(() => 0);
      assert.ok(count > 0, `section ${name} rendered no rows`);
    }
  });
});
```

The `data-section` attribute may not exist. **Read the five components first.**
If there is no stable hook, add one — a `data-section` attribute is a
test seam, not a design change, and it is far better than selecting on class
names that exist for styling and will move. Say in your report which you did.

- [ ] **Step 2: Run it**

```bash
UI_LIVE=1 node --test test/ui/render.test.js
```

Then run it twice more and confirm it is stable.

- [ ] **Step 3: Commit**

```bash
git add test/ui/render.test.js client
git commit -m "test(ui): the five sections render, in the order the CIO asked for"
```

---

### Task 3: The change badges, which are the newest and least verified thing

**Files:**
- Create: `test/ui/changes.test.js`

This is where a browser earns its place. The badge has four states and one of
them must not be green; that is a computed-colour fact and no server test can
see it.

- [ ] **Step 1: Write the tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "./harness.mjs";

const ui = process.env.UI_LIVE === "1";

/* The sample portfolio has no history, so these states have to be stubbed in.
   The stub is merged over the real response, so everything except `changes`
   and `sections.historyAvailable` is genuine. */
const withHistory = {
  sections: { historyAvailable: true },
  historyStartedAt: "2026-08-01T00:00:00.000Z",
  changeForFirstProject: {
    headline: "health Green to Red", worst: "worse", since: "2026-08-18T00:00:00.000Z",
    fields: { health: { from: "Green", to: "Red", direction: "worse" } },
  },
};

test("what changed is shown, and shown honestly", { skip: !ui }, async (t) => {
  await t.test("a worsening move is red and points up", async () => {
    /* Pantone 192 C. The exact value matters: the brand palette is fixed and a
       badge that drifts to a generic red is a brand defect nobody would catch
       by reading code. */
    const app = await startDashboard({ stubs: withHistory });
    try {
      await app.page.waitForSelector(".change-worse");
      const colour = await app.page.$eval(".change-worse", (el) => getComputedStyle(el).color);
      assert.equal(colour, "rgb(228, 0, 70)");
      const text = await app.page.$eval(".change-worse", (el) => el.textContent);
      assert.match(text, /▲/);
    } finally { await app.close(); }
  });

  await t.test("a neutral move is grey, never green", async () => {
    /* The one the design got wrong first time: three states for four kinds of
       change, so an ordinary status transition would have been painted as an
       improvement. Assert the grey AND assert it is not the green, because
       "some colour was applied" is not the property that matters. */
    const app = await startDashboard({ stubs: {
      sections: { historyAvailable: true },
      historyStartedAt: "2026-08-01T00:00:00.000Z",
      changeForFirstProject: {
        headline: "status Proposed to Approved", worst: "neutral",
        since: "2026-08-18T00:00:00.000Z",
        fields: { status: { from: "Proposed", to: "Approved", direction: "neutral" } },
      },
    } });
    try {
      await app.page.waitForSelector(".change-neutral");
      const colour = await app.page.$eval(".change-neutral", (el) => getComputedStyle(el).color);
      assert.equal(colour, "rgb(65, 65, 65)");
      assert.notEqual(colour, "rgb(0, 177, 64)", "a neutral change was painted as an improvement");
      assert.equal(await app.page.$$eval(".change-better", (els) => els.length), 0);
    } finally { await app.close(); }
  });

  await t.test("a newly tracked project says since when, not 'no change'", async () => {
    /* "We have only known about this since Tuesday" and "nothing changed" are
       different statements and the dashboard must not conflate them. */
    const app = await startDashboard({ stubs: {
      sections: { historyAvailable: true },
      historyStartedAt: "2026-08-24T00:00:00.000Z",
      changeForFirstProject: { trackedSince: "2026-08-24T00:00:00.000Z" },
    } });
    try {
      await app.page.waitForSelector(".change-new");
      const text = await app.page.$eval(".change-new", (el) => el.textContent);
      assert.match(text, /new since/i);
      assert.match(text, /24 Aug/, `expected the date in the badge, got: ${text}`);
      assert.ok(!/no change/i.test(text), `a newly tracked project claimed nothing changed: ${text}`);
    } finally { await app.close(); }
  });

  await t.test("with no history at all, no badge appears and the page says why", async () => {
    /* The default state of a fresh deployment. The absence of badges must be
       explained, or a reader infers stability. */
    const app = await startDashboard();
    try {
      assert.equal(await app.page.$$eval(".change", (els) => els.length), 0);
      const body = await app.page.$eval("body", (el) => el.innerText);
      assert.match(body, /no change history/i);
    } finally { await app.close(); }
  });

  await t.test("with history available and nothing moved, there is no apology", async () => {
    /* A real answer: history exists, the week was quiet. Saying "no history"
       here would be false, and it is the case a naive implementation gets
       wrong by keying the notice off "are there any badges". */
    const app = await startDashboard({ stubs: {
      sections: { historyAvailable: true },
      historyStartedAt: "2026-08-01T00:00:00.000Z",
      changes: { changed: 0, wentRed: 0, recovered: 0, slipped: 0, overspent: 0, newlyTracked: 0 },
    } });
    try {
      await app.page.waitForSelector("[data-section='priorities']");
      assert.equal(await app.page.$$eval(".change", (els) => els.length), 0);
      const body = await app.page.$eval("body", (el) => el.innerText);
      assert.ok(!/no change history/i.test(body),
        "the page apologised for missing history it actually has");
    } finally { await app.close(); }
  });
});
```

`changeForFirstProject` is a convenience the harness's stub layer should
support: it reads the real response, picks the first project id out of the
sections, and attaches the given change to it. Hardcoding an id would break the
moment the sample data changes. Implement it in `applyStubs` and say so.

The colours to assert are the brand values already in the stylesheet: worse
`rgb(228, 0, 70)`, better `rgb(0, 177, 64)`, neutral and newly-tracked
`rgb(65, 65, 65)`. Read `client/src/styles.css` and confirm those before
asserting them; if the stylesheet disagrees with this plan, the stylesheet wins
and you tell me.

- [ ] **Step 2: Prove the neutral test bites**

Temporarily change `ChangeBadge.jsx` so a neutral change renders with
`change-better`, run the test, and confirm it goes red on the colour. Restore
and confirm green. **Report both.** This is the test guarding the defect the
design actually had.

- [ ] **Step 3: Commit**

```bash
git add test/ui/changes.test.js
git commit -m "test(ui): the four change states, including the one that must not be green"
```

---

### Task 4: The parts a user touches

**Files:**
- Create: `test/ui/interaction.test.js`

- [ ] **Step 1: Write the tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard, startDashboardSignedOut } from "./harness.mjs";

const ui = process.env.UI_LIVE === "1";

test("the sign-in gate keeps the portfolio behind it", { skip: !ui }, async (t) => {
  /* The one with real consequences. Asserting a form is present proves nothing
     — what matters is that no portfolio data reached the page. */
  const app = await startDashboardSignedOut();
  t.after(() => app.close());

  await app.page.waitForSelector("form");
  const body = await app.page.$eval("body", (el) => el.innerText);

  assert.ok(!/PRJ-/.test(body), `a project id leaked to the signed-out page: ${body.slice(0, 300)}`);
  for (const heading of ["Successes", "Priorities", "Roadmap"]) {
    assert.ok(!body.includes(heading), `the ${heading} section rendered before sign-in`);
  }
  assert.equal(await app.page.$$eval(".kpi, .kpi-strip", (els) => els.length), 0,
    "the KPI strip rendered before sign-in");
});

test("a user can open a project, read it, and get back", { skip: !ui }, async (t) => {
  const app = await startDashboard();
  t.after(() => app.close());
  const { page } = app;

  await t.test("clicking a project opens its own record, not an empty drawer", async () => {
    await page.waitForSelector("[data-section='priorities']");
    const name = await page.$eval("[data-section='priorities'] .pname",
      (el) => el.textContent.trim());
    await page.click("[data-section='priorities'] .pname");

    const drawer = await page.waitForSelector(".drawer, [role='dialog']");
    const text = await drawer.evaluate((el) => el.innerText);

    /* The drawer must show THIS project, not merely exist. A test that only
       waits for the element passes against an empty drawer. */
    assert.ok(text.includes(name), `the drawer does not name ${name}`);
    assert.ok(text.length > name.length + 50, "the drawer opened but is essentially empty");
  });

  await t.test("it closes again, and the portfolio is still there", async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".drawer, [role='dialog']"));
    await page.waitForSelector("[data-section='priorities']");
  });
});

test("the all-projects table filters", { skip: !ui }, async (t) => {
  const app = await startDashboard();
  t.after(() => app.close());
  const { page } = app;

  const rows = async () => page.$$eval("table tbody tr", (els) => els.length);

  await page.waitForSelector("table tbody tr");
  const before = await rows();
  assert.ok(before > 1, `the table rendered ${before} rows`);

  /* Narrowing must actually narrow. A filter that silently does nothing looks
     identical to one that matched everything. */
  await page.type("input[type='search']", "zzzzz-no-such-project");
  await page.waitForFunction((n) => document.querySelectorAll("table tbody tr").length < n, {}, before);
  assert.ok(await rows() < before, "the filter did not narrow the table");
});
```

**The app already has the hooks these tests need — do not add `data-*` for
them.** Confirmed by reading the components:

| What the test needs | Use this | Where |
| --- | --- | --- |
| a clickable project name | `.pname` | `<button type="button" className="pname">` in Priorities and elsewhere |
| the drawer | `[role="dialog"]` | `ProjectDrawer.jsx:61`, with `aria-label="Project detail"` |
| the free-text filter | `input[type="search"]` | `ProjectTable.jsx:80` |
| the three dropdown filters | `[aria-label="Department filter"]` and siblings | `ProjectTable.jsx:68-76` |

Replace `[data-project-name]` and `[data-filter='q']` in the tests above with
those. `startDashboardSignedOut` is the harness export Task 1 built.

Escape-to-close **is** wired — `ProjectDrawer.jsx:39` binds it — so the test
should pass. If it does not, that is a finding worth reporting rather than
working around, because a modal a keyboard user cannot leave is exactly what
Task 5 audits for.

- [ ] **Step 2: Run it three times**

Interaction tests are where flakiness lives. If any of them needs a fixed
`waitForTimeout` to pass, that is a signal the assertion is racing something —
find the selector or the network idle to wait on instead, and say in your
report if you could not.

- [ ] **Step 3: Commit**

```bash
git add test/ui/interaction.test.js
git commit -m "test(ui): the sign-in gate, the drawer, and the table"
```

---

### Task 5: The accessibility assessment

**Files:**
- Create: `test/ui/accessibility.test.js`, `docs/accessibility-assessment.md`
- Modify: `package.json` — add `axe-core`

**Assess, do not fix.** If a finding requires changing a brand colour, it goes
in the document with what it would take, and stops there.

- [ ] **Step 1: Add axe and run it**

`axe-core` is injected into the page as a script and run against the loaded
document. Cover, separately, the sign-in page, the dashboard, and one open
project drawer — a modal is where keyboard traps and focus management go wrong,
and auditing the main page will not find them.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startDashboard, startDashboardSignedOut } from "./harness.mjs";

const ui = process.env.UI_LIVE === "1";
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/**
 * Run axe against whatever the page currently shows.
 * @returns {Promise<{violations: object[]}>}
 */
async function audit(page) {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => window.axe.run(document, {
    resultTypes: ["violations"],
  }));
}

/** Serious and critical fail the build. Moderate and minor are recorded. */
const BLOCKING = new Set(["serious", "critical"]);

function report(where, violations) {
  const lines = violations.map((v) =>
    `  [${v.impact}] ${v.id}: ${v.help}\n` +
    v.nodes.slice(0, 3).map((n) => `      ${n.target.join(" ")}`).join("\n"));
  return `${where}: ${violations.length} violation(s)\n${lines.join("\n")}`;
}

test("the dashboard is accessible enough to use", { skip: !ui }, async (t) => {
  /* This measures something nobody has measured before, so it may legitimately
     fail. If it does, the failure is the deliverable — record it in
     docs/accessibility-assessment.md. Do NOT lower the threshold to get green. */

  await t.test("the sign-in page", async () => {
    const app = await startDashboardSignedOut();
    try {
      const { violations } = await audit(app.page);
      const blocking = violations.filter((v) => BLOCKING.has(v.impact));
      console.log(report("sign-in", violations));
      assert.deepEqual(blocking.map((v) => v.id), [], report("sign-in (blocking)", blocking));
    } finally { await app.close(); }
  });

  await t.test("the dashboard", async () => {
    const app = await startDashboard();
    try {
      await app.page.waitForSelector("[data-section='priorities']");
      const { violations } = await audit(app.page);
      const blocking = violations.filter((v) => BLOCKING.has(v.impact));
      console.log(report("dashboard", violations));
      assert.deepEqual(blocking.map((v) => v.id), [], report("dashboard (blocking)", blocking));
    } finally { await app.close(); }
  });

  await t.test("an open project drawer", async () => {
    /* Audited separately because a modal's problems — focus not moving into
       it, no way out by keyboard, no accessible name — are invisible to an
       audit of the page behind it. */
    const app = await startDashboard();
    try {
      await app.page.waitForSelector("[data-section='priorities'] .pname");
      await app.page.click("[data-section='priorities'] .pname");
      await app.page.waitForSelector("[role='dialog']");

      const { violations } = await audit(app.page);
      const blocking = violations.filter((v) => BLOCKING.has(v.impact));
      console.log(report("drawer", violations));
      assert.deepEqual(blocking.map((v) => v.id), [], report("drawer (blocking)", blocking));
    } finally { await app.close(); }
  });
});
```

The test should **fail on serious and critical violations** and merely record
moderate and minor ones. A test that fails on every finding will be skipped
within a week; one that fails on nothing is decoration. If the current state has
serious violations — which is likely, since nobody has looked — then it fails,
**and that failing test is the correct deliverable for this task**. Do not
weaken the threshold to make it pass. Report it, and I will decide.

- [ ] **Step 2: Check the things axe cannot**

Automated auditing catches perhaps half of what matters. By hand, with the
browser:

- **Keyboard only.** Tab through the dashboard from the top. Can every
  interactive thing be reached, is the focus ring visible against the dark
  theme, and can a project drawer be opened, read and dismissed without a mouse?
- **Focus return.** When the drawer closes, does focus go back to what opened it,
  or to the top of the document?
- **Contrast against the real palette**, in both themes. The brand secondaries
  on a dark background are the likely problem: Pantone 192 C red and 1575 C
  orange are both plausible failures at small text sizes.
- **Text scaling.** At 200% browser zoom, does the layout hold or does content
  become unreachable?

Record what you find with the actual measured values, not impressions. A
contrast finding says the ratio and the requirement.

- [ ] **Step 3: Write the assessment**

`docs/accessibility-assessment.md`:

- What was audited, with what, and on what date.
- Findings by severity, each with: what, where, the measured value where there
  is one, who it affects, and what fixing it would take.
- **Explicitly separate findings that conflict with the brand palette** from
  those that do not. The second group is ordinary work. The first needs a
  decision from whoever owns the brand, and the document should say so plainly
  rather than recommending a colour change as though it were a bug fix.
- A short honest statement of what the audit did NOT cover: screen reader
  testing with an actual screen reader, users with actual disabilities, and
  anything about the exported documents rather than the web page.

- [ ] **Step 4: Commit**

```bash
git add test/ui/accessibility.test.js docs/accessibility-assessment.md package.json
git commit -m "test(ui): assess accessibility, and say plainly what it would cost"
```

---

### Task 6: Make it runnable by someone else

**Files:**
- Modify: `README.md`, `package.json`

- [ ] **Step 1: Document it**

A suite nobody can run is a suite nobody runs. In `README.md`, beside the
existing test commands:

```markdown
The UI suite drives real Chrome against the real client:

```bash
UI_LIVE=1 npm run test:ui
```

It needs Chrome or Edge — set `CHROME_PATH` if it is not in the usual place —
and it starts its own server on an ephemeral port, so nothing needs to be
running first. Like the live SQL suite it self-skips without its flag, so
`npm test` stays hermetic and fast.
```

Say what it covers and, more usefully, what it does not: it is not a
pixel-comparison suite, it does not test the exporters (the pptx audit does
that), and it runs against the bundled sample portfolio rather than real data.

- [ ] **Step 2: Prove someone else could run it**

Delete `client/dist`, then run the suite. If it fails because the client was not
built, either the harness should build it or the README must say to run
`npm run build` first — decide which, do it, and say which you chose. A
first-time contributor hitting an unexplained failure is the thing this step
exists to prevent.

- [ ] **Step 3: Commit**

```bash
git add README.md package.json
git commit -m "docs: how to run the UI suite, and what it does not cover"
```

---

### Task 7: Close out

- [ ] **Step 1: Run everything**

```bash
npm test
UI_LIVE=1 npm run test:ui
DB_LIVE=1 npm run test:db
npm run build
```

Report all four. The accessibility test may legitimately fail — if it does, that
is a finding to report, not a gate to weaken.

- [ ] **Step 2: Check for leaks one more time**

Run the UI suite twice in succession, then confirm no orphaned node or Chrome
processes remain. A suite that leaks a browser per run makes a machine unusable
after a morning of work.

- [ ] **Step 3: Update the spec**

The spec's rollout table ends at P3. Add a P4 row for what was built, and record
in the Risks section that **the client had no automated tests at all until this
phase** — that is a fact about how the first three phases were verified, and it
belongs written down.

- [ ] **Step 4: Commit and tag**

```bash
git add docs/superpowers/specs/2026-08-24-backend-production-design.md package.json
git commit -m "docs: Phase 4 — the dashboard is tested and its accessibility assessed"
git tag -a v1.5.0-p4 -m "Phase 4: testing the thing people actually look at"
```

Remember `package.json`'s version goes to `1.5.0` with the tag —
`gcio_build_info` reads it, and a version frozen across releases cannot answer
whether a fix landed.

---

## Self-review

| Goal | Where |
| --- | --- |
| The client has automated tests | Tasks 2, 3, 4 |
| Rendering defects a server test cannot see | Task 3 — computed colours in a real browser |
| The section order the CIO specified | Task 2 |
| Accessibility assessed | Task 5 |
| Accessibility fixed | **Explicitly not.** Reporting only; palette conflicts are a decision, not a defect |
| Someone else can run it | Task 6 |

**The rule most likely to be broken under pressure:** the accessibility test is
allowed to fail. It is measuring something nobody has ever measured, and the
honest result may be red. Weakening its threshold to get a green suite would
convert a real finding into a false assurance, which is worse than not having
looked.

**Not in this phase:** fixing accessibility findings, pixel comparison, testing
the exporters (the pptx audit covers those), trends, question ageing, the lock
election, and the still-unperformed service install.
