/**
 * Task 4 — the parts a user touches.
 *
 * Three things a real person does with this dashboard, none of which any
 * server test can see: get turned away before sign-in, open one project and
 * get back, and narrow the reference table.
 *
 * Self-skips unless UI_LIVE=1, exactly like the live SQL suite:
 *
 *     UI_LIVE=1 node --test test/ui/interaction.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard, startDashboardSignedOut } from "./harness.mjs";

const ui = process.env.UI_LIVE === "1";

test("the sign-in gate keeps the portfolio behind it", { skip: !ui }, async (t) => {
  /* The one with real consequences. Asserting a form is present proves
     nothing - what matters is that no portfolio data reached the page. */
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
  /* No withDashboard wrapper here, deliberately, and this was measured rather
     than assumed. Wrapping a test whose body calls t.test() re-registers those
     subtests on every retry, and node:test does not take kindly to it - "it
     closes again" started failing at exactly the 30s mark. Worse, each retry
     boots another server and browser, so a run under load produced ten to
     fourteen extra boots, which is itself load: transport failure caused a
     retry, the retry caused more transport failure. Test durations went from
     ~12s to 151-263s.

     This file no longer drives real mouse or key input at all, so there is
     nothing left for a retry to rescue: each action either dispatches through
     the DOM or does not happen. */
  const app = await startDashboard();
  t.after(() => app.close());
  {
    const { page } = app;

    await t.test("clicking a project opens its own record, not an empty drawer", async () => {
      await page.waitForSelector("[data-section='priorities'] .pname");
      const name = await page.$eval("[data-section='priorities'] .pname",
        (el) => el.textContent.trim());

      /*
        Two claims, separated, because together they depended on the least
        reliable thing this machine does.

        The first is reachability: that nothing covers the button, which is the
        property a coordinate click actually tests. document.elementFromPoint at
        the button's own centre answers it as a DOM query, with no input event
        to be dropped. If something ever does cover the trigger, this fails and
        says so.

        The second is behaviour, driven by el.click(). That dispatches a real
        click event through React's handler, so everything the assertions below
        care about - the right project opening, the drawer not being empty - is
        exercised exactly as before.

        What is given up is the browser's own mouse hit-testing, which is the
        browser's job rather than this application's, and which measured as
        unreliable enough here to fail the test roughly half the time for
        reasons that had nothing to do with the app. Real key dispatch is still
        driven, and still asserted, in keyboard.test.js - where it is the
        subject rather than the transport.
      */
      await page.waitForSelector("[data-section='priorities'] .pname");
      const reachable = await page.$eval("[data-section='priorities'] .pname", (el) => {
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { hit: !!top && (top === el || el.contains(top) || top.contains(el)),
                 covering: top ? top.tagName.toLowerCase() + "." + String(top.className).split(/\s+/)[0] : "(nothing)" };
      });
      assert.ok(reachable.hit,
        `the project trigger is not clickable at its own centre - ${reachable.covering} is on top of it`);

      await page.$eval("[data-section='priorities'] .pname", (el) => el.click());
      await page.waitForSelector("[role='dialog']", { timeout: 15_000 });

      /* Wait for the drawer's own heading, not merely the dialog wrapper - the
         wrapper mounts immediately on click, before its fetch to
         /api/projects/:id resolves, and would otherwise still be showing the
         loading skeleton when read. ProjectDrawer.jsx only renders <h2> once
         the project record has actually loaded.

         Deliberately NOT treated as transport: by this point the drawer is
         open, so a heading that never arrives means the record did not load,
         which is exactly the "empty drawer" this test exists to catch. */
      await page.waitForSelector("[role='dialog'] h2");
      const heading = await page.$eval("[role='dialog'] h2", (el) => el.textContent.trim());
      const text = await page.$eval("[role='dialog']", (el) => el.innerText);

      /* The drawer must show THIS project, not merely exist. A test that only
         waits for the element passes against an empty drawer.

         The heading is checked specifically, not merely "the name appears
         somewhere in the drawer". Mutation testing caught that weaker form
         passing against a drawer whose <h2> had been replaced with a literal:
         the drawer's own project tree renders the same project's name lower
         down, so the name was present and the assertion held while the heading
         was wrong. Checking innerText for the name is the kind of assertion
         that looks strict and is not. */
      assert.equal(heading, name,
        `the drawer's heading reads "${heading}", not "${name}"`);
      assert.ok(text.length > name.length + 50, "the drawer opened but is essentially empty");
    });

    await t.test("it closes again, and the portfolio is still there", async () => {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("[role='dialog']"));
      await page.waitForSelector("[data-section='priorities']");
    });
  }
});

