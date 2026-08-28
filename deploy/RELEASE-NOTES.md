# GCIO release notes

Newest first. One section per released version, headed exactly `## GCIO X.Y.Z`.
Write what an operator or a user would notice - not the commit list. The deploy
tier, anything that will generate a support question, and any behaviour that
looks like a regression but is not.

`deploy/preflight-release.ps1` fails a release whose version has no section here.

## GCIO 1.5.0

Baseline. The first version with a bundled release artifact; earlier versions
were deployed by copying the working tree.

**A bundle install requires `DATA_DIR` and `VAULT_DIR` to be set to absolute
paths in `.env`** - `C:\gcio\data` and `C:\gcio\vault`. A bundle installs the
application under `<install>\app`, so without those settings the app resolves
both directories beneath it and the existing drop folder and vault are
orphaned. Nothing reports that: the watcher sits on an empty directory,
`/healthz` stays green, and the portfolio simply stops changing.
