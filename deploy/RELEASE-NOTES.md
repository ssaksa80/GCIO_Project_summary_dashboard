# GCIO release notes

Newest first. One section per released version, headed exactly `## GCIO X.Y.Z`.
Write what an operator or a user would notice - not the commit list. The deploy
tier, anything that will generate a support question, and any behaviour that
looks like a regression but is not.

`deploy/preflight-release.ps1` fails a release whose version has no section here.

## GCIO 1.11.3

**Health rows no longer say UNKNOWN when they mean something else.**

The status badge had three states and needed five. Anything that was not
plainly up or down rendered as UNKNOWN, which lumped together three unrelated
situations:

    Uptime              a value, not a condition       -> now shows no badge
    Database            not configured                 -> now says so
    Directory (LDAP)    not configured                 -> now says so
    Migrations applied  none applied yet               -> now says so
    Projects            no data yet                    -> now says so

On a health screen this distinction is the whole point. "Not configured" says
the setup is incomplete and names the fix. "Unknown" says the system tried to
look and could not find out, which is a fault worth investigating. Only one of
those should interrupt anyone, and a fresh install was showing the alarming
word for all four.

Uptime is the clearest case: it is a number. It reported UNKNOWN for having
nothing to report.

### Compatibility

Display only. No API, schema, dependency or runtime change, and the underlying
health data is unchanged - only how a row with no up/down condition is labelled.

## GCIO 1.11.2

**The install stage now says what it is doing.** 1.11.1 made it fast; it was
still silent while it worked, which is the same complaint that started this
whole line of work.

### The gap

1.11.1 put progress on expanding the bundle, verifying it, and expanding
dependencies. Between `installing the full bundle into C:\gcio` and the
dependency expand there was nothing at all - about 47 seconds on a measured
deploy, spent backing up the current app, clearing it, and copying the new one.
Three passes over roughly 15,000 files each, all invisible.

Copying now reports a real percentage, taken by watching the destination while
robocopy runs. robocopy's own arguments are unchanged: it stays on exactly the
fast path 1.11.1 measured, and the progress is read from outside it.

Clearing reports what it is about to remove and how long it took, rather than a
percentage. Its fast path is a single synchronous directory delete that cannot
be polled from PowerShell while it runs, and the only way to draw a bar over it
would be to switch to a slower delete so it could be watched. Paying real
seconds for a cosmetic bar is the wrong trade; on the measured deploy that step
took 15 seconds.

