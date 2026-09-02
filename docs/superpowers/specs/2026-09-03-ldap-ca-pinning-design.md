# LDAPS CA pinning (`LDAP_CA_FILE`)

**Date:** 2026-09-03
**Why now:** hardening, not break-fix. The DC's certificate was verified to
validate against Node's default trust store today (`authorized: true`), so
nothing is broken. This closes the gap between "it happens to validate" and
"we said which CA is allowed to sign it".

## What is wrong today

`server/auth/ldap.js` builds its client with no TLS configuration at all:

```js
new ClientCtor({ url: config.url, timeout, connectTimeout })
```

No `tlsOptions`, so `ldaps://` is validated entirely against Node's default
trust store. Two consequences:

1. **The trust decision is machine state, not configuration.** Whether sign-in
   works depends on what is in the host's root store, which is changed by
   Windows Update, by group policy, and by anyone with local admin. Nothing in
   the repo records which CA is supposed to sign the DC's certificate.
2. **The usual fix is worse than the problem.** When an internal CA is not in
   the default store, the path of least resistance is to install it
   machine-wide - which grants that CA authority over every TLS connection the
   host makes, not just this one.

Pinning the issuing CA for this client alone fixes both. It is the narrower
grant, and it is a file in the deployment rather than a state of the machine.

## Scope

Port **CA pinning only** from DEDB's `server/src/auth/ldapTls.js` (read-only
reference).

Deliberately **not** ported: `LDAP_TLS_REJECT_UNAUTHORIZED=false`. That switch
turns LDAPS into an encrypted channel to an unauthenticated peer - it stops the
client checking that the thing holding the other end of the connection is the
domain controller at all. An escape hatch that silently downgrades
authentication is not worth having in a codebase whose LDAP module already
exists to stop credential handling failing quietly.

## The design

### Config surface - `server/config.js`

One new setting, read inside the existing `authMode === "ldap"` block:

| variable | meaning |
| --- | --- |
| `LDAP_CA_FILE` | path to a PEM holding the CA that issued the DC's certificate |

- **Trimmed**, so `LDAP_CA_FILE=` followed by spaces counts as unset, matching
  the treatment `LDAP_BIND_DN` already gets. `.env` files collect whitespace and
  a human cannot see the difference.
- **Resolved against `ROOT`** with `path.resolve`, so a relative path works from
  the install directory and an absolute path survives untouched. Same reasoning
  as `resolveStateDir`, but not the same function - that one is about state
  directories and reusing its name here would mislead.
- **Read through `deps.readFileSync`** (default `fs.readFileSync`), the same
  injection point the module already provides for `deps.openSecret`, so the
  test suite never touches the disk.
- **Read as a `utf8` string**, not a Buffer. Node's `tls` and ldapts both accept
  a string `ca`, and G2 needs to look for a PEM header anyway - decoding once at
  load beats carrying a Buffer and decoding at the check.

It produces exactly one new field:

```
config.ldap.tlsOptions  ->  undefined              when LDAP_CA_FILE is unset
                        ->  Object.freeze({ ca })  when set and valid
```

`undefined` rather than `{}` is load-bearing - see "Why the empty case must be
undefined" below.

### The four guards

Each pushes onto `problems`, so a fault stops the process at load with the
variable named, next to the existing half-configured-service-account checks.
A service that will not start fails the deploy health gate and rolls back. An
authentication mystery on Monday morning does not.

**G1 - the file cannot be read.** This is the entire point of the change.
Falling through to the default trust store would leave the deployment in
exactly the state this feature exists to leave, while the operator believes a
CA is pinned.

**G2 - contents lack `-----BEGIN CERTIFICATE-----`.** An empty or wrong-file
`ca` does not mean "no opinion", it means *trust nothing*. Every bind then
fails TLS at sign-in with an error blaming the certificate, while the actual
fault is the path.

**G3 - `LDAP_CA_FILE` set and `LDAP_URL` is not `ldaps://`.** ldapts computes
`this.secure = isSecureProtocol || hasTlsOptions`. Supplying `tlsOptions`
therefore upgrades an `ldap://` URL to `tls.connect` - against port 389, where
nothing is listening for TLS. Sign-in hangs to the timeout. GCIO never issues
StartTLS, so there is no legitimate `ldap://` + CA combination.

**G4 - `LDAP_TLS_REJECT_UNAUTHORIZED=false`.** GCIO ignores this key by design.
An operator who copies a working DEDB `.env` believes certificate validation is
off when it is fully on, and the one setting they would reach for to explain a
TLS failure is the one doing nothing. The message names `LDAP_CA_FILE` as the
supported alternative.

