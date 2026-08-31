# UI harness: own the Chrome profile directory instead of leaking it

**Date:** 2026-08-30
**Fixes:** `test/ui/harness.mjs` leaving `puppeteer_dev_chrome_profile-*`
directories behind in `%LOCALAPPDATA%\Temp`. Measured 2026-08-30 after a session
of repeated UI runs: 14 directories, 256 MB.
**Out of scope:** the 2282 `gcio-*` directories left by `test/vault.test.js`,
`test/audit/fileAudit.test.js`, `test/ingest/watcher.test.js`,
`test/db/live.test.js` and `test/api/app.test.js`, which use the same
`fs.mkdtempSync(os.tmpdir(), ...)` pattern with no removal; and the four
`scripts/*.mjs` puppeteer launch sites, which leak the same way. Both are real
and both are noted here so the next person does not have to rediscover them.

An earlier draft of this spec put those `gcio-*` directories at 1759 MB. That
was wrong by a factor of about 2200, and the error is worth recording because
the tool produced it silently. `du -sm` rounds every directory up to at least
1 MB, so summing its per-directory output across thousands of near-empty
directories yields a total that tracks the directory *count*, not any size.
Measured properly - recursing each directory and summing file lengths - they
hold 1945 files totalling 0.77 MB, with 496 of the directories completely
empty. So this is directory-entry clutter, not a disk problem. Still worth
fixing on its merits, since 2282 directories is 2282 more things for a scanner
to walk and it feeds the ~65,000 entries in that folder, but it is not the
1.7 GB the first number implied, and it should not be prioritised as if it
were. Do not size these with `du`.

## Why it leaks

This is not a teardown bug. `teardown()` already escalates to `taskkill /T /F`,
is idempotent, and demonstrably leaks no processes - a full `npm run test:ui`
starts and ends with zero puppeteer Chrome processes.

It leaks because of who owns the directory. When `puppeteer.launch()` is given
no `userDataDir`, puppeteer creates a temporary one and removes it on a clean
`browser.close()`. The harness deliberately does not always get a clean close:
its header comment records a real, measured hang under load, and the response
was to bound every wait and escalate to a tree-kill. A tree-killed Chrome never
runs its own cleanup, and puppeteer - whose `close()` never returned - never
runs its either. The directory is then owned by nobody.

So the fix is not to make the close politer. It is to stop asking Chrome's exit
path to be responsible for cleanup at all.

## The change

**Own the directory.** `boot()` passes an explicit `userDataDir` to
`puppeteer.launch()`. Puppeteer only removes profile directories it created
itself, so with this option set it creates no `%TEMP%\puppeteer_dev_chrome_profile-*`
at all. The leak source is removed rather than swept up after.

**Where.** `.tmp/ui-profiles/` under the repo root, with a new `/.tmp/` entry in
`.gitignore`, anchored and commented in the style the rest of that file already
uses.

This departs from the repo's existing `os.tmpdir()` convention for test scratch
space, and does so deliberately. That convention is what produced the 2282
stranded `gcio-*` directories. More importantly, a repo-owned directory can be
swept wholesale by a rule this code fully controls, whereas sweeping inside the
user's `Temp` would mean prefix-matching against roughly 65,000 entries
belonging to other software - a much worse thing to get wrong.

There is a second consideration, and it is worth setting out carefully because
the first draft of this section overstated it. All of it is reported by a
parallel session working on this suite's flakiness, and recorded here as that
session's measurement rather than this one's.

This box runs Defender for Endpoint, and the UI suites are badly
degraded by it: a browser intermittently stops delivering keyboard and mouse
events to a page mid-test and never resumes for that page, with listeners
seeing trusted events arrive normally and then stop dead, while
`document.activeElement` still reports the field as focused. Full runs go from
29 pass / 0 fail on a quiet box to 11 pass / 12 fail under load.

**A repo-path exclusion has not been shown to fix that, and this design does not
claim it will.** An earlier draft said it had. The same session later measured
again: with the exclusion for the repo directory applied, `mssense` was still at
169% of a core and `msmpeng` at 82%, and the UI suites failed exactly as before.
MDE on this box appears to be centrally managed and indifferent to local
exclusions. The flakiness cause remains unestablished.

The matching exclusion for the profile directories under `Temp` could only have
been written as a wildcard, and was blocked by AMSI - correctly, because a
wildcard exclusion under a user's Temp is a standard malware-persistence move.
That block is not to be worked around, and nothing in this design does.

What survives all that is a weaker claim, and it is the one this design rests
on: a profile directory inside the repo needs no Temp exclusion at all, because
it inherits whatever exclusion the repo carries. A `%TEMP%` path is one nobody
can legitimately exclude, so repo-local is strictly the better position to be in
if exclusions ever do start mattering here. That is a reason to prefer it. It is
not a promise that the suites get less flaky, and no such promise should be made
on the strength of it.

