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
import { clickUntil, typeUntil } from "./input.mjs";

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

     clickUntil and typeUntil already retry in place, against the page that is
     already open, which is both cheaper and sufficient - what was actually
     dropped is a single click or keystroke, not the whole session. */
  const app = await startDashboard();
  t.after(() => app.close());
  {
    const { page } = app;

    await t.test("clicking a project opens its own record, not an empty drawer", async () => {
      await page.waitForSelector("[data-section='priorities'] .pname");
      const name = await page.$eval("[data-section='priorities'] .pname",
        (el) => el.textContent.trim());

      /* A click that never lands is not an empty drawer, and must not be
         reported as one. clickUntil waits on the wrapper - which ProjectDrawer
         mounts synchronously - so this separates "the click was lost" from
         everything the assertions below are actually about. */
      await clickUntil(page, "[data-section='priorities'] .pname",
        () => !!document.querySelector("[role='dialog']"),
        { what: "a project in Priorities" });

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
  /* Same reasoning as above: the in-place retries in clickUntil and typeUntil
     are what this needs, not a whole fresh browser per attempt. */
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

     clickUntil rather than click-then-wait, and this is the case that most
     needs it: a <summary> is a toggle, so a blind retry would close what the
     first click opened. clickUntil checks the outcome before acting and so
     never clicks a disclosure that is already open. */
  await clickUntil(page, ".all-projects summary",
    () => document.querySelector(".all-projects")?.hasAttribute("open") === true,
    { what: "the all-projects disclosure" });

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

     typeUntil rather than type, because a dropped keystroke leaves the search
     box short or empty and the only symptom is that the table never narrows -
     which times out on the next line and reads as a broken filter rather than
     as a lost keypress. */
  await typeUntil(page, "input[type='search']", "zzzzz-no-such-project");
  await page.waitForFunction((n) => document.querySelectorAll("table.projects tbody tr").length < n, {}, before);
  assert.ok(await rows() < before, "the filter did not narrow the table");
  }
});