G4 is independent of `LDAP_CA_FILE`: it fires on the value `false` alone.
`true` and unset stay silent, because neither misleads.

### Why the empty case must be `undefined`

ldapts tests `!!tlsOptions && Object.values(tlsOptions).some(v => v !== undefined)`.
An empty object is falsy under that test today, but relying on it is relying on
a truthiness detail of a dependency to keep plaintext `ldap://` deployments
from silently attempting TLS. `undefined` is unambiguous at both ends and is
what the tests pin.

### Client wiring - `server/auth/ldap.js`

One line. `newClient()` is already the single factory, so:

```js
const newClient = () => new ClientCtor({
  url: config.url,
  timeout: config.timeoutMs || 10000,
  connectTimeout: config.timeoutMs || 10000,
  tlsOptions: config.tlsOptions,
});
```

covers all three clients that get constructed: the service-account client in
`searchThenBind`, the **separate** user-bind client `searchThenBind` creates for
the verification bind, and the single client on the `bindAsUser` path. A CA that
reached only the first of those would pin the service-account connection and
leave the connection carrying the end user's password unpinned - the wrong one.

## Failure mapping

Nothing in this change touches the runtime failure classification. G1-G4 all
fire at load, before any client exists. `isUnreachable()`, `badCredentials()`,
`directoryUnavailable()` and `directoryMisconfigured()` are untouched.

A TLS handshake that fails at sign-in *after* a successful load - a rotated DC
certificate signed by a different CA - surfaces through the existing path. It is
not a network-level code, so `isUnreachable()` returns false and it is reported
as `bad_credentials`. That is pre-existing behaviour and outside this change;
noted here so the next person reading does not mistake it for something this
design introduced.

## Testing

Behaviour, not source text. Every assertion goes through `loadConfig()` or
`authenticate()`.

**`test/domain/ldap-tls-config.test.js`** (new) - the config surface:

- G1: a configured path that cannot be read throws, and the message names
  `LDAP_CA_FILE` and the path
- G2: a file whose contents are not a PEM throws
- G3: `LDAP_CA_FILE` with an `ldap://` URL throws, naming the scheme
- G4: `LDAP_TLS_REJECT_UNAUTHORIZED=false` throws; `true` and unset do not
- the accepting cases, or the guards are a regression: a valid PEM yields
  `tlsOptions.ca` equal to the file contents; unset yields **`undefined`**, not
  `{}`; whitespace-only counts as unset
- none of the guards fire under `AUTH_MODE=dev`
- `deps.readFileSync` is not called at all when `LDAP_CA_FILE` is unset

**`test/auth/auth.test.js`** (extended) - the wiring:

- a `FakeClient` recording its constructor options; on the search-then-bind path
  assert **both** constructed clients received the ca, and on the bind-as-user
  path assert the single client did
- with no CA configured, `tlsOptions` is `undefined` on every constructed client

**Mutation check.** Each of G1-G4 is removed in turn, the full suite is run, and
the result recorded. Removing a guard must fail that guard's tests and no
others. A guard whose removal breaks nothing is not a guard, and a guard whose
removal breaks unrelated tests means the tests are coupled to something other
than the behaviour they claim to pin. The matrix is reported with the change.

## Documentation and release

- **`.env.example`** gains a commented `LDAP_CA_FILE` beside the other LDAP
  settings, with a one-line note that it pins the issuing CA and that
  `LDAP_TLS_REJECT_UNAUTHORIZED` is not supported.
- **`deploy/RELEASE-NOTES.md`** gains a `## GCIO 1.5.5` section.
  `deploy/preflight-release.ps1` fails a release whose version has no section,
  so this is required, not optional. Patch, following 1.5.3 and 1.5.4 which
  also shipped LDAP behaviour changes as patches. `package.json` moves to
  `1.5.5`.

The operator-facing points for the notes: pinning is opt-in and absent
`LDAP_CA_FILE` nothing changes; setting it wrong now stops the service at
startup rather than at sign-in; `LDAP_TLS_REJECT_UNAUTHORIZED` is refused rather
than ignored, so a `.env` copied from DEDB needs that line removed.

## Out of scope

- `LDAP_TLS_REJECT_UNAUTHORIZED=false` as a working switch - refused, see Scope
- StartTLS on `ldap://` - not used by this codebase
- client certificates (`cert`/`key`) - no requirement for mutual TLS today
- reloading the PEM without a restart - the CA is read once at load. A CA
  rotation is a restart, which is the same as every other setting here
