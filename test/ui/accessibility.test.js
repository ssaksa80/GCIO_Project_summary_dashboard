/**
 * Task 5 — the accessibility assessment.
 *
 * axe-core against the real, built client: the sign-in page, the signed-in
 * dashboard, and one open project drawer, each audited separately. A modal's
 * own problems - focus not moving into it, no way out by keyboard, no
 * accessible name - are invisible to an audit of the page behind it.
 *
 * This measures something nobody has measured on this dashboard before, so a
 * failure here may be a legitimate, previously-unknown finding rather than a
 * bug in the test. Serious and critical violations fail the build; moderate
 * and minor ones are recorded (console.log) but do not. See
 * docs/accessibility-assessment.md for the full report, including what this
 * automated pass cannot see at all.
 *
 * Self-skips unless UI_LIVE=1, exactly like the other UI suites:
 *
 *     UI_LIVE=1 node --test test/ui/accessibility.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { startDashboard, startDashboardSignedOut } from "./harness.mjs";

const ui = process.env.UI_LIVE === "1";
const axePath = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/* The app serves a real CSP - script-src 'self' (server/middleware/
   securityHeaders.js) - with no 'unsafe-inline' and no nonce. The plan's
   addScriptTag({ path }) form injects axe as an inline <script> DOM node,
   which that CSP silently blocks: the tag lands but never executes, so
   window.axe stays undefined and every audit() call throws "Cannot read
   properties of undefined (reading 'run')". Confirmed directly - swapping
   nothing else and only changing the injection mechanism below fixed it.
   Evaluating the axe source as a string runs it through CDP's
   Runtime.evaluate instead of the DOM, which the page's own CSP does not
   govern (the same technique @axe-core/puppeteer uses, for the same
   reason). This is a measurement-mechanism fix, not an app change - the CSP
   itself is untouched and is not a finding, since a strict script-src is a
   real security control, not an accessibility defect. */
const axeSource = fs.readFileSync(axePath, "utf8");

/**
 * Run axe against whatever the page currently shows.
 * @returns {Promise<{violations: object[]}>}
 */
async function audit(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => window.axe.run(document, {
    resultTypes: ["violations"],
  }));
}

/**
 * Land the page on its settled visual state before auditing.
 *
 * SectionSuccesses (and others) call useReveal (client/src/lib/motion.jsx),
 * which fades [data-reveal] content in via GSAP - opacity 0 to 1 over 500ms,
 * staggered 45ms per item, triggered per-section by an IntersectionObserver.
 * A fresh page load intersects several sections at once, so a straight
 * waitForSelector + immediate audit() caught many of them mid-fade. axe
 * factors an element's opacity into its rendered colour, so a half-faded
 * label was reported as a colour-contrast violation against blended colours
 * like #203251 that never appear in themes.css and that no user ever reads -
 * confirmed by re-running against the identical page moments later, once the
 * tween had finished, and seeing those specific violations disappear.
 *
 * motion.jsx already special-cases prefers-reduced-motion: reduce by
 * skipping the tween and setting the end state directly ("an executive
 * screen must never withhold a number because a tween did not run"). Asking
 * for that media feature and reloading lands on exactly that already-shipped
 * settled path, for every section regardless of scroll position, rather than
 * this test inventing its own wait-and-hope timing. This changes nothing
 * about what is measured - the animation's own end state is opacity 1 either
 * way - only when the audit is allowed to see it. Required to measure the
 * page's real colours rather than a mid-transition artifact of the test's
 * own timing, so it stays here rather than in application code.
 *
 * waitUntil must be "domcontentloaded", not "networkidle0": once signed in,
 * App.jsx opens a live-events connection (useLiveEvents, an EventSource)
 * that stays open indefinitely, so "zero network connections for 500ms"
 * never becomes true on a reload of an already-authenticated session and
 * the reload hangs until Puppeteer's own 30s navigation timeout. Confirmed
 * directly. The caller waits for its own selector afterward regardless.
 */
