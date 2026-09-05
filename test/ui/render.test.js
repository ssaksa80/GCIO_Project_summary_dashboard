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

  await t.test("a slipped project's target date is not buried under the slip hatching", async () => {
    /* .lane-slip is an overlay running from target to forecast, and it follows
       .lane-bar in the DOM. With everything at z-index auto it therefore
       painted OVER the date label inside the bar. Any project whose target
       sits near the start of the horizon has a slip beginning at almost 0%,
       so the hatch covered the whole bar and the date was unreadable -- while
       lanes whose fill ran past the label looked fine, which is why this
       presented as intermittent rather than broken.

       Asserted by hit-testing rather than by reading the CSS: elementFromPoint
       at the centre of the label answers the only question that matters, which
       is what a reader's eye actually lands on. A test that asserted
       "z-index is 2" would pass against a stacking context that made it
       meaningless. */
    /* elementFromPoint only answers for coordinates inside the viewport, so
       the lanes must actually be on screen. The first version of this test
       skipped that, found every lane off-screen, filtered them all out and
       passed -- including against the unfixed CSS. It has to scroll, and it
       has to refuse to pass when it tested nothing. */
    await page.$eval(".gantt", (el) => el.scrollIntoView({ block: "center" }));
    await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));

    const result = await page.$$eval(".lane", (lanes) => {
      const onScreen = [];
      const covered = [];
      for (const lane of lanes) {
        const tag = lane.querySelector(".lane-tag");
        const slip = lane.querySelector(".lane-slip");
        if (!tag) continue;

        const r = tag.getBoundingClientRect();
        if (r.width === 0 || r.top < 0 || r.bottom > window.innerHeight) continue;
        onScreen.push(tag.textContent.trim());
        if (!slip) continue;

        /* Only lanes where the hatch spans the label can show the defect. */
        const s = slip.getBoundingClientRect();
        if (!(s.left <= r.left && s.right >= r.right)) continue;

        const top = document.elementFromPoint(
          Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        covered.push({ date: tag.textContent.trim(), topmost: top ? String(top.className) : "none" });
      }
      return { onScreen: onScreen.length, covered };
    });

    assert.ok(result.onScreen > 0,
      "no lane was on screen, so this test could not have failed either way");
    assert.ok(result.covered.length > 0,
      `${result.onScreen} lanes on screen but none had its date under the slip overlay -- ` +
      "either the fixture no longer contains an overrunning project, or the overlay stopped " +
      "being drawn; both make this assertion vacuous");

    for (const lane of result.covered) {
      assert.match(lane.topmost, /lane-tag/,
        `the date "${lane.date}" is behind ${lane.topmost}, so it reads as hatching`);
    }
  });
});