### A bar that stopped at 99%

    [gcio] expanding [###################] 99% (2102/2134)[gcio] verifying...

Directory entries in an archive were extracted but not counted, so the total was
never reached, the closing newline was never written, and the next message
printed onto the end of the bar. They are counted now. Close-GcioProgress also
exists to end a bar whose loop stops early for any other reason.

### Compatibility

Nothing to do. No schema, dependency or runtime change. Progress output is
cosmetic: every file operation behaves exactly as it did in 1.11.1, and a
redirected log still gets one line per 10% rather than thousands.

## GCIO 1.11.1

**A bundle install should now take minutes rather than the better part of an
hour.** 1.11.0 made the *artifact* fast; this makes the *install* fast, which
turned out to be a different thing.

### What 1.11.0 missed

1.11.0 collapsed dependencies into one archive and replaced the slow file
operations with fast ones - in the code that unpacks the bundle. The code that
installs it was never changed, and that is where a deploy spends its time.

A measured 1.11.0 deploy on a live host took **43.8 minutes**. Almost none of it
was the dependency expand. It went on three full passes over a ~15,000-file tree,
all still using PowerShell cmdlets that walk every file through the pipeline:

    back up the current app to app.bak-*     ~15,000 files
    clear app/ and runtime/ before copying   ~15,000 files
    purge old backups after the health gate  ~50,000 files

The last one runs after the health check passes, so the installer stayed alive
for minutes after the application was already up and serving - which looks
exactly like a hung deploy and was reported as one.

All of them now use the same fast helpers 1.11.0 introduced. Those measured 74
to 100 seconds against roughly 2,300 for the cmdlets on the same trees.

### Also faster where it matters most

The rollback path was on the slow route too. That is the worst place for it: the
service is down and someone is waiting to find out whether the old version is
coming back. Restoring is now a fast clear plus a rename.

The patch overlay and the host-tooling copy were changed for the same reason.

### Backups

Purging old backups tolerates an already-absent directory rather than
suppressing the error, so a half-cleaned install no longer leaves a deploy
reporting a failure it recovered from.

### Compatibility

Nothing to do. No schema, dependency or runtime change, and no change to what a
bundle contains - only to how quickly it is put in place. Rollback,
patch installs and bundle installs all behave exactly as before.

Note for anyone verifying by hand: refresh verify-bundle.ps1 at your staging
root from this release, as 1.11.0's notes describe. From this release on it
ships beside the archive, so copying the build output refreshes it for you.

## GCIO 1.11.0

**A bundle deploy now takes about five minutes instead of the better part of
an hour**, and there is an About footer showing the running version.

### Why deploys were so slow

The bundle held 17,398 files, of which 15,312 were dependencies — the
application itself is 62 files. Every stage of a deploy paid for that count:
clearing the previous unpack, extracting, checksumming, and copying into place.
The clearing step alone ran at 0.1 MB/s on your host and was indistinguishable
from a hung installer.

Dependencies now travel as a single archive inside the bundle and are expanded
once, on the host. Measured on the real artifact:

    entries      17,398  ->  2,134
    size         77.8 MB ->  73.5 MB
    extract         730s ->  39s
    verify           77s ->  21s
    expand deps         -> 213s     (new, and paid once)
    clear unpack   ~2300s ->  58s

    end to end    ~3100s -> ~330s

The 213 seconds to expand dependencies cannot be avoided — Node needs those
files on disk. What changed is that the cost is paid once rather than four
times over.

Two smaller changes with the same cause: clearing a directory now uses a method
that does not walk every file through a pipeline, and re-running a deploy skips
extraction and checksums entirely when the same archive was already unpacked and
verified — so a retry after a failed health check costs seconds.

### About

A quiet footer showing the name and version, with a link to build details and
the maintainer credit. It appears on the dashboard, the admin console and the
sign-in screen: the version is the first thing anyone is asked for when
reporting a problem, and it should not be hidden from the people who cannot get
in. If it cannot load, it simply does not appear.

### Compatibility

Each bundle carries its own installer, so a new bundle always arrives with one
that understands the new layout. An older bundle installs exactly as it did
before — just as slowly.

One thing needs a hand, once. verify-bundle.ps1 does NOT travel inside a bundle:
it sits at the operator's staging root as shared tooling beside versioned
bundles, so this release's change of shape silently invalidated whatever copy is
there. A pre-1.11.0 verifier rejects a good 1.11.0 bundle with
"MISSING: app/node_modules". install.ps1 never calls the verifier, so a deploy is
unaffected — but refresh the staging root from deploy/verify-bundle.ps1 before
verifying anything. The current verifier accepts both the old loose tree and the
new archive. From the next release it ships beside the archive, so copying the
build output to the staging root will refresh it without anyone remembering to.

No schema, dependency or runtime change.

## GCIO 1.10.0

**The admin console now has eleven screens.** Health, Ownership, Access,
Sessions, Audit, Settings, Connection, Database, Logs, Security and Ingest.
Includes the faster deploy from 1.9.1.

New in this release:

- **Health** - is the database up, is the directory configured, which
  migrations have run, and how many projects are loaded. The four things you
  would otherwise get by reading a log file on the host.
- **Ownership** - who owns each section of the brief. A grant names a person or
  a directory group; ownership is matched by name against whoever signs in and
  every group they belong to.
- **Settings** - session timeouts, log level and the brief title, stored in the
  database. Each says whether it applies immediately or at the next restart,
  and saving tells you which of the two just happened.
- **Connection** - what this deployment points at, and a button that tests the
  directory using the service account. That test is the one that separates
  "the directory is unreachable" from "that person typed the wrong password".
- **Database** - schema version, every migration applied, and row counts.
- **Logs** - the tail of the application, error and deploy logs, with a filter,
  without needing a remote session on the host.
- **Security** - how people authenticate, whether that happens over TLS,
  whether the stored credential is sealed, how sessions expire, and every route
  to admin. If that last count reaches zero nobody can reach the console.

Three things are deliberately different from DEDB, and each says so on screen:

- **Connection is read-only.** GCIO reads its configuration from `.env`, which
  the service wrapper freezes at install time, so editable fields would appear
  to save and change nothing. Change `.env` and re-register the service.
- **Row counts are estimates**, not exact counts. An exact count would scan
  every table, and a status screen must not be able to slow the database it is
  reporting on.
- **Email, Templates, Critical Alert and the Project Tracker screens are not
  included.** GCIO has no mail subsystem and no second product, so those are
  DEDB features rather than DEDB logic; building them would be new product
  rather than a port.

**Deployment.** Migration 13 adds two tables, so this is a schema change and
ships as a bundle. Nothing existing changes: the new tables start empty, and
every screen works with nothing in them.

No secret is shown anywhere in the console. Connection and Security report only
whether a password is set and whether it is sealed at rest.

## GCIO 1.9.1

**A bundle deploy now spends about two and a half minutes expanding the
archive instead of twelve.** Includes everything in 1.9.0; deploy this instead
if you have not taken that one yet.

The installer used PowerShell's `Expand-Archive`, which charges per file. The
bundle is only 77.8 MB but holds 17,571 entries - 15,312 of them dependencies
and 1,990 the bundled Node runtime. The application itself is 62 files.

Measured on the real artifact:

    Expand-Archive                  730s   (what it did)
    bulk extraction                 143s   (what it does now)

Roughly three and a half to five times faster depending on how warm the disk
cache is. Checksum verification is unchanged at about 77 seconds, so a bundle
deploy drops from around thirteen and a half minutes to under four.

Correctness is unchanged and deliberately so:

- **Any failure falls back to the old method.** An unusual but valid archive
  cannot break an update that used to work; it just extracts slowly.
- **Archives that try to write outside the destination are still refused**, and
  a refusal is not retried through the fallback.
- **A missing `lib/` folder no longer matters.** Extraction falls back to the
  built-in rather than failing, which is what it did before this change.

Nothing about the artifact format changed, so an older installer expands a new
bundle exactly as before - just as slowly.

No schema, dependency or runtime change.

## GCIO 1.9.0

**The dashboard now uses a 4K display, and the admin console is a full page.**

### Resolution

The layout was pinned at 1520px wide however large the screen, so a 3840px
display showed a strip of content between two very wide empty margins. It now
widens in steps: unchanged below 1920px, then 2400px, 2600px at 1440p, and
2800px on a 4K display, with gutters and card sizes growing to match.

Wide tables also gain columns rather than just stretching. The sessions list
shows four columns on a laptop and six on a 4K screen; the extra ones simply
are not rendered where they would not fit.

Nothing changes below 1920px. The type scale, cards and tables were tuned
against 1520px and that is still exactly what a normal screen gets.

### Admin console

**Access** now opens a full page instead of a small dialog, with four sections:

1. **Access** - people and directory groups side by side. A group grants a role
   to everyone in it, a direct grant names one person, and sign-in takes the
   HIGHER of the two; showing one without the other made the other look broken.
   Group mappings previously had no screen at all and could only be changed in
   the database.
2. **Sessions** - who is signed in, when they were last active, and revoke.
3. **Audit** - sign-ins, refusals, role changes and uploads, with filters.
4. **Status** - health, uptime, portfolio size and recent ingest runs. This is
   the screen that answers "why has the dashboard not changed since last night".

The button is admin-only, as it was, and every endpoint behind it is enforced
server-side - hiding a control was never the access control.

Two details worth knowing. The session list deliberately never shows a session
id: that is a bearer token, and a screen displaying one would be a screen
handing it over, so revocation is by person. And you cannot remove the group
mapping or the grant that is your own only route to admin - it would lock the
console for everyone, and the way back is Grant-Role.cmd on the host.

The console is not a bookmarkable URL. Use the button to enter and either the
**Back to the dashboard** button or **Escape** to leave; the browser's back
button will leave the application instead.

No schema, dependency or runtime change. Ships as a patch-sized bundle.

## GCIO 1.8.2

**Per-user role grants now actually take effect.** 1.8.0 added them and 1.8.1
fixed how they are matched, but neither release reached the running
application: the composition root built the grants repository and then did not
pass it to the app. Sign-in therefore ignored every direct grant, fell back to
directory group membership alone, and refused people whose grant was plainly
listed in the Access console.

Nothing failed loudly. The feature was simply absent, which is why it survived
a full test suite - the tests construct the application directly with the
dependencies they want, and the step that was wrong is the one they skip.

The admin console's directory search was missing for the same reason and now
works.

Existing grants need no attention. They were stored correctly throughout and
begin working when this release is deployed - no re-granting, no
re-registration, no configuration change.

Also added: a release gate that checks the shipped artifact wires every backend
it builds. It fails against the 1.8.1 artifact, which carries the defect.

No schema, dependency or runtime change. Ships as a patch.

## GCIO 1.8.1

**Fixes a role grant being ignored at sign-in.** A person granted a role - from
the Access console or from Grant-Role.cmd - could still be refused with "your
account is not a member of any group granted access to this dashboard", while
the grant was plainly visible in the list.

Grants are stored against the bare account name, because that is the one form
`jdoe`, `DOMAIN\jdoe` and `jdoe@example.local` all reduce to. But at sign-in
the directory reports the user's userPrincipalName, so the lookup was being made
with `jdoe@example.local` against a table keyed `jdoe`, and matched nothing.

This affects any directory that populates userPrincipalName, and it is worse
where a domain carries more than one UPN suffix, since the suffix is then not
even the one configured in LDAP_UPN_SUFFIX.

Existing grants need no attention - they were always stored correctly, and they
start working the moment this release is deployed. No re-granting, no
re-registration, no configuration change.

No schema, dependency or runtime change. Ships as a patch.

## GCIO 1.8.0

**A command on the host can now grant a role, so a locked-out deployment can
be recovered without the admin console.** This closes the gap 1.7.0 left: the
console grants roles, but you have to sign in to reach it, and signing in
needs a role. On a fresh database nobody has one.

From the install directory, in any shell:

    C:\gcio\Grant-Role.cmd <username> admin      grant or change a role
    C:\gcio\Grant-Role.cmd --list                show every current grant
    C:\gcio\Grant-Role.cmd --remove <username>   revoke a grant

Roles are `viewer`, `pm` and `admin`. It reads the same `.env` and database the
application uses, so there is nothing extra to configure, and it writes the
same table the console does - a grant made here appears there and vice versa.

**This is now the recommended way to create the first admin.** `SEED_ADMIN_GROUP`
still works and is unchanged, but it needs a directory group that somebody has
to create and populate. This does not:

    C:\gcio\Grant-Role.cmd jdoe admin

It is also the way back from a directory outage. When LDAP group resolution
fails, every role folds to nothing and everyone is refused - including whoever
would fix it. A direct grant is applied by account name and bypasses group
resolution entirely, so it restores access while the directory is still broken.

Points worth knowing:

- Run it through `Grant-Role.cmd`, not the `.js` directly. Windows hands a bare
  `.js` to Windows Script Host, which cannot parse the file and fails with an
  `800A03EA` compile error that names nothing useful.
- Unlike the console, this **will** remove the last admin grant. The console
  refuses because it would lock itself out; this tool can always grant straight
  back, and refusing would disarm the recovery path in the one situation it
  exists for.
- Granted roles apply at the next sign-in. An open session keeps its old role.
- Grants made here are recorded as coming from the CLI rather than from a
  person, so the audit trail does not imply someone used the console.

Also fixed: `--list` and the console's list used to show "no grants" on a host
whose schema predates 1.7.0, where the truthful answer is that the table does
not exist yet. Both now say so and name the migration. Found by running the
tool against a real host still at migration 11.

**Deployment.** Supersedes 1.7.0 - if you have not deployed that yet, deploy
this instead and you get both. It still carries migration 12 and still ships as
a **bundle**.

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