async function settle(page) {
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.reload({ waitUntil: "domcontentloaded" });
}

/**
 * Click something only once the page has stopped moving underneath it.
 *
 * The drawer subtest below was failing here on every run, invisibly. settle()
 * reloads, which leaves the page scrolled back to the top; Puppeteer's
 * page.click() then scrolls the target into view, computes its coordinates,
 * and dispatches a mouse event at them. That scroll is itself what first
 * brings the lower sections into view, which fires their IntersectionObserver
 * reveals (client/src/lib/motion.jsx) and changes the heights of everything
 * above the target - so the element has moved by the time the event lands and
 * the click hits nothing at all.
 *
 * Confirmed directly, not inferred: with the click issued immediately, no
 * [role="dialog"] ever enters the DOM and no GET /api/projects/:id is ever
 * sent, so the drawer is not slow to load - it never opens. The identical
 * click a few tens of milliseconds later opens it every time. The target was
 * measured at y=3705 in a 1000px-tall viewport at the moment of the click,
 * with document.elementFromPoint at its centre returning nothing.
 *
 * So: scroll first, wait until the target's own box stops moving, then click.
 * A fixed sleep would only make the race less likely; this waits for the
 * condition that actually has to hold before a coordinate is meaningful.
 */
async function clickWhenStill(page, selector) {
  const handle = await page.waitForSelector(selector);
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.evaluate(() => { delete window.__lastClickY; });
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const y = el.getBoundingClientRect().y;
      const previous = window.__lastClickY;
      window.__lastClickY = y;
      return previous !== undefined && Math.abs(y - previous) < 0.5;
    },
    { polling: "raf", timeout: 10_000 },
    selector,
  );
  await handle.click();
  return handle;
}

/** Serious and critical fail the build. Moderate and minor are recorded. */
const BLOCKING = new Set(["serious", "critical"]);

function report(where, violations) {
  const lines = violations.map((v) =>
    `  [${v.impact}] ${v.id}: ${v.help}\n` +
    v.nodes.slice(0, 3).map((n) => `      ${n.target.join(" ")}`).join("\n"));
  return `${where}: ${violations.length} violation(s)\n${lines.join("\n")}`;
}

/* Finding 1 in docs/accessibility-assessment.md: --critical (Pantone 192 C),
   used verbatim as text on obsidian/sapphire/emerald surfaces, fails WCAG
   text-contrast on the "dashboard" and "an open project drawer" subtests
   below - reproduced on three separate runs, root-caused to the same
   .solid.critical.chip elements each time. Fixing it means moving off a
   mandated brand hex or darkening the surfaces derived from another one,
   which is a brand-owner decision this phase deliberately does not make.
   This was previously carried as node:test's `todo` on both subtests. That
   was wrong, and it cost real coverage: `todo` tolerates ANY failure, not
   just the known one, so when the drawer subtest started timing out before
   it ever reached axe, the run still reported green and nobody could tell
   from the output that the drawer was no longer being audited at all. It had
   not been audited for as long as the race existed (see clickWhenStill
   above). A marker that hides the difference between "the known brand
   finding" and "this test stopped working" is not a marker worth having.

   So the known finding is an expected VALUE instead. The subtests assert
   their blocking violations equal exactly this list: the recorded finding
   keeps them from failing, and anything else - a new violation, a harness
   break, a timeout - fails loudly. When the palette is fixed these go red
   with "expected [color-contrast], got []"; that is the intended signal that
   the finding is closed, and the fix is to empty this list, not to silence
   the test. */
const KNOWN_BLOCKING = ["color-contrast"];

/* Findings 3 and 4, now fixed: the app had no <main>, so landmark-one-main
   reported directly and `region` reported everything sitting loose in .shell as
   content outside any landmark.

   These are checked separately, against the FULL violation list rather than the
   blocking subset, because both rules are moderate - the assertions above have
   never been able to see them, which is exactly why nothing would have noticed
   the fix being removed again. Moderate violations stay non-blocking in
   general; these two are named because they are fixed and a regression should
   be loud rather than a line in a console log. */
