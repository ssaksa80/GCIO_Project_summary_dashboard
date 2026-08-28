# Releasing GCIO

GCIO uses semver `X.Y.Z` with two deploy tiers. **The version bump decides the
deploy tier**, and the bump is decided by **compatibility**, not by "did code
change" or by how large the change feels. This page is what a releaser follows.

## Tier table

| Bump | When | Migration policy | Deploy tier | Risk |
|---|---|---|---|---|
| **PATCH `Z`** (`1.5.0 -> 1.5.1`) | Bug fix or small tweak, **application code only**. No schema change, no dependency (lockfile) change, no Node-major change. | None. | **Patch overlay** (~1 MB; health-gated, auto-rollback). Seconds. | Drop-in. |
| **MINOR `Y`** (`1.5.x -> 1.6.0`) | New, **backward-compatible** functionality. New dependencies fine. | May add an **additive, idempotent** migration (a new table or column, guarded so running it twice is harmless). | **Full bundle** (~78 MB). Resets `Z` to 0. | Additive, low. |
| **MAJOR `X`** (`1.x -> 2.0.0`) | A **breaking** change (below). | Incompatible or mandatory-backfill migration allowed. | **Full bundle + a backup taken first + upgrade notes.** Resets `Y.Z` to 0.0. | Breaking; read the notes. |

Because GCIO's migrations are written backward-compatible by default, **MAJOR
is rare** — most schema work is additive and lands as a MINOR.

## When is it MAJOR?

- **Breaking schema**: dropping, renaming or retyping a column; adding `NOT NULL`
  to existing data; any migration that is not safe to run twice.
- **Mandatory backfill**: the upgrade is only correct after a data migration.
- **Breaking behaviour, config or API**: a removed or changed endpoint, a
  renamed or removed config key, a changed default that alters existing installs.
- **Node major** upgrade — the bundled runtime's major version changes.
- **No clean rollback**: the upgrade cannot be reverted by restoring the
  previous app plus database.

Signal a major with a `BREAKING CHANGE:` footer or a conventional-commit bang
(`feat!:`, `fix!:`). The preflight scans the release range for both.

## The hard rule

> If a release diff touches `server/db/migrations.js`, the dependency set
> (`package-lock.json`), or the Node runtime major (`deploy/versions.json`) —
> **it is not a patch.** Bump the MINOR (or MAJOR) and ship a bundle.
>
> If the range carries a `feat` commit touching what a patch actually ships —
> **it is not a patch either.** New functionality is a MINOR even with no schema
> change.

Both halves are enforced twice, deliberately. `deploy/preflight-release.ps1`
catches them at release time, and `Test-GcioPatchCompatible` catches the
schema/deps/node half again **on the host**, refusing a `Z` bump that smuggled
one in. They share the same helper functions so they cannot disagree.

## Two things GCIO does differently from DEDB

**1. The schema gate hashes a whole file.** GCIO keeps migrations as JavaScript
objects in `server/db/migrations.js`, not as a directory of `.sql` files, so the
fingerprint covers the entire file. **Editing a comment in that file forces a
bundle**, even though no schema changed. That is a known cost, not a bug: over-
triggering costs one bundle deploy, and under-triggering is unacceptable for the
reason below.

**2. Migrations apply at BOOT, not by an operator command.** `server/index.js`
applies them when the app starts. That is precisely why the schema gate is not
optional: a patch overlay carrying a changed `migrations.js` would migrate a host
that nobody chose to migrate, with no separate step to pause at.

## Before the first bundle install on any host

**`DATA_DIR` and `VAULT_DIR` must be set to absolute paths in `.env`** — for
example `C:\gcio\data` and `C:\gcio\vault`.

A bundle installs the application under `<install>\app`, so without these the app
resolves both directories beneath it and the existing drop folder and vault are
orphaned. Nothing reports that: the watcher sits on an empty directory,
`/healthz` stays green, and the portfolio simply stops changing.

## Release runbook

1. **Bump** — `npm version <patch|minor|major> --no-git-tag-version`. This is the
   version of record; `/healthz`, `/metrics` and every gate read it.
2. **Release notes** — add a section to
   [`deploy/RELEASE-NOTES.md`](deploy/RELEASE-NOTES.md), headed exactly
   `## GCIO X.Y.Z`. Not the commit list: what changed for an operator or a user,
   the deploy tier, and anything that will generate a support question. **Written
   before the preflight, not after** — step 3 fails without it.
3. **Preflight** — validate the bump against what actually changed:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File deploy/preflight-release.ps1
   ```
   It auto-detects the previous release (or pass `-BaseRef <ref>`), prints the
   required artifact, and **fails non-zero** if the bump is too small or the
   notes section is missing. `-Json` for machine output.
4. **Test** — run both suites and read the numbers:
   ```
   npm test
   ```
   ```
   pwsh -NoProfile -Command "Get-ChildItem deploy/test/*.test.ps1 | ForEach-Object { & pwsh -NoProfile -File $_.FullName }"
   ```
   **Do not substitute "CI is green" for this.** GitHub Actions is billing-blocked
   on this account: jobs report `steps=0` and `runnerName=None` in 2–4 seconds, so
   a red X there means no runner started, not a failing change. Check
   `gh run view <id> --json jobs` before believing either colour.
5. **Build** the artifact the preflight named — `deploy/build-patch.ps1` or
   `deploy/build-bundle.ps1`.
6. **Verify** it — `deploy/verify-patch.ps1 -Dir <staged>` or
   `deploy/verify-bundle.ps1 -Dir <staged>`.
7. **PR** — subject `release X.Y.Z - <summary>`. The preflight's base-ref
   auto-detect keys off exactly that subject shape, so it is load-bearing.

## One-command release

`deploy/release.ps1` wraps steps 1, 3 and 5. It **adds no policy**: you choose
the bump, the preflight validates it, and a refusal **reverts the bump and
commits nothing**.

```
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/release.ps1 -Bump minor -Summary "document import"
```

- `-DryRun` validates and reverts. `-NoBuild` stops after the commit. `-Tag`
  creates a local tag.
- It refuses to start on a dirty tree: a release commit must carry the version
  bump alone, or the `release X.Y.Z` marker stops being a reliable base ref for
  the next release.
- It does **not** push, and does not open the PR.

## Installing on a host

The operator copies the artifact and `Update-GCIO.cmd` to the server and runs it.
It works out the tier, verifies checksums, and hands off to the artifact's own
`install.ps1`.

- A **refused patch changes nothing** — the gates run before any backup, stop or
  overlay, so there is nothing to undo. The refusal names what is installed, what
  the patch needs, why, and the recovery command.
- A **failed health check auto-rolls-back** to a copy taken while the old version
  was still serving.
- `<install>\logs\deploy.log` is the authority for what actually reached a host —
  not `package.json`, not what a release PR intended. A bundle is cumulative, so
  intermediate versions can arrive inside a later one without ever being deployed
  as their own version, and only the log knows.

## Known limitations

- **The Windows service must be installed separately**, once, with elevation:
  `deploy/install-service.ps1`. `install.ps1` assumes the service already exists.
- **No automatic re-election of the ingest leader.** Unrelated to releases; see
  `docs/runbook.md` section 8.
- **Linux artifacts are not built.** GCIO deploys to Windows behind IIS, and a
  Linux bundle cannot be cross-built on Windows — the Node tarball's symlinks and
  executable bits do not survive.
