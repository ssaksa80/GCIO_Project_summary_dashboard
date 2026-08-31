# UI Harness Profile Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `test/ui/harness.mjs` leaking Chrome profile directories into
`%LOCALAPPDATA%\Temp` by giving puppeteer an explicit `userDataDir` inside the
repo and removing it in `teardown()` after the process is confirmed gone.

**Architecture:** Puppeteer only removes a profile directory it created itself,
and only on a clean `browser.close()`. The harness deliberately tree-kills a
close that hangs under load, so neither Chrome nor puppeteer ever runs cleanup
and the directory ends up owned by nobody. Passing `userDataDir` moves ownership
to the harness: puppeteer then creates nothing in `%TEMP%`, `teardown()` removes
the directory itself with a short retry (a tree-kill returns before Windows
releases file handles), and a pid-keyed boot sweep reclaims directories from
runs that were killed before `teardown()` could run.

**Tech Stack:** Node 24, `node:test`, `puppeteer-core` 25.8.0, Windows.

**Spec:** `docs/superpowers/specs/2026-08-30-ui-harness-profile-cleanup-design.md`

---

## Context an engineer needs before starting

**Run the UI suite with:**

```bash
UI_LIVE=1 npm run test:ui
```

Every file in `test/ui/` self-skips unless `UI_LIVE=1`, so a bare `npm test`
runs none of the browser tests. On PowerShell the equivalent is
`$env:UI_LIVE=1; npm run test:ui`. `npm run build` must have been run at least
once, or `boot()` fails early with a message saying so.

**Shared working tree.** Another Claude session is committing to
`feat/p4-ui-testing` in this same worktree. Never use bare `git stash` (the
stack is shared across worktrees), never amend or rebase published commits, and
confirm `git status` is clean before starting.

**These suites are load-sensitive.** A full run has gone 29 pass / 0 fail on a
quiet box and 11 pass / 12 fail while another process was running heavy test
suites. Measure on a quiet machine or the numbers mean nothing.

**Existing structure of `test/ui/harness.mjs`,** so additions land in the right
places:

- `active` - a `Set` of `{ server, browser }` entries, declared near the top
- `ensureAfterHook()` - the once-per-process guard pattern to copy
- `dlog()` - debug logging behind `HARNESS_DEBUG=1`
- `killProcessTree()` - the `taskkill /T /F` escalation
- `process.on("exit")` - the synchronous last resort
- `teardown(entry)` - the shared bounded teardown
- `boot()` - spawns the server, launches the browser, returns `close()`

## File structure

| File | Change | Responsibility |
|---|---|---|
| `.gitignore` | Modify | Ignore `/.tmp/`, so profile directories never reach a diff |
| `test/ui/harness.mjs` | Modify | Own, create and remove the profile directory; sweep stale ones |
| `test/ui/harness.test.js` | Modify | Assert the sweep's pid rule, and that a boot/close cycle leaves nothing behind |

No new files. The profile logic is around sixty lines and belongs beside the
teardown machinery it is part of; splitting it out would separate it from the
`killProcessTree`/`teardown` reasoning that explains why it exists at all.

**New exported surface from `harness.mjs`,** needed so the sweep's pid rule can
be tested without booting a browser:

- `PROFILE_ROOT: string` - absolute path to `<repo>/.tmp/ui-profiles`
- `sweepStaleProfiles(): void` - remove profile dirs whose owning pid is gone

**Changed return shape:** `startDashboard()` and `startDashboardSignedOut()`
gain a `userDataDir` property alongside `page`, `baseUrl` and `close`.

---

### Task 1: Ignore the profile directory before anything can write to it

First on purpose. If any later task runs before `.gitignore` is right, the next
`git add` sweeps a Chrome profile into a commit.

**Files:**
- Modify: `.gitignore` (append at end)

- [ ] **Step 1: Add the entry**

Append to `.gitignore`, matching the anchored-and-commented style the rest of
the file already uses:

```gitignore

# Chrome profile directories for the UI suite. Puppeteer is given an explicit
# userDataDir here rather than one under %TEMP%, because it only cleans up its
# own temp profile on a clean browser.close() and this harness tree-kills a
# close that hangs. Anchored for the same reason as audit/ and vault/ above.
/.tmp/
```

- [ ] **Step 2: Verify git actually ignores the path**

```bash
mkdir -p .tmp/ui-profiles/run-1-0 && git check-ignore -v .tmp/ui-profiles/run-1-0 && git status --porcelain
```

