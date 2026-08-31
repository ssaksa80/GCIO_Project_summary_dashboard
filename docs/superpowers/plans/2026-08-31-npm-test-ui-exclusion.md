# Keep the UI Suites Out of `npm test` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm test` incapable of running the UI suites, so the
load-sensitive browser tests can never be started in parallel by the shorter
command.

**Architecture:** One line of `package.json`. The `test` script's glob changes
from `test/**/*.test.js` to a two-glob form that excludes `test/ui`, and a
`test:all` script is added for anyone who wants one command for everything.
Two existing comments that assert the opposite are then corrected — one of
them justifies a safety check by the very command being disabled, and must be
rewritten rather than deleted.

**Tech Stack:** Node 24.19.0, `node:test`, npm scripts.

**Spec:** `docs/superpowers/specs/2026-08-31-npm-test-ui-exclusion-design.md`

---

## Context an engineer needs before starting

**Measured baselines, taken on this repo at `01cfa96` immediately before this
plan was written.** These are the numbers the steps below compare against:

```
npm test today                                327 tests, 316 pass, 0 fail, 11 skipped, ~50s
node --test "test/!(ui)/**/*.test.js" "test/*.test.js"
                                              316 tests, 315 pass, 0 fail,  1 skipped, ~45s
```

So `test/ui` contributes exactly **11 tests** to `npm test`: 10 that skip
because `UI_LIVE` is unset, and 1 that runs unconditionally — the sweep test in
`test/ui/harness.test.js`, which needs no browser. The 1 remaining skip after
exclusion is from a non-UI suite and is expected to stay.

**`test/ingest/watcher.test.js` is flaky.** It failed with `0 !== 1` at
`watcher.test.js:50` on one baseline run and passed on the next, with no code
change between them. It is unrelated to this work. Do not be alarmed by it, do
not chase it, and do not let it be read as caused by this change — if it fails
during verification, re-run and say so.

**Shared working tree.** Another Claude session commits to
`feat/p4-ui-testing` in this same worktree. Never use bare `git stash` — the
stack is shared. Confirm `git status` is clean before starting.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `package.json` | Modify | The `test` and `test:all` scripts — the actual fix |
| `docs/accessibility-assessment.md` | Modify | Remove a claim that no control exists |
| `test/ui/harness.mjs` | Modify | Re-justify the sweep's pid check on grounds that survive |

No new files.

---

### Task 1: Exclude `test/ui` from `npm test`

**Files:**
- Modify: `package.json` (the `scripts` block, lines 13-15)

- [ ] **Step 1: Record the current numbers yourself**

Do not trust the baseline above; confirm it, so the after-numbers mean
something.

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"
```

Expected: `tests 327`, `pass 316`, `fail 0`, `skipped 11`. If `fail` is non-zero
and the failure is `watcher.test.js`, re-run once — see the flakiness note above.

- [ ] **Step 2: Confirm the UI tests are in fact present in that run**

```bash
npm test 2>&1 | grep -cE "the sweep removes dead-pid profile dirs"
```

Expected: `1`. This is the UI test that runs unconditionally, and it is the
clearest single marker that `npm test` currently reaches `test/ui`. If this is
`0`, stop — the premise of this task is wrong and the glob is already excluding
something.

- [ ] **Step 3: Change the scripts**

In `package.json`, replace the `test` line and add `test:all` immediately after
it. Before:

```json
    "test:db": "node --test test/db/live.test.js",
    "test:ui": "node --test --test-concurrency=1 \"test/ui/**/*.test.js\"",
    "test": "node --test \"test/**/*.test.js\""
```

After:

```json
    "test:db": "node --test test/db/live.test.js",
    "test:ui": "node --test --test-concurrency=1 \"test/ui/**/*.test.js\"",
    "test": "node --test \"test/!(ui)/**/*.test.js\" \"test/*.test.js\"",
    "test:all": "npm test && npm run test:ui"
