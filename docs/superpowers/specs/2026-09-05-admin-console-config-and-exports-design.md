# Admin console: typed configuration and exports

**Date:** 2026-09-05
**Status:** design, awaiting review
**Covers:** directory group search, SSO configuration, email configuration (SMTP +
Microsoft Graph), audit export to Excel, settings export.

---

## Goal

Five additions to the admin console, delivered as one change because four of them
are the same shape: a typed, validated, exportable configuration surface with a
way to prove it works.

## What already exists

This is assembly, not invention. Established before designing:

| Capability | Where |
|---|---|
| Directory search for the user picker | `server/auth/ldap.js:262` `searchUsers()` |
| Entra SSO validation, wired and running | `server/auth/entraToken.js`, `server/config.js:135`, `server/index.js:407`, `server/app.js:223` |
| Secret sealing, AES-256-GCM `enc:v1:` | `server/crypto/secretBox.js` — `isSealed()`, `makeSecretBox(key)` |
| Lazy unsealing of env values | `server/config.js:66` |
| Excel generation | `server/exporters/excel.js` `buildExcel(payload)` |
| Admin probes, real and dev | `server/index.js:153` and `:217` |
| Key/value settings with a `live` flag | `server/repos/settings.js` `KNOWN_SETTINGS` |
| Audit store | `dbo.AuditEvent` (migration 1), `server/repos/audit.js` |

**Not present, and not being built:** any mail-sending consumer. No scheduler, no
alerts, no reports-by-email. Email here is configuration plus a test send.

---

## Decisions taken

1. **Email is config + test-send only**, covering both SMTP and Microsoft Graph.
   No consumers. DEDB's mail subsystem is ten modules with schedulers behind it;
   that is a separate project if it is ever wanted. Note that DEDB is
   `nodemailer` only — Graph is new work here, not a mirror.
2. **Config is editable, stored in the database, with `.env` as fallback**, so a
   change applies without the service reinstall that NSSM's frozen environment
   would otherwise demand.
3. **Audit export follows the on-screen filters**, capped, with truncation stated
   in the sheet.
4. **Group mapping stays free-text**, with search as an assist and an explicit
   "not found in directory" marker on names that do not resolve.

---

## Architecture

### `server/repos/appConfig.js` — typed sections

A section is a named group of typed fields with a probe. Two sections ship:
`sso` and `mail`.

```js
export const CONFIG_SECTIONS = [
  {
    key: "sso",
    label: "Single sign-on",
    // Read at LOGIN time, before any session exists. See "Availability" below.
    preAuth: true,
    fields: [
      { key: "SSO_ENABLED",        label: "Enable SSO",           type: "bool",   live: true },
      { key: "ENTRA_TENANT_ID",    label: "Tenant ID",            type: "text",   live: true },
      { key: "ENTRA_CLIENT_ID",    label: "Application (client) ID", type: "text", live: true },
      // Optional. config.js:142 derives it as
      // https://login.microsoftonline.com/<tenantId>/v2.0 when unset, so the
      // field shows that derivation as its placeholder and stores nothing
      // unless an operator overrides it.
      { key: "ENTRA_ISSUER",       label: "Issuer (optional)",    type: "text",   live: true },
      { key: "ENTRA_REQUIRE_MFA",  label: "Require an MFA claim", type: "bool",   live: true },
    ],
  },
  {
    key: "mail",
    label: "Email",
    preAuth: false,
    fields: [
      { key: "MAIL_TRANSPORT",      label: "Transport", type: "enum", values: ["none", "smtp", "graph"], live: true },
      { key: "MAIL_FROM",           label: "From address",    type: "text",   live: true },
      { key: "SMTP_HOST",           label: "SMTP host",       type: "text",   live: true },
      { key: "SMTP_PORT",           label: "SMTP port",       type: "number", live: true },
      { key: "SMTP_SECURE",         label: "Use TLS",         type: "bool",   live: true },
      { key: "SMTP_USER",           label: "SMTP username",   type: "text",   live: true },
      { key: "SMTP_PASSWORD",       label: "SMTP password",   type: "secret", live: true },
      { key: "GRAPH_TENANT_ID",     label: "Graph tenant ID", type: "text",   live: true },
      { key: "GRAPH_CLIENT_ID",     label: "Graph client ID", type: "text",   live: true },
      { key: "GRAPH_CLIENT_SECRET", label: "Graph client secret", type: "secret", live: true },
    ],
  },
];
```

