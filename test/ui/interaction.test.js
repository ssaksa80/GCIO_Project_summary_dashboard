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
  const app = await startDashboard();
  t.after(() => app.close());
  const { page } = app;

  await t.test("clicking a project opens its own record, not an empty drawer", async () => {
    await page.waitForSelector("[data-section='priorities'] .pname");
    const name = await page.$eval("[data-section='priorities'] .pname",
      (el) => el.textContent.trim());
    await page.click("[data-section='priorities'] .pname");

    /* Wait for the drawer's own heading, not merely the dialog wrapper - the
       wrapper mounts immediately on click, before its fetch to
       /api/projects/:id resolves, and would otherwise still be showing the
       loading skeleton when read. ProjectDrawer.jsx only renders <h2> once
       the project record has actually loaded. */
    await page.waitForSelector("[role='dialog'] h2");
    const text = await page.$eval("[role='dialog']", (el) => el.innerText);

    /* The drawer must show THIS project, not merely exist. A test that only
       waits for the element passes against an empty drawer. */
    assert.ok(text.includes(name), `the drawer does not name ${name}`);
    assert.ok(text.length > name.length + 50, "the drawer opened but is essentially empty");
  });

  await t.test("it closes again, and the portfolio is still there", async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[role='dialog']"));
    await page.waitForSelector("[data-section='priorities']");
  });
});

test("the all-projects table filters", { skip: !ui }, async (t) => {
  const app = await startDashboard();
  t.after(() => app.close());
  const { page } = app;

  /* The reference table lives inside <details open={false}> by default
     (App.jsx) - closed unless the page was opened with ?table=1. This
     Chrome does not hide a closed <details>'s content via display:none (it
     still measures as display:table), so waitForSelector finds the rows
     either way - but typing into the search box silently lands nowhere:
     confirmed directly, the input's .value stayed "" after page.type() with
     the panel closed. Open it first, the same way a real user would click
     the summary to see the table at all. */
  await page.waitForSelector(".all-projects summary");
  await page.click(".all-projects summary");
  await page.waitForFunction(() => document.querySelector(".all-projects").hasAttribute("open"));

  /* Scoped to the portfolio table specifically (its own "projects" class,
     an existing hook - not a new one) rather than a bare "table tbody tr":
     four other sections (QRI x2, Roadmap, Posture) render their own <table
     className="tbl"> with real rows, and counting across all of them would
     dilute what "narrower" actually proves. */
  const rows = async () => page.$$eval("table.projects tbody tr", (els) => els.length);

  await page.waitForSelector("table.projects tbody tr");
  const before = await rows();
  assert.ok(before > 1, `the table rendered ${before} rows`);

  /* Narrowing must actually narrow. A filter that silently does nothing
     looks identical to one that matched everything. */
  await page.type("input[type='search']", "zzzzz-no-such-project");
  await page.waitForFunction((n) => document.querySelectorAll("table.projects tbody tr").length < n, {}, before);
  assert.ok(await rows() < before, "the filter did not narrow the table");
});