This is worth connecting to something `harness.mjs` already says. Its
focus-emulation block records that `Emulation.setFocusEmulationEnabled` was
measured before and after and did not improve input flakiness, and
`test/ui/keyboard.test.js` retries on input loss for the same reason. A cause
sitting outside the browser entirely would explain why a browser-side fix moved
nothing. Offered as a plausible connection, not a diagnosis - this session has
established none of it.

**Naming.** `run-<node pid>-<seq>`, where `seq` counts within the process
because one process boots many apps across a test file. The pid is what makes
the sweep below exact.

**Removal, and its ordering.** `teardown()` removes the directory *after* the
existing browser-close and tree-kill sequence, never before. `taskkill /T /F`
returns before Windows has released Chrome's file handles, so a bare `rmSync`
immediately after it meets `EBUSY` or `EPERM`. Removal is therefore
`fs.rmSync(dir, { recursive: true, force: true })` retried up to five times
at 100ms intervals - half a second of patience, which is far more than handle
release needs and far less than anyone would notice - with a final failure
reported through `dlog` and swallowed. A profile directory that will not
delete is a disk problem; it must never turn a passing test red.

## Two backstops, matching the layering already in the file

The harness already reasons in terms of a primary mechanism plus last resorts,
and profile cleanup gets the same treatment.

**`process.on("exit")`** gains one synchronous best-effort `rmSync` per tracked
entry, with no retry. Exit handlers must not block, and file handles are very
likely still open a millisecond after a tree-kill, so this attempt will often
fail. That is acceptable, because it is not the mechanism being relied on.

**A boot-time sweep** is the mechanism being relied on. Once per process,
guarded the way `ensureAfterHook()` is guarded, before the first launch: read
`.tmp/ui-profiles/`, parse the pid out of each entry name, and delete only those
whose pid answers `ESRCH` to `process.kill(pid, 0)`. Anything alive, or
answering `EPERM`, is left alone.

This is what actually reclaims a Ctrl-C'd or crashed run, which is the failure
mode that produced the 14 directories in the first place.

**The sweep must be safe under concurrency, and pid-liveness is what makes it
safe.** `npm run test:ui` passes `--test-concurrency=1`, so UI files run
serially - but `npm test` globs `test/**/*.test.js` with default concurrency,
and that glob includes `test/ui/**`. Every UI file self-skips unless `UI_LIVE=1`,
so the case that matters is `UI_LIVE=1 npm test`, which `docs/accessibility-assessment.md`
documents as a supported way to run these suites. There, several UI files run in
parallel processes against the same `.tmp/ui-profiles/`. A sweep that
deleted every directory it found would delete a sibling's live profile. Keying
on pid liveness makes that impossible: a sibling's pid is alive, so its
directory is never a candidate.

An age-based sweep was considered and rejected. Chrome touches its profile
constantly, so a live directory does look fresh and the heuristic would mostly
work - but it is a heuristic in a place where an exact answer is available, and
its threshold would be a number chosen by feel.

Pid reuse is the one gap: a recycled pid can make a single sweep skip a genuinely
dead directory. The sweep runs on every boot, so the next run reconsiders it.
That is a good enough answer for a disk-space concern.

**Every path here is best-effort and swallowed**, including the sweep itself. A
sweep that throws must not prevent a boot. A leaked directory costs disk; a
failed boot costs the whole suite.

## Testing

The existing `test/ui/harness.test.js` covers the harness itself, so this is
where the assertions belong.

The honest difficulty is that the most valuable case - a tree-killed Chrome -
is the one an in-process test cannot easily stage, and staging it badly would
produce a test that passes for the wrong reason. The split below is deliberate:
assert in the suite what the suite can genuinely observe, and verify the rest by
direct measurement, recorded here rather than pretended into a test.

Asserted in `test/ui/harness.test.js`:

1. After a normal `startDashboard()` / `close()` cycle, the profile directory
   that boot created no longer exists.
2. No `puppeteer_dev_chrome_profile-*` directory appears in `os.tmpdir()` across
   a boot - a count before and after, since other software may hold pre-existing
   ones and an absolute count would be wrong.
3. The sweep deletes a planted `run-<dead pid>-0` directory and leaves a planted
   `run-<own pid>-0` directory alone. This is the concurrency-safety property,
   and it is testable directly without booting anything.

Measured by hand and recorded in the commit message:

4. Count `puppeteer_dev_chrome_profile-*` in `%TEMP%` and entries in
   `.tmp/ui-profiles/` before and after a full `npm run test:ui`. Expect zero
   new directories in `%TEMP%` and an empty `.tmp/ui-profiles/` at the end.
5. Crash case: interrupt a run mid-flight, confirm a directory is stranded,
   then confirm the next boot removes it.

Each assertion is to be seen failing before the fix lands, so it is known to be
capable of failing.

## Success criteria

A full `npm run test:ui` adds no `puppeteer_dev_chrome_profile-*` directory to
`%TEMP%` and leaves `.tmp/ui-profiles/` empty; an interrupted run's directory is
reclaimed by the next boot; parallel UI files under `npm test` do not delete one
another's profiles; and the existing UI suite passes unchanged.
