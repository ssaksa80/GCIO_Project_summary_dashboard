# GCIO release notes

Newest first. One section per released version, headed exactly `## GCIO X.Y.Z`.
Write what an operator or a user would notice - not the commit list. The deploy
tier, anything that will generate a support question, and any behaviour that
looks like a regression but is not.

`deploy/preflight-release.ps1` fails a release whose version has no section here.

## GCIO 1.7.0

**An admin can now give any person a role from inside the application**, without
asking the directory team to create or populate a group. A new **Access** button
appears in the header for admins.

A person's role is the HIGHEST of two things: what their directory groups grant,
and what an admin granted them directly. A direct grant can raise someone above
their group; it never lowers them below it, so revoking is done by removing a
grant rather than by setting a smaller one.

**What has NOT changed, and matters most:** signing in still proves only who
someone is. A person the directory authenticates but nothing grants is refused
with 403, exactly as before - membership of an unmapped group never implies a
role. `SEED_ADMIN_GROUP` still seeds the first admin, so **nobody can sign in
until that group has at least one member.**

Granting someone access:

1. Sign in as an admin and press **Access** in the header.
2. Type part of a name, email address or account name. The server searches the
   directory using the configured service account and lists matches.
3. Pick the person and choose a role: `viewer` reads, `pm` also uploads,
   `admin` also opens this screen.

The picker searches rather than accepting a typed name on purpose. A grant
written against a typo saves without complaint, appears correctly in the list,
and leaves the person refused at sign-in with nothing connecting the two.

Details worth knowing:

- **You cannot remove or lower your own last admin grant.** It would lock the
  console for everyone, and the way back is a database edit or the seed group.
- A grant typed as `DOMAIN\user` or `user@example.local` is stored against the
  bare account name, which is what sign-in looks up. All three forms work.
- Revoking a grant leaves any role the person gets from a directory group intact.
- Every grant and revoke is written to the audit log with who made the change.
- A directory outage while searching is reported as such, not as "no matches".

**Deployment.** This adds `dbo.UserRoleMapping` (migration 12), so it is a
schema change and ships as a **bundle**. The migration runs during the deploy.
A host still on the previous schema degrades to "no direct grants" rather than
failing sign-in, because the lookup sits in the login path - but the console
cannot store anything until the migration has run.

## GCIO 1.6.1

**`seal-secret.ps1` now asks for the service account username, not a bind DN,
and checks the credential before storing it.** Fixes a prompt that invited the
wrong answer: it said `Bind DN`, an operator supplied the base DN, and the next
prompt read `Password for DC=...` - which looks entirely reasonable right up
until the bind fails as a credential error and sends someone hunting for a
password problem that does not exist.

The run is now four numbered steps, each with an example:

1. **Directory base DN** - already in `.env`, so it is shown for confirmation.
   Press Enter to keep it.  Example: `DC=example,DC=local`
2. **Service account username** - the account name on its own, nothing more.
   Example: `svc_app`
3. **Password** - entered twice, never echoed, never written in the clear.
4. **Verify and write** - one bind against the directory, then seal and save.

A bare username is qualified exactly as the application would qualify it: a UPN
from `LDAP_UPN_SUFFIX`, or one derived from the base DN, or a NetBIOS
`DOMAIN\user`. The identity it settled on is printed before the password is
asked for. An already-qualified value - `svc@example.local`, `EXAMPLE\svc`, or a
full `CN=...` DN - is used exactly as typed, because appending a suffix to a UPN
yields something that cannot bind and reads like a bad password.

A DN with no `CN=` component is now refused outright, saying that it names a
container rather than an account and that the base DN is configured elsewhere.

**Step 4 is the substantive change.** Until now the first thing that ever tested
the password was the service itself, on every sign-in by every user - which is
how a service account gets locked out by a typo. One deliberate bind here costs
a single attempt. A rejection stops the write and prints the AD data codes
(`52e` wrong password, `525` no such user, `532` expired, `533` disabled, `775`
locked out). An unreachable directory does **not** stop it: that is a
connectivity problem, not a wrong credential. `-SkipBindTest` opts out.

No schema, dependency or runtime change, and no change to the application code.
Ships as a patch.

## GCIO 1.6.0

**The LDAP service-account password can now be stored encrypted at rest.**
Until this release the only place to put it was plaintext in `.env`, where it
is copied by every backup, support bundle and folder copy that touches the
install directory.

`LDAP_BIND_PASSWORD` may now hold an `enc:v1:` token instead of a password.
To move an existing host across, from an elevated prompt:

    pwsh -NoProfile -ExecutionPolicy Bypass -File C:\gcio\seal-secret.ps1 -InstallDir C:\gcio

It prompts for the bind DN and password, backs `.env` up, replaces the
settings in place, and reminds you to re-register the service - NSSM freezes
the environment at install time, so a restart alone will not pick the new
values up. The password is read as a SecureString and never echoed, never
logged, and never placed on a command line.

**What this protects against, precisely.** The key lives in `key.bin` beside
`.env`, held under Windows DPAPI at LocalMachine scope, so both files together
are useless on any other machine. A leaked backup, a copied folder or an
accidental commit no longer leaks the password. It does **not** defend against
code already running on this host as the service account, because the service
has to decrypt unattended - anything it can do, that code can do. No
unattended scheme does better, and it is worth knowing which of the two
problems this solves.