Field types: `text`, `number`, `bool`, `enum`, `secret`. The type drives
validation, redaction and the client control — one declaration, not four.

### Resolution order

```
in-memory cache (TTL 30s)  ->  database  ->  process.env  ->  field default
```

The cache exists because `sso` is read on every login. The TTL is short enough
that an edit applies within seconds and long enough that a login storm does not
become a query storm. `roleMappingRepo` already uses this pattern (`cacheMs`).

### Availability — why `.env` fallback is load-bearing

SSO configuration is read *before* a user is authenticated. Serving it from the
database alone would make the identity provider's configuration depend on the
database being up, so a database outage would take out login as well as data.
Therefore: on any database error the resolver falls back to `process.env` and
logs once per cache period. It never throws into the login path. A host that has
never used the console keeps working exactly as it does today, because `.env` is
still a complete configuration.

### Enabling SSO must re-run the checks that boot performs

`config.js:140` uses `need("ENTRA_TENANT_ID")` and `need("ENTRA_CLIENT_ID")`,
which **only runs at boot, against `.env`**. Move `SSO_ENABLED` into the database
and that guard silently stops applying: an admin could switch SSO on with no
tenant configured, and the failure would surface as broken logins rather than as
a rejected form.

So the section's validator reproduces it. Writing `SSO_ENABLED=true` is refused
unless `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` both resolve through the full
chain — database, then `.env` — with the message naming which is missing. The
validator lives beside the field declarations so the rule cannot drift from the
fields it guards, and it is tested by asserting the refusal, not by reading
`config.js`.

`ENTRA_OFFLINE_JWKS` stays in `.env` and is **not** exposed here. It is a JWKS
document — kilobytes of JSON — and `AppSetting.Value` is `NVARCHAR(400)`. Storing
it would either truncate silently or force a wider column for one air-gap escape
hatch that is set once at install. The Configuration tab shows it read-only as
"set in .env" / "not set" so its state is visible without being editable.

---

## Storage

### Migration 14 — `dbo.AppSecret`

Migration 13 states plainly that `AppSetting` holds no secrets: *"No secrets
belong here — those stay sealed in .env, and nothing in this table is read before
authentication."* That decision is respected rather than quietly reversed.
Applied migrations are immutable, so migration 13 is not edited.

Non-secret fields go in the existing `dbo.AppSetting`. Sealed secrets go in a new
table whose separation is the point: a different table, a different reader, and
no path by which the settings reader can return a secret.

```sql
IF OBJECT_ID('dbo.AppSecret', 'U') IS NULL
  CREATE TABLE dbo.AppSecret (
    [Key]     VARCHAR(60)     NOT NULL CONSTRAINT PK_AppSecret PRIMARY KEY,
    -- Always an enc:v1: sealed value, never plaintext. 2000 chars leaves room
    -- for a long client secret plus the AES-GCM iv/tag/base64 overhead;
    -- AppSetting's NVARCHAR(400) is sized for things an operator types.
    Sealed    NVARCHAR(2000)  NOT NULL,
    UpdatedBy NVARCHAR(120)   NULL,
    UpdatedAt DATETIME2(0)    NOT NULL CONSTRAINT DF_AppSecret_At DEFAULT (SYSUTCDATETIME())
  );
```

A write refuses any value not matching `isSealed()`. That is a guard against a
future caller forgetting to seal, not a formality: the failure it prevents is a
plaintext password at rest, which nothing downstream would notice.

### Reading `AppSetting` / `AppSecret` when the table is absent

Both readers tolerate SQL error 208 (invalid object) and treat it as "no stored
value", matching `settings.js`. A host on a code-only upgrade that has not run
migration 14 falls back to `.env` and keeps working.

---

## Secrets over the wire

