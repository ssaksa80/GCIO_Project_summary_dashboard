# GCIO release notes

Newest first. One section per released version, headed exactly `## GCIO X.Y.Z`.
Write what an operator or a user would notice - not the commit list. The deploy
tier, anything that will generate a support question, and any behaviour that
looks like a regression but is not.

`deploy/preflight-release.ps1` fails a release whose version has no section here.

## GCIO 1.5.1

Accessibility and one authentication fix. No database migration, no dependency
change, no Node change - this ships as a patch overlay.

**The "critical" red is different on the dark themes, and that is deliberate.**
`--critical` is now `#e93069` on obsidian, sapphire and emerald rather than the
mandated Pantone 192 C `#e40046`. Expect to be asked. The literal hex measured
2.59:1 to 3.08:1 as text against those themes' own surfaces where WCAG requires
4.5:1, and in sapphire it failed even the 3:1 floor that applies to non-text
indicators - so there was no arrangement that kept it, not even as a dot or a
border. 19% lightening is the smallest change that clears the floor everywhere.
Platinum is untouched. `docs/runbook.md` section 9 has the full reasoning, and
restoring the mandated hex exactly is not possible without either accepting a
WCAG failure or moving the Pantone 281 C surfaces.

**The project drawer is now a real modal dialog.** It takes focus when opened,
keeps Tab inside it, and returns focus to whatever opened it on close. Before
this, opening a drawer left focus on the page behind, and its close button was
99 Tab presses away.

**The all-projects table can be operated from the keyboard.** Column headers
sort with Enter or Space and report their direction to a screen reader; each row
opens from the keyboard. Previously both were mouse-only.

**A directory that cannot be reached no longer reports as a bad password.** With
`AUTH_MODE=ldap`, an unreachable domain controller returned the same
"check your username and password" as a genuine credential rejection, sending
people to retype passwords and escalate to the wrong team. Connection-class
failures now surface as a directory-unavailable error. A wrong password and a
missing account remain deliberately indistinguishable.

Nothing here changes the ingest path, the read model, or the database.

## GCIO 1.5.0

Baseline. The first version with a bundled release artifact; earlier versions
were deployed by copying the working tree.

**A bundle install requires `DATA_DIR` and `VAULT_DIR` to be set to absolute
paths in `.env`** - `C:\gcio\data` and `C:\gcio\vault`. A bundle installs the
application under `<install>\app`, so without those settings the app resolves
both directories beneath it and the existing drop folder and vault are
orphaned. Nothing reports that: the watcher sits on an empty directory,
`/healthz` stays green, and the portfolio simply stops changing.