Expected: `check-ignore` prints a line ending `/.tmp/  .tmp/ui-profiles/run-1-0`,
and `git status --porcelain` shows only `.gitignore` as modified, with no
`.tmp/` entry. If `.tmp/` appears in status, the entry is wrong - fix it before
continuing.

- [ ] **Step 3: Remove the probe directory**

```bash
rm -rf .tmp
```

- [ ] **Step 4: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore the UI suite's Chrome profile directory"
```

---

### Task 2: The stale-profile sweep

Written before the wiring because it is pure filesystem and pid logic - no
browser, no server - so its test is fast and runs under a plain `npm test`.

**Files:**
- Modify: `test/ui/harness.mjs`
- Test: `test/ui/harness.test.js`

- [ ] **Step 1: Write the failing test**

`test/ui/harness.test.js` currently imports only `test`, `assert` and
`startDashboard`. Extend those imports - merge, do not duplicate the
`startDashboard` import:

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDashboard, PROFILE_ROOT, sweepStaleProfiles } from "./harness.mjs";
```

Then append this test. It needs no `UI_LIVE` gate, because it boots nothing:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test test/ui/harness.test.js
```

Expected: FAIL with `SyntaxError: The requested module './harness.mjs' does not
provide an export named 'PROFILE_ROOT'`.

- [ ] **Step 3: Implement the sweep**

In `test/ui/harness.mjs`, immediately after the `const active = new Set();`
block near the top, add:

```js
/**
 * Where Chrome's profile lives. Owned by this harness, not by puppeteer.
 *
 * Given no `userDataDir`, puppeteer creates a temporary profile and removes it
 * on a clean `browser.close()` - a promise this harness cannot keep, because it
 * deliberately tree-kills a close that hangs under load (see the header). A
 * tree-killed Chrome never cleans up after itself, and a `close()` that never
 * returned never cleans up either, so the directory ends up owned by nobody:
 * fourteen of them, 256MB, after one session of repeated runs.
 *
 * Inside the repo rather than under %TEMP% for a second reason. This machine
 * runs Defender for Endpoint, and a profile directory here inherits whatever
 * exclusion the repo already carries. The equivalent exclusion for %TEMP% could
 * only be written as a wildcard, which is a malware-persistence pattern and is
 * correctly refused - so a Temp path is one nobody can legitimately exclude.
 */
const PROFILE_ROOT = path.join(ROOT, ".tmp", "ui-profiles");
export { PROFILE_ROOT };

/** Is this pid still running? `process.kill(pid, 0)` sends no signal and only
 *  probes: ESRCH means gone, EPERM means alive but not ours to touch. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unparseable: treat as live, never delete
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== "ESRCH";
  }
}

/**
 * Reclaim profile directories from runs that never reached teardown() - a
 * Ctrl-C, a crashed node, a machine that went down mid-suite.
 *
 * Only directories whose owning pid is gone are touched, and that is the whole
 * safety argument: `UI_LIVE=1 npm test` globs test/ui at default concurrency,
 * so several processes share PROFILE_ROOT at once, and a sweep that deleted
 * everything it found would delete a sibling's live profile.
 *
 * Best-effort throughout. A sweep that throws must not stop a boot: a leaked
 * directory costs disk, a failed boot costs the whole suite.
 */
export function sweepStaleProfiles() {
  let entries;
  try {
    entries = fs.readdirSync(PROFILE_ROOT, { withFileTypes: true });
  } catch {
    return; // not created yet, which is the common case
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = /^run-(\d+)-\d+$/.exec(entry.name);
    if (!match) continue;
    if (pidAlive(Number(match[1]))) continue;
    try {
      fs.rmSync(path.join(PROFILE_ROOT, entry.name), { recursive: true, force: true });
      dlog(`swept stale profile dir ${entry.name}`);
    } catch (err) {
      dlog(`could not sweep ${entry.name}:`, err.message);
    }
  }
}

/** Once per process, before the first launch - same guard shape as
 *  ensureAfterHook() below. */
let sweptThisProcess = false;
function ensureSwept() {
  if (sweptThisProcess) return;
  sweptThisProcess = true;
  sweepStaleProfiles();
}
```

`dlog` is declared further down the file as a `function` declaration, which
hoists, so calling it from `sweepStaleProfiles()` above its definition is fine.

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test test/ui/harness.test.js
```

Expected: PASS for "the sweep removes dead-pid profile dirs and leaves live ones
alone". The browser tests report as skipped, because `UI_LIVE` is unset.

- [ ] **Step 5: Mutation-check that the test can actually fail**

Temporarily change `if (pidAlive(Number(match[1]))) continue;` to
`if (false) continue;` and re-run the same command.