```

Both globs are required. `test/!(ui)/**/*.test.js` only matches paths with a
directory level, so on its own it silently drops `test/vault.test.js`, which
sits at the root of `test/`. Do not "simplify" this to one glob.

Do not use a negated argument such as `"!test/ui/**"`. It is silently ignored
by `node --test` — verified on Node 24.19.0, where it ran every file and
reported success.

- [ ] **Step 4: Verify no UI test runs**

```bash
npm test 2>&1 | grep -cE "the sweep removes dead-pid profile dirs"
```

Expected: `0`. Step 2 established this was `1` before the change, so this pair
is the assertion that the fix works.

- [ ] **Step 5: Verify the root-level test file still runs**

This is the silent-drop regression the second glob exists to prevent. A lost
test file produces no error, only a quieter suite, so check it directly.

```bash
npm test 2>&1 | grep -cE "a stored file can be read back byte for byte"
```

Expected: `1`. That test lives in `test/vault.test.js`. If it is `0`, the second
glob is missing or malformed — fix it before continuing.

- [ ] **Step 6: Verify the totals moved by exactly the UI contribution**

```bash
npm test 2>&1 | grep -E "^ℹ (tests|pass|fail|skipped)"
```

Expected: `tests 316`, `pass 315`, `fail 0`, `skipped 1`. That is 11 fewer
tests, 1 fewer pass, 10 fewer skips than Step 1 — exactly `test/ui`'s
contribution and nothing else. A larger drop means the glob is excluding
something it should not.

- [ ] **Step 7: Verify `test:ui` is unaffected**

```bash
npm run test:ui 2>&1 | grep -E "^ℹ (tests|skipped)"
```

Expected: `tests 11`, `pass 1`, `skipped 10`. Without `UI_LIVE=1` only the sweep
test runs and the rest skip; the point is that all six UI files are still being
selected by `test:ui`. Note that 11 is exactly the number `npm test` loses in
Step 6 — the same tests, now reachable only through `test:ui`, which is the
whole shape of this change in one number.

(With `UI_LIVE=1` the same command reports 31 tests and actually drives
browsers. Do not run that here; it takes about eleven minutes and proves
nothing this step needs.)

- [ ] **Step 8: Verify `test:all` runs both halves**

```bash
npm run test:all 2>&1 | grep -cE "^ℹ tests"
```

Expected: `2` — one summary block per half, proving the two runs happened in
sequence rather than one being swallowed.

- [ ] **Step 9: Commit**

```bash
git add package.json
git commit -m "fix(test): keep the UI suites out of npm test"
```

---

### Task 2: Correct the two comments the change falsifies

Both currently assert that nothing prevents the parallel invocation. Leaving
them would send readers looking for a control that now exists — and in one case
would invite an edit that removes a real safety check.

**Files:**
- Modify: `docs/accessibility-assessment.md` (the paragraph after the two
  example commands, around line 57)
- Modify: `test/ui/harness.mjs` (the `sweepStaleProfiles` doc comment, around
  line 92)

- [ ] **Step 1: Update the accessibility documentation**

Find this paragraph:

```markdown
**Use `npm run test:ui`, not `UI_LIVE=1 npm test`.** Both run these files, but
only `test:ui` passes `--test-concurrency=1`. The bare `test` script's glob also
matches `test/ui`, so `UI_LIVE=1 npm test` starts every UI file at once - a
Chrome and a server per test, in parallel.
```

Replace those four lines with:

```markdown
**Use `npm run test:ui`, or `npm run test:all` for everything.** `npm test` no
longer runs these files at all: its glob excludes `test/ui`, because it does not
pass `--test-concurrency=1` and `UI_LIVE=1 npm test` therefore used to start
every UI file at once - a Chrome and a server per test, in parallel.
```

Leave the rest of that paragraph as it is. The measured 29/0 against 11/12
figures, and the pointer to the withdrawn attribution in `test/ui/input.mjs`,
all remain accurate and are the reason the exclusion exists.

- [ ] **Step 2: Find the sentence in the same paragraph that is now false**

The paragraph ends with a clause stating that nothing in the repo stops anyone
typing the shorter command. Delete that clause only — it is the single
assertion this change falsifies. Everything else in the paragraph is measurement
and stays.

- [ ] **Step 3: Re-justify the sweep's pid check**

This is the important one. In `test/ui/harness.mjs`, the `sweepStaleProfiles`
doc comment currently argues for pid-liveness by pointing at `UI_LIVE=1 npm
test`. That command can no longer run UI files, so the stated reason has
expired and the check will read as redundant to the next person.

It is not redundant. Replace this block:

```js
 * Only directories whose owning pid is gone are touched, and that is the whole
 * safety argument. The two ways to run these suites do not agree about
 * concurrency: `npm run test:ui` passes --test-concurrency=1, the `test` script
 * does not, and its recursive glob over test/ includes test/ui. So
 * `UI_LIVE=1 npm test` - the obvious command, and one
 * docs/accessibility-assessment.md presents as supported - runs these files in
 * parallel processes sharing this one directory. A sweep that deleted
 * everything it found would then delete a sibling's profile out from under a
 * running browser. Do not replace this pid check with a wholesale delete.
```

with:

```js
 * Only directories whose owning pid is gone are touched, and that is the whole
 * safety argument. Several processes can share this one directory:
 *
 *   - Two sessions working in the same worktree. Not hypothetical - this
 *     happened here on 2026-08-31, one session running the UI suites while
 *     another edited this file.
 *   - A direct `node --test test/ui/...`, which bypasses the npm scripts
 *     entirely. docs/accessibility-assessment.md shows such a command.
 *
 * A sweep that deleted everything it found would delete a sibling's profile out
 * from under a running browser. Do not replace this pid check with a wholesale
 * delete.
 *
 * `npm test` used to be the headline reason here, running every UI file at once
 * because it does not pass --test-concurrency=1. Its glob now excludes test/ui,
 * so that specific route is closed - but the check is not therefore obsolete,
 * and the reasons above are why. An npm script cannot constrain a process that
 * never ran through it.
```

- [ ] **Step 4: Verify the harness still parses and its tests still pass**

The change is comment-only, so a failure here means a broken comment
delimiter — check for a stray `*/`.

```bash
node --test test/ui/harness.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```

Expected: `tests 3`, `pass 1`, `fail 0` — the sweep test passes, the two
browser tests skip without `UI_LIVE`.

- [ ] **Step 5: Verify no stale claim survives anywhere**

```bash
grep -rn "nothing in the repo currently stops" docs/ test/
grep -rn "UI_LIVE=1 npm test" docs/ test/
```

Expected: the first returns nothing. The second may return the corrected
sentences that mention the command historically — read each hit and confirm it
describes the past, not a current hazard.

- [ ] **Step 6: Commit**

```bash
git add docs/accessibility-assessment.md test/ui/harness.mjs
git commit -m "docs: npm test no longer runs the UI suites"
```

---

## Notes for whoever executes this

**Do not add the runtime guard.** A harness-level check that refuses to boot
when another live pid owns a profile was considered during design and
deliberately not taken — it answers a broader problem than the one requested.
It is recorded at the end of the spec as the obvious next step if concurrent UI
execution turns out to happen by routes other than `npm test`. Adding it here
would be scope creep.

**Do not "fix" the flaky `watcher.test.js`.** It is unrelated and out of scope.

**Do not simplify the two globs into one.** `test/vault.test.js` is the file
that disappears, and nothing will tell you it did.
