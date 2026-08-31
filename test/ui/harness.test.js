/**
 * Proves the harness itself before anything else is written against it:
 * the server boots, the browser signs in, a known element is on the page,
 * and close() actually tears both down.
 *
 * Self-skips unless UI_LIVE=1, exactly like the live SQL suite. That skip is no
 * longer what keeps `npm test` hermetic, though: its glob excludes test/ui
 * outright, so it never reaches this file either way. Run it directly, or via
 * `npm run test:ui`:
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
 * than by "everything I find". Several processes can share one PROFILE_ROOT -
 * two sessions in the same worktree, or a direct `node --test test/ui/...`
 * bypassing the npm scripts - so a sweep that deleted indiscriminately would
 * pull a live browser's profile out from under a sibling.
 *
 * `UI_LIVE=1 npm test` used to be the headline case and no longer is: that
 * script's glob now excludes test/ui. See sweepStaleProfiles() in harness.mjs
 * for why the check is not obsolete regardless.
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

/** Counted rather than asserted absolute: other software on this machine may
 *  hold pre-existing puppeteer profile dirs, and %TEMP% has around 65,000
 *  entries belonging to things that are none of this suite's business. */
function countTempProfiles() {
  try {
    return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("puppeteer_dev_chrome_profile-")).length;
  } catch {
    return 0;
  }
}

test("a booted app owns its profile dir, and puppeteer leaks none into %TEMP%", { skip: !ui }, async (t) => {
  const tempBefore = countTempProfiles();
  const app = await startDashboard();
  let closedHere = false;
  t.after(() => (closedHere ? undefined : app.close()));

  assert.ok(
    app.userDataDir.startsWith(PROFILE_ROOT),
    `expected the profile inside ${PROFILE_ROOT}, got ${app.userDataDir}`,
  );
  assert.equal(fs.existsSync(app.userDataDir), true, "the profile dir should exist while the browser is running");

  await app.close();
  closedHere = true;

  /* This is the assertion that actually pins the bug. The leak was never that a
     directory outlived a test - it was that puppeteer created one in %TEMP%
     that nobody owned. Counted rather than absolute, because other software on
     this machine holds pre-existing ones. */
  assert.equal(
    countTempProfiles(),
    tempBefore,
    "puppeteer should have created no profile dir of its own in os.tmpdir()",
  );

  /* Removal itself is best-effort by design, and this deliberately does not
     assert it always wins. Measured on the tree-kill path: the browser process
     is gone within a millisecond, rmSync still returns EPERM five seconds
     later, and the directory deletes fine a minute after that. Windows releases
     the handles on its own schedule. Asserting immediate removal here would be
     asserting that teardown wins a race it does not control, which is how a
     suite acquires a flaky test that everyone learns to re-run.

     What must hold is that nothing escapes the backstop: whatever teardown
     could not remove is still named so the next boot's sweep will reclaim it. */
  if (fs.existsSync(app.userDataDir)) {
    assert.match(
      path.basename(app.userDataDir),
      /^run-\d+-\d+$/,
      "a profile dir teardown could not remove must still be named so the boot sweep can reclaim it",
    );
  }
});
