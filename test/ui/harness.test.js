/**
 * Proves the harness itself before anything else is written against it:
 * the server boots, the browser signs in, a known element is on the page,
 * and close() actually tears both down.
 *
 * Self-skips unless UI_LIVE=1, exactly like the live SQL suite, so `npm test`
 * stays hermetic:
 *
 *     UI_LIVE=1 node --test test/ui/harness.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startDashboard } from "./harness.mjs";

const ui = process.env.UI_LIVE === "1";

test("the harness boots the real app in a real browser and signs in", { skip: !ui }, async (t) => {
  const app = await startDashboard();
  t.after(() => app.close());

  const title = await app.page.title();
  assert.equal(title, "GCIO · Project Intelligence");

  /* .sec-nav only exists once the dashboard has rendered past sign-in. */
  const sectionCount = await app.page.$$eval(".sec-nav button, .sec-nav a", (els) => els.length);
  assert.ok(sectionCount > 0, "expected at least one section nav entry after sign-in");

  const who = await app.page.$eval(".who", (el) => el.textContent.trim());
  assert.match(who, /pat/i, `expected the signed-in identity chip to mention the dev user, got "${who}"`);
});
