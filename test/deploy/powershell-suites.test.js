/*
 * The deploy suites, run as part of `npm test`.
 *
 * `deploy/test/*.test.ps1` covers install, patch, uninstall, verify, preflight
 * and secret sealing - the code that touches a real host. Until 2026-09-04
 * nothing invoked any of it: no script, no package.json entry, no workflow. It
 * ran when somebody remembered to run one by hand, which is to say it gated
 * nothing. Three of the fifteen suites turned out to be quietly broken, and one
 * had been running a single check for as long as it had existed.
 *
 * Design: docs/superpowers/specs/2026-09-04-deploy-tests-in-npm-test-design.md
 *
 * WHY powershell.exe AND NOT pwsh. Windows PowerShell 5.1 is what the
 * deployment actually uses, and it is the shell that exposes the class of bug
 * found above: with $ErrorActionPreference = 'Stop' it turns a child process's
 * stderr into a TERMINATING error, so a suite that deliberately provokes a
 * failure dies at that line. seal-secret.test.ps1 reported "all passed" with a
 * full 34 checks under pwsh 7 while stopping after 33 under 5.1. Running these
 * under pwsh would hide exactly what they exist to catch.
 *
 * WHY THE SUITES RUN ONE AT A TIME. At six-way concurrency the wall time drops
 * from 145s to 62s and host-tooling.test.ps1 fails, completing 8 checks instead
 * of 14. They interfere. node:test runs subtests within a file sequentially, so
 * declaring them here - rather than as separate files - is what keeps them
 * ordered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SUITE_DIR = path.join(REPO_ROOT, "deploy", "test");
const SHELL = "powershell.exe";
const SUITE_TIMEOUT_MS = 120_000;   // slowest today is ~28s; margin for a cold start

/* Discovered from disk, not listed here: a new deploy suite gates from the
 * moment it is written. A hardcoded list is a second place to forget. */
const suites = fs.existsSync(SUITE_DIR)
  ? fs.readdirSync(SUITE_DIR).filter((f) => f.endsWith(".test.ps1")).sort()
  : [];

/* Skipped, never failed, where the shell does not exist - local CI runs through
 * Linux for some work, and a suite that cannot run there should say so rather
 * than break the build. */
const shellUsable = process.platform === "win32"
  && spawnSync(SHELL, ["-NoProfile", "-Command", "exit 0"], { timeout: 30_000 }).status === 0;
const skip = process.platform !== "win32"
  ? `not Windows (${process.platform})`
  : !shellUsable ? `${SHELL} is not usable here` : false;

/** Last lines of a suite's own output, for a failure message that explains itself. */
const tail = (s, n = 25) => s.trim().split(/\r?\n/).slice(-n).join("\n");

for (const suite of suites) {
  test(`deploy suite: ${suite}`, { skip, timeout: SUITE_TIMEOUT_MS + 30_000 }, () => {
    const r = spawnSync(
      SHELL,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(SUITE_DIR, suite)],
      { encoding: "utf8", timeout: SUITE_TIMEOUT_MS, cwd: REPO_ROOT },
    );

    assert.equal(r.error, undefined, `could not run ${suite}: ${r.error?.message}`);
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

    /*
     * Both conditions are required, and the second is the one that matters.
     * The exit code alone cannot separate these three states:
     *
     *   healthy            exit 0   prints "all passed"
     *   assertion failed   exit 1   prints "N failed"
     *   died partway       exit 1   prints no verdict at all
     *
     * Checking only the status would report a suite that ran one check out of
     * twenty as an ordinary failure - which is precisely how three suites hid
     * for months. Requiring the verdict makes that third state loud.
     */
    const failed = (out.match(/\[FAIL\]/g) ?? []).length;
    const checks = (out.match(/\[ok\]/g) ?? []).length;
    const verdict = /all passed/.test(out);

    assert.ok(
      r.status === 0 && verdict,
      `${suite} did not finish cleanly (exit ${r.status}, ${checks} checks, ${failed} [FAIL], `
      + `${verdict ? "reached its verdict" : "NO VERDICT - it stopped partway"}):\n${tail(out)}`,
    );
  });
}

test("the deploy suites were actually discovered", () => {
  assert.ok(
    suites.length >= 10,
    `found ${suites.length} suites in ${SUITE_DIR}. Every assertion above is vacuously `
    + "true when nothing is discovered, which is how a wrapper reports a clean run "
    + "while testing nothing.",
  );
});