test("the all-projects table filters", { skip: !ui }, async (t) => {
  /* Same reasoning as above: one dashboard for the whole test, no per-attempt
     browser, and nothing here depends on an input event surviving the trip. */
  const app = await startDashboard();
  t.after(() => app.close());
  {
  const { page } = app;

  /* The reference table lives inside <details open={false}> by default
     (App.jsx) - closed unless the page was opened with ?table=1. This
     Chrome does not hide a closed <details>'s content via display:none (it
     still measures as display:table), so waitForSelector finds the rows
     either way - but typing into the search box silently lands nowhere:
     confirmed directly, the input's .value stayed "" after page.type() with
     the panel closed. Open it first, the same way a real user would click
     the summary to see the table at all.

     The open check happens inside the same evaluate as the click, because a
     <summary> is a toggle: acting without first testing the outcome is how a
     retry closes what the previous attempt opened. */
  await page.waitForSelector(".all-projects summary");
  await page.$eval(".all-projects summary", (el) => {
    if (!el.closest("details").hasAttribute("open")) el.click();
  });
  await page.waitForFunction(
    () => document.querySelector(".all-projects")?.hasAttribute("open") === true,
    { timeout: 10_000 });

  /* Scoped to the portfolio table specifically (its own "projects" class,
     an existing hook - not a new one) rather than a bare "table tbody tr":
     four other sections (QRI x2, Roadmap, Posture) render their own <table
     className="tbl"> with real rows, and counting across all of them would
     dilute what "narrower" actually proves. */
  const rows = async () => page.$$eval("table.projects tbody tr", (els) => els.length);

  await page.waitForSelector("table.projects tbody tr");
  const before = await rows();
  assert.ok(before > 1, `the table rendered ${before} rows`);

  /* Narrowing must actually narrow. A filter that silently does nothing looks
     identical to one that matched everything.

     The value is set through React's own input path rather than typed, so a
     dropped keystroke cannot leave the box holding half a word and make a
     working filter look broken. */
  /* Short on purpose. ProjectTable debounces its refetch by 200ms, and a longer
     string takes long enough to type that the refetch lands mid-way - after
     which this browser stops delivering key events to the page entirely (no
     keydown, no input, though the field still reports as focused, and it never
     recovers). Four characters complete well inside the debounce, so the
     refetch happens after typing rather than during it. "zzzz" matches no
     project, which is all the assertion below needs. */
  /* Driven through React's own input path rather than by pressed keys: the
     prototype's value setter, then an `input` event, which is exactly what a
     keystroke produces once the browser has translated it. Measured working -
     the field holds the text and the table goes 59 rows to 1 - where pressed
     keys on this machine stop being delivered mid-word, leaving "zz" of "zzzz"
     and a filter that looks broken when it is not. The key-to-input translation
     that is skipped here is the browser's, not this application's. */
  await page.$eval("input[type='search']", (el) => {
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setValue.call(el, "zzzz");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction((sel) => document.querySelector(sel)?.value === "zzzz",
    { timeout: 10_000 }, "input[type='search']");
  await page.waitForFunction((n) => document.querySelectorAll("table.projects tbody tr").length < n, {}, before);
  assert.ok(await rows() < before, "the filter did not narrow the table");
  }
});