A secret is **write-only**. `GET` returns:

```json
{ "key": "SMTP_PASSWORD", "type": "secret", "set": true, "updatedAt": "2026-09-05T08:00:00Z" }
```

Never a value, not even a sealed one — a sealed value is still a credential to
anyone who can reach the unsealing key. `POST` accepts a plaintext value, seals
it immediately with `makeSecretBox`, and stores only the sealed form. Sending
`{"clear": true}` deletes the row.

The client shows `••••••••` with "set 2026-09-05" beside it, and an empty field
means "leave unchanged" rather than "set to empty" — otherwise saving the form
after editing an unrelated field silently erases the password.

---

## Probes

Both new probes join the existing `adminProbes` object. **Both implementations
must gain them** — the real one at `server/index.js:153` and the in-memory dev
one at `:217`. This is exactly the wiring that `deploy/test/composition-root.test.ps1`
was written to catch after a backend reached `createApp` unwired in 1.8.2.

- **`sso()`** — resolves the issuer's OpenID metadata and fetches JWKS, returning
  `{ ok, issuer, keyCount, ms }`. No token needed; it answers "is this tenant
  reachable and does it publish keys", which is the question an admin has.
- **`mail()`** — sends one test message and returns `{ ok, transport, ms }`.

### The test send goes only to the signed-in admin

The recipient is the requesting admin's own `mail` attribute from the directory,
never an address supplied in the request. An admin console that will send a
message to any address on request is an open relay wearing a badge, and it would
be reachable by anyone who obtains an admin session. Sending to the operator's
own mailbox proves transport, credentials, and the `From` address just as well.

If the admin has no `mail` attribute the probe refuses with that reason, rather
than falling back to an address from the form.

---

## Directory group search

`searchGroups(query, config, deps)` in `server/auth/ldap.js`, mirroring
`searchUsers` exactly — same service-account bind, same `escapeFilter`, same
`sizeLimit`, same unreachable/misconfigured error split.

```
filter: (&(objectCategory=group)(|(cn=*ESC*)(sAMAccountName=ESC*)))
attributes: ["cn", "sAMAccountName", "description", "member"]
```

`cn` takes leading and trailing wildcards because an admin searches for a
fragment of a group name; `sAMAccountName` is prefix-only for the reason already
documented in `searchUsers` — a substring match over an identifier returns noise.

Returns `{ name, sam, description, memberCount }`. `memberCount` is the length of
`member` when the directory returns it, and `null` when it does not — ranged
retrieval for groups over the server limit is out of scope, and a wrong count is
worse than no count.

### Mapping behaviour

Free text stays valid. On load, the Access tab resolves each mapped group name
against the directory in one batched search and marks any that do not resolve
with "not found in directory". That marker is advisory: the directory may be
unreachable, or the service account may lack read rights on that OU, and neither
means the mapping is wrong. When the lookup itself fails, no rows are marked —
an unreachable directory must not paint every mapping as broken.

---

## Exports

One export path serves both new exports, in a new `server/exporters/adminExport.js`
that wraps the existing `buildExcel`.

### Audit export

`GET /api/admin/audit/export.xlsx` takes the same query parameters the Audit tab
already uses (from, to, actor, action), applies them unchanged, and caps at
**50,000 rows** ordered by `At DESC` — the existing `IX_AuditEvent_At` index
serves that directly.

When the cap truncates, the sheet's first row states it: *"Showing the most
recent 50,000 events of N matching. Narrow the date range to export the rest."*
A truncated export that does not say so is a compliance hazard, because it looks
complete.

Columns are the table's own: At, Actor, Action, Subject, Ip, UserAgent,
RequestId.

### Settings export

`GET /api/admin/config/export.xlsx` — one sheet per section plus a sheet for
`KNOWN_SETTINGS`, with columns Key, Label, Value, Source (`database` / `.env` /
`default`), Live, Updated by, Updated at.

**Secret fields export as `(set)` or `(not set)` and never a value.** The typed
section knows which fields are secret, so redaction is a property of the
declaration rather than a filter somebody must remember to update. The Source
column is the point of the export: it answers "where is this value actually
coming from", which is the question during an incident.