Expected: FAIL on `"a profile dir whose owning pid is alive must survive"`.
That proves the assertion is load-bearing rather than passing by accident.
Revert the change and re-run to confirm PASS.

- [ ] **Step 6: Commit**

```bash
git add test/ui/harness.mjs test/ui/harness.test.js
git commit -m "test(ui): reclaim profile dirs whose owning process is gone"
```

---

### Task 3: Own the profile directory through boot and teardown

**Files:**
- Modify: `test/ui/harness.mjs`
- Test: `test/ui/harness.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/ui/harness.test.js`:

```js
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

test("a booted app owns its profile dir, and close() removes it", { skip: !ui }, async (t) => {
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

  assert.equal(fs.existsSync(app.userDataDir), false, "close() should have removed the profile dir");
  assert.equal(
    countTempProfiles(),
    tempBefore,
    "puppeteer should have created no profile dir of its own in os.tmpdir()",
  );
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
UI_LIVE=1 node --test test/ui/harness.test.js
```

Expected: FAIL with `TypeError: Cannot read properties of undefined (reading
'startsWith')`, because `app.userDataDir` does not exist yet. With the old
behaviour intact, `countTempProfiles()` would also have grown by one.

- [ ] **Step 3: Add directory creation and removal**

In `test/ui/harness.mjs`, after the `ensureSwept()` block from Task 2, add:

