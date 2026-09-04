# Keep the UI suites out of `npm test`

**Date:** 2026-08-31
**Fixes:** `UI_LIVE=1 npm test` starting every UI file at once. `test:ui` passes
`--test-concurrency=1`; the bare `test` script does not, and its
`test/**/*.test.js` glob also matches `test/ui`. These suites are load-sensitive
enough to fail wholesale under that - measured on identical code, 29 pass /
0 fail sequential against 11 pass / 12 fail loaded.
**Out of scope:** a runtime guard in the harness against concurrent UI
execution generally. Considered and deliberately not taken; see the end.

## Why documentation was not enough

Two places already warn about this - `docs/accessibility-assessment.md` and the
sweep comment in `test/ui/harness.mjs`. Both were written this week, by two
sessions that had each been bitten by it.

Neither stops anyone. `UI_LIVE=1 npm test` is the shorter command, it is the
one people type, and it is presented in the repo's own accessibility
documentation as a supported way to run these suites. A warning that has to be
read before the mistake is not a control. The session that had been running
these suites all week reported that its own discipline - only ever using
`test:ui` - was the sole thing keeping the constraint, and nothing in the repo
enforced it.

## The change

`package.json`:

```json
"test":     "node --test \"test/!(ui)/**/*.test.js\" \"test/*.test.js\"",
"test:all": "npm test && npm run test:ui"
```

`test:ui` is unchanged. After this, `npm test` cannot run a UI file at all, at
any concurrency. The footgun stops existing rather than being documented.

**The second glob is load-bearing.** `test/!(ui)/**/*.test.js` requires a
directory level to match, so on its own it silently drops `test/vault.test.js`,
which sits at the root of `test/`. Losing a test file is exactly the kind of
regression that goes unnoticed for months - it produces no error, just a
quieter suite - so it gets a direct assertion rather than a careful reading.

Verified on Node 24.19.0 before being written down: with `test/api`, `test/ui`
and `test/root.test.js` present, the two-glob form runs `api` and `root` and
does not run `ui`. A negated second argument (`"!test/ui/**"`) was tried first
and is silently ignored - it ran everything - so that form must not be used.

`test:all` exists because the exclusion has a real cost: `UI_LIVE=1 npm test`
now gives no UI coverage at all, and does so quietly. Anyone who wants one
command for everything needs somewhere to go, and it must run the halves in
sequence rather than together.

## Two comments become false, and must be corrected rather than deleted

**`docs/accessibility-assessment.md`** says "nothing in the repo currently stops
anyone typing the shorter command". That stops being true and would otherwise
send readers looking for a control that now exists.

**The sweep comment in `test/ui/harness.mjs`** is the one that matters. It
justifies deleting by pid liveness rather than deleting everything found, and it
makes that argument by pointing at `UI_LIVE=1 npm test` running UI files in
parallel against one shared profile root. Once that command cannot run UI files,
the stated reason is obsolete and the check starts to look redundant.

It is not redundant. `docs/superpowers/specs/2026-08-30-ui-harness-profile-cleanup-design.md`
records why this specific misreading is dangerous: someone concluding the pid
check is unnecessary would replace it with a wholesale delete, which is the one
change that makes the sweep unsafe. So the comment is rewritten around the
reasons that survive the exclusion:

- Two sessions sharing one working tree. This is not hypothetical - it happened
  in this repo on 2026-08-31, with two Claude sessions committing to
  `feat/p4-ui-testing` in `C:\dev\gcio-p4` simultaneously, one of them running
  UI suites while the other edited the harness.
- Direct `node --test test/ui/...` invocations, which bypass npm scripts and
  therefore bypass this fix entirely. The accessibility documentation shows one
  such command.

The check keeps its full force; only its stated justification narrows. A
comment whose reasoning has quietly expired is worse than no comment, because
it invites exactly the "this looks obsolete" edit that removes the safety.

## Testing

Asserted by running the commands and reading what they report, since the change
is to which files a runner selects and nothing smaller than that is the
behaviour in question:

1. `npm test` reports zero UI tests. Specifically, none of the three UI test
   names appear, and the total drops by exactly the UI files' contribution.
2. `npm test` still runs `test/vault.test.js`. This is the silent-drop
   regression the second glob exists to prevent, and it must be checked
   directly rather than inferred from a total.
3. `npm run test:ui` is unaffected and still runs the six UI files.
4. `test:all` runs both halves, in sequence.

The before/after totals are recorded in the commit message so the difference is
attributable rather than merely asserted.

## Success criteria

`npm test` runs no UI file at any concurrency; `test/vault.test.js` still runs
under `npm test`; `npm run test:ui` is unchanged; `test:all` runs both halves
sequentially; and no comment in the repo still claims that nothing prevents the
parallel invocation, or justifies the sweep's pid check by it.

## The alternative that was not taken

A runtime guard in the harness was considered: at boot, look in `PROFILE_ROOT`
for a profile owned by a different *live* pid, which means another UI process
has a browser open right now, and fail fast. It reuses the pid-liveness
machinery the sweep already has, and unlike this change it catches every
parallel-UI case rather than the one npm script - including the two-sessions
case above, which this fix does nothing about.

It was not taken because it is a broader change answering a broader problem, and
the request was to close this footgun. It remains the obvious next step if
concurrent UI execution turns out to happen by routes other than `npm test`.