What an operator will notice:

- A plaintext `LDAP_BIND_PASSWORD` still works. The service starts, signs
  people in, and logs one warning naming the file and the tool. Upgrading a
  host that has not been migrated is not an outage.
- `key.bin` appears next to `.env` the first time something is sealed. **Back
  it up with `.env`, and treat it as equally sensitive.** Restoring `.env` to
  a different host without it - or with it - means re-running the tool there.
- `key.bin` and `.env.bak-*` are now in `.gitignore`.

Also in this release: the LDAP bind identity and search filters were reviewed
against DEDB's implementation. Both projects escape search filters to RFC 4515
identically; no change was needed.

This adds functionality rather than fixing behaviour, so it is a MINOR bump
and ships as a **bundle**, not a patch. There is no schema change and no new
dependency; the tier is set by the release gate's rule that new functionality
ships whole, and the gate refused a patch build of this until the version was
corrected.

A bundle replaces node_modules and the bundled runtime as well as the
application, so allow more time than a patch deploy and expect the service to
be down for longer than the usual few seconds.

## GCIO 1.5.4

**A half-configured service account is now refused at startup instead of
failing every sign-in.** Housekeeping on top of 1.5.3, and the only reason it
is a separate release is that it protects the exact configuration change 1.5.3
asks operators to make.

`LDAP_BIND_DN` alone was not a partial configuration, it was a trap. It selects
search-then-bind, which then binds with an empty password - an anonymous bind,
which Active Directory accepts. The search returns nothing, so every user in
the organisation gets `sign-in failed: check the username and password` while
holding a correct one, and nothing in the logs names the cause. `LDAP_BIND_PASSWORD`
alone is quieter and just as wrong: it is ignored, and the release keeps
guessing UPN suffixes as if nothing had been configured.

Both now stop the service at startup with a message naming both settings,
alongside the other configuration checks. **This is deliberately loud.** A
service that will not start fails the deploy health gate and rolls back, which
is the outcome an operator can act on; an authentication mystery on Monday
morning is not.

What an operator will notice:

- Setting one of the two and restarting now fails immediately and says which
  half is missing, rather than starting cleanly and rejecting everyone.
- Setting both, or neither, is unchanged. Neither still means bind-as-user,
  exactly as before 1.5.3.
- Whitespace counts as unset, so `LDAP_BIND_DN= ` behaves like an absent value
  rather than a configured account.

No schema, dependency or runtime change. Ships as a patch.

## GCIO 1.5.3

**Sign-in now works on directories the previous release could not authenticate
against.** If you are on a domain where users bind successfully today, nothing
changes and no configuration is needed.

The old path constructed a bind identity as `<username>@LDAP_UPN_SUFFIX`. That
assumes every account shares one UPN suffix, and many directories do not: on the
deployment this was found on, `jdoe@example.com` and `svc_app@example.local` live
in the same domain, so no configured value was right for both. A user with the
correct password was told to check the username and password.

Set `LDAP_BIND_DN` and `LDAP_BIND_PASSWORD` in `.env` and the app instead binds
as that service account, searches for the user by `sAMAccountName`, and then
binds the `distinguishedName` the directory itself returned. No identity is
guessed, so the suffix stops mattering. `LDAP_UPN_SUFFIX` becomes unused in this
mode; leave it or remove it.

Leave `LDAP_BIND_DN` unset and the previous bind-as-user behaviour is unchanged,
so this is safe to take on a working deployment and can be reverted by removing
one setting rather than by rolling back.

**Group membership is now read by the service account, not the signing-in user.**
A user without directory read rights previously resolved to zero groups and was
refused with 403 "no access" - which reads as a permissions decision rather than
the failed lookup it was.

**A wrong service-account password fails as 503, not 401.** It binds before the
user does, so a bad service credential fails every sign-in in the organisation.
Reported as 401 it would tell every one of those users to check a password that
was never the problem, so it returns `directory_misconfigured` instead. The
message names no credential detail.

Both new settings are secrets and are handled like `DB_PASSWORD`: `.env` only,
never logged, never committed. Editing `.env` does not affect a running service -
re-register it, see runbook section 7a.

## GCIO 1.5.2

Deploy tooling only. No application change - the app payload is identical to
1.5.1 apart from the version string, so nothing a user sees is different.

**A patched host now gets the updater it is told to run.** Every refusal message
names `Update-GCIO.cmd -Rollback` as the recovery command, and on a host that
had only ever been patched that file did not exist: `code-update.ps1` and
`Update-GCIO.cmd` shipped beside the archive, which bootstraps a host that has
nothing, but were never copied onto the host afterwards. Found on this host
immediately after deploying 1.5.1, where `C:\gcio` had `install.ps1`,
`uninstall.ps1` and `lib/` and no updater at all.

The gap was silent because the copy is guarded by a `Test-Path`: a file the
artifact does not carry is skipped, the deploy still reports `health=OK`, and
the host quietly never gains the script. Three lists had to agree and nothing
made them - the two builders' ship lists and the installer's copy list.

If you are on a host installed before 1.5.2, this patch will place the updater
for you. Until it lands, `install.ps1 -Rollback` does the same job as
`Update-GCIO.cmd -Rollback`; the capability was always there, only the
documented entry point was missing.

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
