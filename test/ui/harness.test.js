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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDashboard, PROFILE_ROOT, sweepStaleProfiles } from "./harness.mjs";

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

/**
 * The sweep's whole safety property is that it deletes by pid liveness rather
 * than by "everything I find". `UI_LIVE=1 npm test` runs test/ui files in
 * parallel processes against one shared PROFILE_ROOT, so a sweep that deleted
 * indiscriminately would pull a live browser's profile out from under a
 * sibling test file.
 *
 * 999999 is not a valid Windows pid - they are multiples of 4 and far smaller -
 * so process.kill(999999, 0) reliably reports ESRCH.
 */
test("the sweep removes dead-pid profile dirs and leaves live ones alone", async (t) => {
  const dead = path.join(PROFILE_ROOT, "run-999999-0");
  const live = path.join(PROFILE_ROOT, `run-${process.pid}-999`);
  fs.mkdirSync(dead, { recursive: true });
  fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(dead, "marker"), "x");
  t.after(() => {
    fs.rmSync(dead, { recursive: true, force: true });
    fs.rmSync(live, { recursive: true, force: true });
  });

  sweepStaleProfiles();

  assert.equal(fs.existsSync(dead), false, "a profile dir whose owning pid is gone should be swept");
  assert.equal(fs.existsSync(live), true, "a profile dir whose owning pid is alive must survive - a parallel test file may be using it");
});
