/**
 * Task 2 — the sections render.
 *
 * The CIO reads five sections in a fixed order: Successes, Questions/Risks/
 * Issues, Priorities, Roadmap, Posture. That order was an explicit
 * instruction and nothing server-side guards it - only a real render does.
 *
 * Self-skips unless UI_LIVE=1, exactly like the live SQL suite:
 *
 *     UI_LIVE=1 node --test test/ui/render.test.js
 */
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
       "nothing to report" rather than "the builder threw".
       NOTE: two of the five sections (successes, priorities) render their
       repeating content as plain <div>s rather than <li> or <table><tr> - see
       the report for details - so the selector also matches the data-row
       seam added to those rows. */
    for (const name of ["successes", "qri", "priorities", "roadmap", "posture"]) {
      const count = await page.$$eval(
        `[data-section="${name}"] li, [data-section="${name}"] tr, [data-section="${name}"] [data-row]`,
        (els) => els.length).catch(() => 0);
      assert.ok(count > 0, `section ${name} rendered no rows`);
    }
  });
});
