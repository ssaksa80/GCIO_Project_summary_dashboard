# The deploy suites run under `npm test`

**Date:** 2026-09-04
**Why now:** the fifteen PowerShell suites under `deploy/test/` gate nothing.
No script, no package.json entry and no workflow invokes them, so they run only
when somebody remembers to run one by hand. Three of them turned out to be
quietly broken, and one had been running a single check out of roughly twenty
for as long as it has existed. Nothing reported that, because nothing ran it.

## What is wrong today

`npm test` runs the node suites and stops there. `deploy/test/*.ps1` covers the
install, patch, uninstall, verify, preflight and secret-sealing paths — the code
that touches a real host — and none of it is reachable from any command that
anybody runs routinely.

Running all fifteen by hand produced the measurement that motivates this:

| | suites | checks | result |
| --- | --- | --- | --- |
| sequential | 15 | 345 | 13 green, **2 red**, 145s |

Both failures share one signature: `[FAIL]` count zero, no verdict line, exit 1.
That is not an assertion failing. It is the script dying partway through, and it
is the same defect already fixed in `seal-secret.test.ps1`: under Windows
PowerShell 5.1, `$ErrorActionPreference = 'Stop'` turns a child process's
**stderr** into a terminating `NativeCommandError`, and `2>$null` does not
prevent it. `common-basics.test.ps1` stops after 4 checks; `verify.test.ps1`
stops after 1. Neither total is knowable without fixing them — assertions run
inside loops, so counting calls in the source understates them — but
`verify.test.ps1` contains fourteen assertion calls, so at least thirteen of
its checks have never executed.

**Three of fifteen suites had this, and the shape of the failure is why it went
unnoticed.** A suite that dies early and a suite that genuinely fails both exit
1. Anybody who ran one and saw a non-zero exit had no reason to look closer.

## Two findings that shape the design

**The suites are safe to run.** An audit of all fifteen for service, registry,
network, database and elevation operations returned zero across the board. They
are unit tests over the deploy library functions, using per-run temporary
directories. Nothing here touches a real host, so they can run in an ordinary
test pass.

**They are not safe to run in parallel.** At six-way concurrency the wall time
drops from 145s to 62s, but `host-tooling.test.ps1` fails, completing 8 checks
instead of 14. They interfere. Sequential execution is therefore a requirement,
not a default, and the 145s is the real cost.

## The design

A single node test file, `test/deploy/powershell-suites.test.js`, with one
`test()` per suite. The existing `npm test` glob (`test/!(ui)/**/*.test.js`)
picks it up with no change to package.json, and node's runner reports each suite
by name. Subtests inside one file run in order, which is exactly the sequential
execution the interference finding requires.

**Suites are discovered from disk**, by globbing `deploy/test/*.ps1` at runtime,
rather than from a list in the test. A new deploy suite then gates from the
moment it is written. A hardcoded list is a second place to forget.

**The shell is `powershell.exe`, not `pwsh`.** Windows PowerShell 5.1 is what
the deployment actually uses, and it is the shell that exposes this class of
bug: `seal-secret.test.ps1` reported "all passed" with a full 34 checks under
pwsh 7, while under 5.1 it stopped after 33 and printed no verdict at all.
Running these under pwsh would hide precisely the failures the suites exist to
catch.

**A suite passes only if it exits 0 AND prints `all passed`.** This is the part
that earns its place. The exit code alone cannot separate the three states:

| state | exit | verdict line |
| --- | --- | --- |
| healthy | 0 | `all passed` |
| assertion failed | 1 | `N failed` |
| died partway | 1 | *none* |

Checking the exit code would treat a suite that ran one check out of twenty as
an ordinary failure. Requiring the verdict makes the third row loud and distinct
— and that row is not hypothetical, it is three of the fifteen suites as found.

**Off Windows it skips, it does not fail.** When `process.platform` is not
`win32`, or the shell is not on PATH, each suite is marked skipped. Local CI is
run through a Linux environment for some projects, and a test that cannot run
there should say so rather than break the suite.

**Per-suite timeout of 120 seconds.** The slowest today is 28s; the margin
absorbs a cold start without letting a hung child block the run forever.

On failure the assertion message carries the suite's own output, so the reason
is in the test report rather than something to reproduce by hand.

## Prerequisite

`common-basics.test.ps1` and `verify.test.ps1` are fixed first, by the same
change already applied to `seal-secret.test.ps1`: relax the error preference
around the child-process call that is expected to write to stderr, and restore
it in a `finally`. Wiring known-red suites into `npm test` would produce a
failing build on the first run, and a red suite that everyone learns to ignore
is worse than no suite.

Fixing them makes both run their full check set for the first time. That may
surface genuine assertion failures behind the ones never reached; those are
real defects and get fixed on their merits, not suppressed.

## The cost, stated plainly

`npm test` goes from about 23 seconds to about 170. That is a seven-fold
increase on the command run most often, for suites that only matter when
`deploy/` changes.

It is accepted because the alternative does not achieve anything. This project
has no CI: every gate is a person typing a command. A separate `test:deploy`
script, in the style of the existing `test:ui`, would leave the suites exactly
as reachable as they are today — which is the problem being fixed. Making them
conditional on a diff against a base ref would let the gate skip itself, which
is the failure mode this repository has hit before.

## What this does not do

It does not run the suites on a host that resembles production. They remain unit
tests over the deploy library; proving an install works still requires a real
host and a real service.

It does not make the deploy suites cross-platform. They are Windows-only by
nature, and on any other platform this wrapper reports them skipped — an honest
gap, not a green tick.