const MUST_NOT_REGRESS = ["landmark-one-main", "region"];

function assertLandmarks(where, violations) {
  const back = violations.map((v) => v.id).filter((id) => MUST_NOT_REGRESS.includes(id));
  assert.deepEqual(back, [],
    `${where}: landmark violations are back - ${report(where, violations.filter((v) => back.includes(v.id)))}`);
}

test("the dashboard is accessible enough to use", { skip: !ui }, async (t) => {
  /* This measures something nobody has measured before, so it may legitimately
     fail. If it does, the failure is the deliverable - record it in
     docs/accessibility-assessment.md. Do NOT lower the threshold to get green. */

  await t.test("the sign-in page", async () => {
    const app = await startDashboardSignedOut();
    try {
      await settle(app.page);
      await app.page.waitForSelector(".signin input");
      const { violations } = await audit(app.page);
      const blocking = violations.filter((v) => BLOCKING.has(v.impact));
      console.log(report("sign-in", violations));
      assertLandmarks("sign-in", violations);
      assert.deepEqual(blocking.map((v) => v.id), [], report("sign-in (blocking)", blocking));
    } finally { await app.close(); }
  });

  await t.test("the dashboard", async () => {
    const app = await startDashboard();
    try {
      await app.page.waitForSelector("[data-section='priorities']");
      await settle(app.page);
      await app.page.waitForSelector("[data-section='priorities']");
      const { violations } = await audit(app.page);
      const blocking = violations.filter((v) => BLOCKING.has(v.impact));
      console.log(report("dashboard", violations));
      assertLandmarks("dashboard", violations);
      assert.deepEqual(blocking.map((v) => v.id), KNOWN_BLOCKING, report("dashboard (blocking)", blocking));
    } finally { await app.close(); }
  });

  await t.test("an open project drawer", async () => {
    /* Audited separately because a modal's problems - focus not moving into
       it, no way out by keyboard, no accessible name - are invisible to an
       audit of the page behind it. */
    const app = await startDashboard();
    try {
      await app.page.waitForSelector("[data-section='priorities'] .pname");
      await settle(app.page);
      /*
        Wait for the drawer's own heading, not merely the dialog wrapper - the
        wrapper mounts immediately on click, before its fetch to
        /api/projects/:id resolves (same fact Task 4 recorded). Auditing the
        loading skeleton would report on placeholder markup nobody reads.

        The click is retried while the wrapper is absent, because a click this
        browser silently dropped is not an accessibility finding and must not be
        reported as one - it surfaced here as a bare 30s selector timeout during
        a full-suite run, with nothing in the output to say the audit had simply
        never happened. Absent wrapper means the click was lost, so re-click;
        present wrapper with no heading means the fetch is the problem, and
        clicking again would only hit the backdrop and close it.
      */
      let opened = false;
      for (let attempt = 1; attempt <= 3 && !opened; attempt++) {
        await clickWhenStill(app.page, "[data-section='priorities'] .pname");
        const mounted = await app.page.waitForSelector("[role='dialog']", { timeout: 6000 })
          .then(() => true).catch(() => false);
        if (!mounted) continue;
        /* 30s, matching the default this replaced - the retry loop is here to
           make a lost click legible, not to make the test stricter than it was. */
        opened = await app.page.waitForSelector("[role='dialog'] h2", { timeout: 30_000 })
          .then(() => true).catch(() => false);
        break;
      }
      assert.ok(opened, "the drawer never opened, so the audit below never ran");

      const { violations } = await audit(app.page);
      const blocking = violations.filter((v) => BLOCKING.has(v.impact));
      console.log(report("drawer", violations));
      assertLandmarks("drawer", violations);
      assert.deepEqual(blocking.map((v) => v.id), KNOWN_BLOCKING, report("drawer (blocking)", blocking));
    } finally { await app.close(); }
  });
});
