/**
 * The UI harness's stale-profile sweep, tested without a browser.
 *
 * This lives outside `test/ui/` on purpose. That directory now means "needs a
 * browser": `npm test` excludes it from its glob, because it does not pass
 * --test-concurrency=1 and would otherwise start every UI file, and its Chrome,
 * at once. This test needs no browser and runs in tens of milliseconds, so
 * leaving it there made it reachable only through `npm run test:ui` with
 * UI_LIVE=1 - which is both the slowest way to run anything here and the way
 * most likely to fail for reasons that have nothing to do with the sweep.
 *
 * It matters that this one runs everywhere, because of what it guards.
 * `sweepStaleProfiles()` deletes Chrome profile directories only when the
 * owning pid is dead, and that pid check is the only thing stopping one process
 * deleting a live browser's profile out from under another. This test is what
 * would fail if someone decided the check looked redundant and replaced it with
 * a wholesale delete.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PROFILE_ROOT, sweepStaleProfiles } from "../ui/harness.mjs";

/**
 * The sweep's whole safety property is that it deletes by pid liveness rather
 * than by "everything I find". Several processes can share one PROFILE_ROOT -
 * two sessions in the same worktree, or a direct `node --test test/ui/...`
 * bypassing the npm scripts - so a sweep that deleted indiscriminately would
 * pull a live browser's profile out from under a sibling.
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
