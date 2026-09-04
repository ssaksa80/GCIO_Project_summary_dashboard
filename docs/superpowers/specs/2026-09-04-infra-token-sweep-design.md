# Infrastructure-token sweep (`test/security/infra-tokens.test.js`)

**Date:** 2026-09-04
**Why now:** on 2026-09-03 this repository's public history was found to carry
the live directory's real values, and had to be rewritten and the remote deleted
and recreated twice to remove them. During that cleanup a session committed one
of the values straight back, in two files and a commit message, while writing an
entirely legitimate account of an operator incident. Nothing in the repository
noticed either time. This adds the thing that notices.

## What is wrong today

There is no automated check. The repository's protection against publishing real
infrastructure is a person remembering to look, and the record shows that fails
in both directions: the values were committed over weeks without being seen, and
then re-committed within hours of being removed.

Two properties of the incident shape the design.

**1. The values were not in application source.** They were in `docs/runbook.md`,
`docs/superpowers/plans/`, `deploy/seal-secret.ps1`, `scripts/backup-restore-drill.mjs`
and `test/auth/*.test.js`. A sweep scoped to `server/` would have found none of
them. Documentation and deployment scripts are where operational facts get
written down, so they are the likeliest place for a real value to land, not the
least.

**2. Three of the seven value classes contain no dot.** A domain-shaped pattern
matches the AD domain and misses the workstation name, the base DN and a
username in a path. A distinguished name is comma-separated, so no
hostname-shaped regex can ever match one.

The sibling FMD project solved a narrower version of this in
`server/test/mailNoRecipient.test.js`. Its scope is `src/**/*.js` and its only
token class is domains. Ported unchanged it would have caught two of the seven
values in this incident. Its central idea is still correct and is kept here:

> ALLOWLIST, not a denylist. Every previous version of this sweep was a pattern
> I guessed, and each time something slipped through a shape I had not thought
> of. Listing what is PERMITTED fails closed instead.

## The design

One test file, `test/security/infra-tokens.test.js`. The existing `npm test`
glob is `test/!(ui)/**/*.test.js`, so it is picked up with no wiring change and
cannot be run only on purpose. That matters: this project already has a record
of gates that existed and never ran.

### Corpus

`git ls-files`, minus `package-lock.json` and binary extensions
(`.xlsx .xls .pdf .docx .zip .png .jpg .ico .woff .woff2`).

Driving off git rather than a directory walk means untracked scratch files
cannot fail the build, and everything that could reach the remote is covered.
`package-lock.json` is excluded because npm integrity hashes are base64 and
generate false positives — during the 2026-09-03 inventory one such digest
yielded an eleven-character fragment that matched the machine-name pattern and
carried the same three-letter prefix as the real workstation, which cost a
detour to disprove.

### Token classes

Five, one per class that actually leaked. Each class auto-permits only ranges an
RFC reserves, so that a permitted token *cannot* be real infrastructure;
everything else needs an exact entry carrying a comment.

| class | pattern | auto-permitted | exact entries |
| --- | --- | --- | --- |
| domain | `[a-z0-9-]+(\.[a-z0-9-]+)+` whose last label is in an explicit TLD set declared in the file (`com org net local internal lan corp example test invalid localhost ae io gov edu`) | `.test` `.example` `.invalid` `.localhost` (RFC 6761); `example.com` `example.net` `example.org` (RFC 2606) | 10 |
| ipv4 | four dotted octets | `127.0.0.0/8`, `0.0.0.0`, and `192.0.2.0/24` `198.51.100.0/24` `203.0.113.0/24` (RFC 5737) | 5 |
| dn | `(DC\|OU\|CN)=` value | none | 17 |
| machine | `[A-Z][A-Z0-9]{2,}[0-9][A-Z0-9-]*` | pure-hex tokens of length 6 or 8 | 10 |
| userpath | `C:\Users\<name>` or `/c/Users/<name>` | none | 1 |

Three of these need their reasoning recorded, because each looks like an
arbitrary choice and is not.

