/**
 * Task 3 — the change badges, which are the newest and least verified thing.
 *
 * The badge has four states and one of them must not be green - that is a
 * computed-colour fact no server test can see. Colours confirmed against
 * client/src/themes.css, which defines them once in :root and does not
 * override them per theme:
 *   --s192  #e40046 -> rgb(228, 0, 70)   worse
 *   --p354  #00b140 -> rgb(0, 177, 64)   better
 *   --sgrey #414141 -> rgb(65, 65, 65)   neutral and newly-tracked
 *
 * Self-skips unless UI_LIVE=1, exactly like the live SQL suite:
 *
 *     UI_LIVE=1 node --test test/ui/changes.test.js
 */
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
