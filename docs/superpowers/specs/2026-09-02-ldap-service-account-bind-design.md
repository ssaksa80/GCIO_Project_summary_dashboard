# LDAP service-account bind (search-then-bind)

**Date:** 2026-09-02
**Why now:** this deployment's AD will not authenticate end users the way the app
currently does, and the current design also guesses a UPN suffix that is wrong
for most of the directory.

## What is wrong today

`server/auth/ldap.js` binds as the end user, then searches. Two problems, both
measured against the live directory rather than reasoned about:

**1. The UPN suffix is a guess, and it is wrong.** `bindIdentity()` turns a bare
username into `<user>@<LDAP_UPN_SUFFIX>`. This domain has mixed suffixes:

| account | userPrincipalName |
| --- | --- |
| `jdoe` | `jdoe@example.com` |
| `svc_app` | `svc_app@example.local` |

`.env` carries `LDAP_UPN_SUFFIX=example.local`, so a bare `jdoe` becomes
`jdoe@example.local`, which does not exist. AD refuses the bind and the app
reports 401 "check the username and password" - with a correct password. No
single suffix value fixes this, because the directory has more than one.

**2. Group lookup runs as the end user.** A user without directory read rights
binds successfully, returns no groups, and is refused with 403 `no_access`,
which reads as a permissions decision rather than a lookup failure.

Simple binds themselves are fine here: verified directly over LDAPS on 636 with
a service account, `SIMPLE BIND OK`. So the mechanism is sound and only the
identity resolution and the search principal need to change.

## The design

Search-then-bind, the standard pattern:

```
1. bind(LDAP_BIND_DN, LDAP_BIND_PASSWORD)      the app's own credential
2. search (&(objectCategory=person)(sAMAccountName=<user>)) under baseDN
      -> distinguishedName, displayName, memberOf, userPrincipalName
3. bind(<distinguishedName>, <the user's password>)   separate client, discarded
4. return identity + groups from the step-2 search
```

Step 3 binds the DN the directory itself returned, so no suffix is ever guessed
and problem 1 disappears rather than being reconfigured. Step 2 runs as the
service account, so problem 2 disappears too.

**Dual mode.** Search-then-bind applies only when `LDAP_BIND_DN` is set. Without
it the current bind-as-user path is unchanged. This file deliberately mirrors
DEDB's `auth/ldap.js`, where user-bind works, and a deployment that hits trouble
can fall back by removing one setting rather than by shipping code.

## Failure mapping

This is the part that most needs care, because the failure this change could
introduce is the one we spent a day chasing: an operator-side fault reported to
every user as a bad password.

| Condition | Result | Reasoning |
| --- | --- | --- |
| Service-account bind rejected | **503 `directory_misconfigured`** | The APP's credential is wrong. As a 401 this would tell every user in the organisation to check their own password over a configuration error. It carries no credential detail. |
| Either bind fails connection-class | 503 `directory_unavailable` | Preserves the b96b9e1 fix |
| Search returns no entry | 401 `bad_credentials` | Unknown account |
| Search entry has no usable DN | 503 `directory_misconfigured` | The directory answered but not usably; not the user's fault |
| User bind rejected | 401 `bad_credentials` | Wrong password - deliberately identical to "unknown account" |
| Empty password | 401, **before any bind** | See below |

**The empty-password guard is security-critical, not hygiene.** LDAP treats a
bind carrying a DN and an empty password as an *unauthenticated* bind, and AD
accepts it. Without an explicit check, any known username would authenticate
with a blank password once step 2 has supplied its DN. The guard exists today
almost incidentally, at the top of `authenticate()`; under search-then-bind it
becomes load-bearing and gets its own test asserting no bind is attempted.

## Configuration

Two new optional settings, read in `server/config.js` beside the existing four:

- `LDAP_BIND_DN` - the service account's DN or UPN. For this host:
  `CN=svc_app,OU=Service Accounts,OU=Admin,DC=example,DC=local`
- `LDAP_BIND_PASSWORD` - its password

Both live in `.env` only, are never logged and never committed, exactly as
`DB_PASSWORD` is handled. `LDAP_UPN_SUFFIX` becomes unused in service-account
mode and is retained for the fallback path. A service re-registration is
required for either to take effect - see runbook section 7a.

## Testing

`test/auth/auth.test.js` drives a fake directory through the injected
`ClientCtor`, so every path below is testable without a real DC:

1. service-account mode binds twice, in order: service account, then the DN the
   search returned - asserted by recording bind calls
2. the second bind uses the DN from the directory, never a constructed UPN
3. a rejected service-account bind is 503 `directory_misconfigured`, not 401
4. an unreachable directory is still 503 `directory_unavailable`
5. a rejected user bind is 401, and a missing account is 401 with an identical body
6. an empty password is 401 and performs NO bind at all
7. groups come from the service-account search
8. with `LDAP_BIND_DN` absent, the existing single-bind path is used unchanged

Each is mutation-checked: the corresponding behaviour is broken deliberately and
the matching test must fail before the fix is called done.

## Out of scope

Kerberos/Negotiate. It would remove passwords from the wire entirely, but needs
SPN and keytab work on the host and does not fit a username/password form
without a redesign. Simple bind over LDAPS is verified working here, so the
smaller change is the right one now.