**`.local` gets no structural pass.** It is mDNS (RFC 6762), not reserved for
documentation, and it is the TLD the real domain used. So `example.local`,
`dc01.example.local` and `dc02.example.local` are exact entries and any *new*
`.local` name fails the build. This is the single most important line in the
allowlist: it is the shape the leak actually took.

**RFC 1918 gets no structural pass either.** The address that leaked was in
`10.0.0.0/8` — private, and real. `10.0.0.1`, `10.1.2.3`, `10.20.30.40` and
`10.0.0.0` (which occurs as prose about the range itself) are therefore exact
entries rather than a `10.*` rule.

**The hex exclusion is safe, not a convenience.** It removes about thirty
palette colours (`F6BE00`, `B8C8E8`, …) that the machine pattern otherwise
matches. A real name could hide there only if it were exactly six or eight
characters drawn from `[0-9A-F]`. Both names this repository actually leaked
fail that test: each contains at least one letter outside the hex alphabet, and
one of them is thirteen characters long. Neither could have passed through the
exclusion.

**Two patterns are bounded away from code identifiers**, because both classes
otherwise fire on ordinary source. The machine pattern must not touch `_`, or
it reads `IPV4_RE` as a host name — which it did, in this very file, the moment
the file became tracked and `git ls-files` began returning it. And `.app`,
`.me`, `.ai` and `.cloud` are left out of the TLD set: they are real gTLDs, but
`made.app` in the document tests is a variable and a field, and none of them is
a plausible shape for an intranet of `.local`, `.com` and `.ae` names.

That first case is worth recording as a method note, not just a bug. The sweep
reads `git ls-files`, so an untracked file is invisible to it — including
itself. Validating the sweep before staging it therefore tests a corpus that
excludes the thing under test. Re-run it after `git add`.

One entry is a known false positive and is listed as such: `1.6.0.1`, which is a
version string in a comment in `deploy/test/preflight.test.ps1`, not an address.
A future version string of the same shape will fail the build until someone adds
it. That is the intended behaviour, not a defect: adding an entry is a visible
decision.

### Self-verification

A sweep that silently matches nothing is indistinguishable from a clean
repository. During the 2026-09-03 cleanup two scans reported "clean" while
broken — one because `xargs` appended commit SHAs after a `--`, turning them
into pathspecs, and one because the pattern file had been deleted from the
scratchpad and `grep -f` was reading a path that no longer existed. Both
produced empty output and no error. So the file also proves it can fail:

1. **The scanner flags a contaminated sample** — one fabricated value per class,
   expecting exactly five offenders.
2. **The scanner passes a clean sample** — no offenders, so the patterns are not
   simply matching everything.
3. **The corpus is non-empty** — a `git ls-files` that returns nothing would make
   every other assertion in the file vacuously true.

The fixtures are fabricated — one invented value per class, resembling real
infrastructure but belonging to nobody. Writing the real values into a fixture
would put them back into the repository this test exists to protect, and the
file would fail its own sweep.

Each fixture is assembled at runtime from fragments, so no complete
infrastructure-shaped token appears literally in the test file. The
alternative, excluding the test from its own corpus, was rejected: it would
create the one file in the repository where a real value could sit unexamined.

**The fixture values are deliberately not written down here, and must never be
added to the allowlist.** The first draft of this document listed them, which
forced allowlist entries for them, which made the contaminated sample fully
permitted — the self-check then found zero offenders and failed, correctly, by
reporting that every pattern was dead. A value cannot be both the known-bad
input and an approved token. If the fixtures ever need changing, read them from
the test.

### Failure output

Offenders are reported as `path: token`, one per line, with the instruction to
add an entry and a comment if the token is legitimate. The message names the
allowlist so the fix is obvious to someone who has never read this document.

## What this does not do

It reads the working tree, not history. It stops a value being introduced; it
does not audit what is already committed. That audit was done on 2026-09-03 and
its method — fixed-string scans over every commit reachable from the remote's
refs, blobs and messages separately, each with a positive control — is recorded
in the memory note `purging-a-public-github-leak`.

It also cannot judge intent. A legitimate new vendor domain and a leaked
internal one look identical to it, and both fail the build. Distinguishing them
is the reviewer's job, and the allowlist entry with its comment is where that
judgement gets written down.