```js
/** One directory per booted app. The sequence counts within the process,
 *  because a single test file boots many apps; the pid is what the sweep
 *  keys on. */
let profileSeq = 0;
function newProfileDir() {
  const dir = path.join(PROFILE_ROOT, `run-${process.pid}-${profileSeq++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove a profile directory, retrying briefly.
 *
 * `taskkill /T /F` returns before Windows has released Chrome's file handles,
 * so an rmSync fired immediately after a tree-kill meets EBUSY or EPERM. Five
 * attempts 100ms apart is far more patience than handle release needs and far
 * less than anyone notices. A final failure is logged and swallowed: a profile
 * directory that will not delete is a disk problem, and it must never turn a
 * passing test red.
 */
async function removeProfileDir(dir) {
  if (!dir) return;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      dlog(`removed profile dir ${dir} on attempt ${attempt}`);
      return;
    } catch (err) {
      if (attempt === 5) {
        dlog(`could not remove profile dir ${dir} after ${attempt} attempts:`, err.message);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
```

- [ ] **Step 4: Remove the directory at the end of teardown()**

In `teardown()`, after the closing brace of the
`if (server.exitCode === null && server.signalCode === null) { ... }` block and
before the function's own closing brace, add:

```js
  /* Last, never first. The browser tree-kill above returns before Windows has
     released Chrome's handles, and the server teardown in between buys some of
     that time for free. */
  await removeProfileDir(entry.userDataDir);
```

- [ ] **Step 5: Add the best-effort attempt to the exit handler**

Replace the body of the existing `process.on("exit", ...)` handler with:

```js
process.on("exit", () => {
  for (const entry of active) {
    killProcessTree(entry.browser?.process()?.pid);
    killProcessTree(entry.server.pid);
    /* One synchronous attempt, no retry. Exit handlers must not block, and
       handles are very likely still open a millisecond after a tree-kill, so
       this will often fail. That is fine - the boot sweep, not this, is the
       mechanism being relied on. */
    if (entry.userDataDir) {
      try {
        fs.rmSync(entry.userDataDir, { recursive: true, force: true });
      } catch {
        /* Next run's sweep will get it. */
      }
    }
  }
});
```

- [ ] **Step 6: Wire it into boot()**

In `boot()`, immediately after the `client/dist` existence check, add:

```js
  ensureSwept();
```

Then change the entry construction, so the directory exists before the browser
launches and is tracked from the start. The `catch` at the bottom of `boot()`
calls `teardown(entry)`, so this also makes a failed boot clean up its own
profile:

```js
  const userDataDir = newProfileDir();
  const entry = { server, browser: null, userDataDir };
```

Pass it to puppeteer:

```js
    const browser = await puppeteer.launch({
      executablePath: findBrowser(),
      headless: "new",
      userDataDir,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
```

And return it, so a test can assert on it:

```js
    return { page, baseUrl, close, userDataDir };
```

- [ ] **Step 7: Update the three doc comments that describe the return shape**

The file header says both start functions "resolve to `{ page, baseUrl, close }`".
Change it to `{ page, baseUrl, close, userDataDir }`. Make the same change in
the `@returns` JSDoc on `startDashboard` and on `startDashboardSignedOut`.

- [ ] **Step 8: Run the tests and watch them pass**

```bash
UI_LIVE=1 node --test test/ui/harness.test.js
```

Expected: PASS for both the sweep test and the new boot/close test.

- [ ] **Step 9: Commit**

```bash
git add test/ui/harness.mjs test/ui/harness.test.js
git commit -m "fix(test): own the Chrome profile dir instead of leaking it"
```

---

### Task 4: Verify against the whole suite and record the measurement

The spec is explicit that the tree-kill and crash paths are measured by hand
rather than faked into a test. This task is that measurement.

**Files:** none modified.

- [ ] **Step 1: Count what exists before**

```bash
ls "$LOCALAPPDATA/Temp" | grep -c '^puppeteer_dev_chrome_profile-'
```

Record that number, and confirm `.tmp/ui-profiles` is absent or empty.

Do not use `du` to size any of these directories. `du -m` rounds every
directory up to at least 1MB, so summing per-directory values across thousands
of near-empty dirs yields a total that tracks the directory count rather than
any real size - that mistake turned 0.77MB of files into a reported 1759MB
earlier in this work. Sum actual file lengths instead.

- [ ] **Step 2: Run the full UI suite**

```bash
UI_LIVE=1 npm run test:ui
```

Expected: the same pass count as before this change, with no new failures. Run
it on an otherwise quiet machine.

- [ ] **Step 3: Count again**

```bash
ls "$LOCALAPPDATA/Temp" | grep -c '^puppeteer_dev_chrome_profile-'
ls .tmp/ui-profiles 2>/dev/null | wc -l
```

Expected: the `%TEMP%` count is unchanged from Step 1, and `.tmp/ui-profiles`
is empty. A `%TEMP%` count that grew means `userDataDir` is not reaching
`puppeteer.launch()`.

- [ ] **Step 4: Verify the crash path**

Start a run and interrupt it partway with Ctrl-C:

```bash
UI_LIVE=1 npm run test:ui
```

Then check that a directory was stranded, and that the next boot reclaims it:

```bash
ls .tmp/ui-profiles
UI_LIVE=1 node --test test/ui/harness.test.js
ls .tmp/ui-profiles
```

Expected: at least one `run-<pid>-<n>` after the interrupt, and none after the
next run. This is the case the sweep exists for.

- [ ] **Step 5: Confirm nothing untracked appeared**

```bash
git status --porcelain
```

Expected: empty. If `.tmp/` shows up, Task 1 did not take.

- [ ] **Step 6: Commit the measurement**

Nothing to add, so record it as an empty commit against the spec's success
criteria, substituting the numbers actually observed:

```bash
git commit --allow-empty -m "test(ui): verify the profile leak is closed

Full UI suite, quiet box: <N> pass / <M> fail, unchanged from before.
puppeteer_dev_chrome_profile-* in %TEMP%: <X> before, <X> after.
.tmp/ui-profiles empty at the end. Interrupted run stranded <K> dirs;
the next boot's sweep removed them."
```

---

## Notes for whoever executes this

**Do not widen the scope.** Two adjacent leaks are known, recorded in the spec's
Out of scope, and deliberately not fixed here:

- 2282 `gcio-*` directories in `os.tmpdir()`, from `mkdtempSync` with no removal
  in `test/vault.test.js`, `test/audit/fileAudit.test.js`,
  `test/ingest/watcher.test.js`, `test/db/live.test.js` and
  `test/api/app.test.js`. Measured: 1945 files, 0.77MB total, 496 of the
  directories completely empty. Directory-entry clutter, not a disk problem.
- `scripts/capture-screens.mjs`, `scripts/compress-screens.mjs`,
  `scripts/e2e-signin.mjs` and `scripts/e2e-sso.mjs` all launch puppeteer the
  same way and leak identically.

**Do not delete anything else in `%TEMP%`.** It holds around 65,000 entries
belonging to other software. The only directories this work may remove are ones
it created under `.tmp/ui-profiles/`.

**Do not try to add a Defender exclusion for `%TEMP%`.** It was already
attempted and blocked by AMSI, correctly - a wildcard exclusion under a user's
Temp is a standard malware-persistence move. The repo-local profile directory is
the legitimate way to get the same benefit, and it needs no new exclusion.

**Do not claim this fixes the UI suites' flakiness.** A repo-path Defender
exclusion has already been applied on this machine and the suites still failed
the same way, with `mssense` at 169% of a core and `msmpeng` at 82% immediately
afterwards. Inheriting the exclusion is strictly better than a Temp path nobody
can exclude, but on this box it has not yet been shown to change the failure
rate. This change fixes a leak; treat any flakiness improvement as unproven.