Both exports write an audit event (`action: "export"`), matching the existing
`/api/export` route.

---

## API surface

All under `requireRole("admin")` and `wrap()`, matching the routes at
`server/app.js:346` onward.

```
GET    /api/admin/config                     all sections, secrets redacted
POST   /api/admin/config/:section            partial update; unknown keys rejected
POST   /api/admin/config/:section/probe      run that section's probe
GET    /api/admin/config/export.xlsx
GET    /api/admin/audit/export.xlsx
GET    /api/admin/directory/groups?q=        group search
```

`POST /api/admin/config/:section` rejects any key not declared in that section.
An accepted-but-ignored key is how configuration drifts from what the screen
claims it holds.

---

## Client

- **Access tab** (`client/src/components/admin/Access.jsx`) — group search box
  above the existing free-text field, reusing the user-picker component and its
  debounce; "not found in directory" markers in the mapped list.
- **New Configuration tab** — two panels, SSO and Email, rendered from the field
  declarations returned by the API rather than hand-written per field, each with
  a "Test" button wired to its probe and a result line.
- **Audit tab** — an Export button that carries the current filters.
- **Settings tab** — an Export button.

Rendering from declarations is what keeps the client honest: adding a field to
`CONFIG_SECTIONS` makes it appear, correctly typed and correctly redacted, with
no second edit that could disagree with the first.

---

## Error handling

- Directory unreachable during group search → 503 with the existing
  `directoryUnavailable` shape, matching `searchUsers`. The mapping list still
  renders.
- Database unavailable while reading config → `.env` values, logged once per
  cache period, **never** an error into the login path.
- Probe failure → 200 with `{ ok: false, reason }`. A failed probe is an answer,
  not a server error; returning 500 makes the console look broken when it is
  correctly reporting that SMTP is misconfigured.
- Export over cap → succeeds, states the truncation in the sheet.
- Writing an unsealed value to `AppSecret` → refused, 500, logged. This should be
  unreachable; if it happens something upstream is wrong.

---

## Testing

Behavioural, not source-grep — source assertions in this repo have passed
vacuously before, so every pin below is mutation-checked.

| Area | Test |
|---|---|
| `appConfig` resolution | database beats `.env` beats default; database error falls back to `.env` and does not throw |
| Cache | a write is visible within the TTL; reads inside the TTL do not re-query |
| Secrets | `GET` never returns a value for a `secret` field, sealed or otherwise; empty input leaves the stored value unchanged; `clear` removes it |
| `AppSecret` guard | writing an unsealed value is refused |
| Missing tables | SQL 208 on either table yields `.env` values, not an outage |
| Probes | both are present on the real **and** the dev `adminProbes` (extends the composition-root test) |
| SSO enable guard | `SSO_ENABLED=true` is refused when tenant or client ID is missing from both database and `.env`; the message names the missing key |
| Test send | refuses an address from the request body; refuses when the admin has no directory `mail` |
| `searchGroups` | filter escaping for `(`, `)`, `*`, `\`; unreachable → 503; misconfigured → the misconfigured shape |
| Mapping markers | unresolved names marked; a failed lookup marks nothing |
| Audit export | filters applied; cap enforced; truncation notice present when and only when truncated |
| Settings export | secret fields render `(set)`/`(not set)`; Source column correct for each of database / `.env` / default |
| Routes | every new route rejects a non-admin session |

---

## Out of scope

Stated so it is not assumed: no mail consumers, schedulers, templates, alert
rules or reminders; no editing of `ENTRA_OFFLINE_JWKS`; no SSO *login flow* changes — validation already exists and
this only configures it; no group ranged-retrieval for large memberships; no
export formats besides xlsx; no changes to `KNOWN_SETTINGS` semantics.

## Compatibility

No breaking change. A host that never opens the Configuration tab keeps reading
`.env` and behaves exactly as it does today. Migration 14 is additive and its
absence degrades to `.env`. New dependency: `nodemailer` for SMTP; Graph uses
client-credentials over `fetch` with no new package.
