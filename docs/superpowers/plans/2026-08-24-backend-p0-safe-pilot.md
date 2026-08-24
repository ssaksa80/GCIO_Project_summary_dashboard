# Backend Phase 0 — Safe Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard safe to put in front of the CIO's office — every request authenticated, roles enforced, actions audited, transport and uploads hardened, running as a Windows service against SQL Server.

**Architecture:** Mirrors DExDashBoard (DEDB), which this organisation already runs in production: `mssql` with a pool / executor / repository layering, LDAP bind plus Entra SSO, server-side sessions in SQL, group-to-role mapping in SQL, and dependency-free security headers. The domain code (sections, summarize, chain) is untouched and stays synchronous.

**Tech Stack:** Node 24, Express 4, `mssql` (tedious), `ldapts`, `jose`, `node:test` + `supertest`, NSSM for the Windows service, IIS for TLS.

**Spec:** `docs/superpowers/specs/2026-08-24-backend-production-design.md`

**Rewritten 2026-08-24.** The first version of this plan targeted PostgreSQL, `openid-client`, `helmet` and `express-rate-limit`. That was superseded once it was established that DEDB and FMD already run LDAP and SSO on SQL Server in production, so GCIO mirrors them rather than introducing a parallel stack. Work already delivered is listed with its commits so what remains is unambiguous.

---

## Already delivered

Committed and pushed, covered by 77 tests that need neither a database nor a directory.

| Area | What exists | Commit |
| --- | --- | --- |
| Test harness | `node --test "test/**/*.test.js"` | `60b8b3f` |
| Data layer | `db/pool.js` (named instances, `resetPool`), `db/executor.js` (`query`/`tx`, pool getter, clean 503 on a dead pool), `db/errors.js`, `db/migrations.js` (ledger, idempotent, ids 1–5) | `b85180c` |
| Repositories | `projects`, `posture`, `audit`, `sessions`, `roleMapping` — parameterised throughout, DEDB factory style | `b85180c`, `9ef09a9`, `2c47b9a` |
| Store switch | `SqlStore` read model, `STORE=memory\|mssql`, section engine unchanged | `2c47b9a` |
| LDAP sign-in | Bind as the user, RFC 4515 filter escaping, identical message for a bad password and an unknown account | `9ef09a9` |
| Entra SSO (server) | Full token validation; `unknown_kid` triggers exactly one forced JWKS refetch; cached keys with cooldown and bounded retries | `111f520` |
| Authorisation | `requireSession` / `requireRole`, groups folded to the highest role, no default role | `9ef09a9` |
| App wiring | Health open, everything under `/api` behind a session, upload requires `pm`, uploads and exports audited | `2c47b9a` |
| Hardening | Security headers, self-only CSP, `SameSite=Strict` sessions, per-IP sign-in throttle, upload magic-byte guard | `610a2ca`, `2c47b9a` |
| Client | Sign-in screen, identity chip, sign-out, role-gated upload, 401 returns to sign-in | `2c47b9a` |

---

### Task 1: First-run bootstrap — somebody has to be able to sign in ✅ DONE

**Delivered.** `seedIfEmpty` plus the boot wiring and the warning; 6 tests.
The upload tests were also moved off the real `data/` directory, which they had
been writing into.

On a fresh database `dbo.RoleMapping` is empty, so every sign-in resolves to no role and is refused with 403. `config.seedAdminGroup` is read from `SEED_ADMIN_GROUP` and then never used. As it stands the first production sign-in cannot succeed.

**Files:**
- Modify: `server/repos/roleMapping.js`
- Modify: `server/index.js`
- Modify: `.env.example`
- Test: `test/db/roleMapping.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { roleMappingRepo } from "../../server/repos/roleMapping.js";

function scriptedExecutor({ rows = [] } = {}) {
  const statements = [];
  return {
    statements,
    async query(text, params) {
      statements.push({ text: text.trim(), params: params || [] });
      if (text.includes("FROM dbo.RoleMapping")) return { recordset: rows, rowsAffected: [rows.length] };
      return { recordset: [], rowsAffected: [0] };
    },
    async tx(fn) { return fn(this); },
  };
}

test("an empty map with a seed group installs exactly one admin mapping", async () => {
  const ex = scriptedExecutor({ rows: [] });
  const seeded = await roleMappingRepo(ex).seedIfEmpty("GCIO-Dashboard-Admins");

  assert.equal(seeded, "GCIO-Dashboard-Admins");
  const merged = ex.statements.find((s) => s.text.startsWith("MERGE dbo.RoleMapping"));
  assert.ok(merged, "no mapping was written");
  assert.equal(merged.params.find((p) => p.name === "role").value, "admin");
});

test("a map that already has entries is never seeded over", async () => {
  const ex = scriptedExecutor({ rows: [{ GroupName: "someone-elses-group", Role: "viewer" }] });
  const seeded = await roleMappingRepo(ex).seedIfEmpty("GCIO-Dashboard-Admins");

  assert.equal(seeded, null);
  assert.ok(!ex.statements.some((s) => s.text.startsWith("MERGE")), "an existing map was overwritten");
});

test("no seed group configured means no mapping is invented", async () => {
  const ex = scriptedExecutor({ rows: [] });
  assert.equal(await roleMappingRepo(ex).seedIfEmpty(""), null);
  assert.ok(!ex.statements.some((s) => s.text.startsWith("MERGE")));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/db/roleMapping.test.js`
Expected: FAIL — `repo.seedIfEmpty is not a function`.

- [ ] **Step 3: Add `seedIfEmpty` to `server/repos/roleMapping.js`**

Inside the returned object, after `list()`:

```js
    /**
     * Install one admin mapping when the table is empty, so a fresh database is
     * reachable at all. Never overwrites an existing map: once an administrator
     * exists, the seed group must not be able to grant itself access again.
     * @param {string} groupName from SEED_ADMIN_GROUP
     * @returns {Promise<string|null>} the group seeded, or null
     */
    async seedIfEmpty(groupName) {
      if (!groupName) return null;
      const existing = await this.list();
      if (existing.length) return null;
      await this.set(groupName, "admin");
      return groupName;
    },
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/db/roleMapping.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Call it at boot in `server/index.js`**

In the `config.store === "mssql"` branch, after the repos are constructed:

```js
  const seeded = await repos.roleMapping.seedIfEmpty(config.seedAdminGroup);
  if (seeded) {
    log(`seeded role mapping: ${seeded} -> admin (first run)`);
  } else if ((await repos.roleMapping.list()).length === 0) {
    log("WARNING: dbo.RoleMapping is empty, so no sign-in can succeed. " +
        "Set SEED_ADMIN_GROUP and restart, or insert a row directly.");
  }
```

- [ ] **Step 6: Document it in `.env.example`**

Under the SQL Server block:

```bash
# First run only: the directory group installed as admin when dbo.RoleMapping is
# empty. Ignored once any mapping exists.
SEED_ADMIN_GROUP=GCIO-Dashboard-Admins
```

- [ ] **Step 7: Commit**

```bash
git add server/repos/roleMapping.js server/index.js test/db/roleMapping.test.js .env.example
git commit -m "fix(auth): seed one admin mapping so a fresh database is reachable"
```

---

### Task 2: Prove the SQL path against a real instance

Everything in the data layer is tested against a fake pool and has never touched SQL Server. **Blocked** until an account with `dbcreator` exists: the instance on the build machine has `sa` disabled and no other sysadmin.

**Files:**
- Create: `test/db/live.test.js`
- Modify: `package.json`

- [ ] **Step 1: Create the database and login**

Edit the password in `scripts/db-create.sql`, then, as a SQL sysadmin:

```bash
sqlcmd -S "localhost\SQLEXPRESS" -U sa -C -i scripts/db-create.sql
```

Put the same password in `.env` as `DB_PASSWORD` and confirm:

```bash
node scripts/db-check.mjs
```

Expected: `connected as: gcio_app` and `database GCIO: present`.

- [ ] **Step 2: Write the live test**

It skips itself unless `DB_LIVE=1`, so the default suite stays hermetic.

```js
import test from "node:test";
import assert from "node:assert/strict";
import sql from "mssql";
import { buildConfig } from "../../server/db/pool.js";
import { makeExecutor } from "../../server/db/executor.js";
import { migrate } from "../../server/db/migrations.js";
import { projectsRepo } from "../../server/repos/projects.js";
import { postureRepo } from "../../server/repos/posture.js";
import { SqlStore } from "../../server/store/sqlStore.js";
import { buildSummary } from "../../server/summarize.js";
import { ingestFile } from "../../server/ingest.js";

const live = process.env.DB_LIVE === "1";
const FILE = "livetest.xlsx";

test("the SQL path works end to end against a real instance", { skip: !live }, async (t) => {
  const pool = await new sql.ConnectionPool(buildConfig(process.env)).connect();
  const ex = makeExecutor(pool);

  t.after(async () => {
    for (const table of ["ProjectChild", "Project", "PostureDomain"]) {
      await ex.query(
        `IF OBJECT_ID('dbo.${table}','U') IS NOT NULL DELETE FROM dbo.${table} WHERE SourceFile = @f`,
        [{ name: "f", type: sql.NVarChar(260), value: FILE }]
      );
    }
    await pool.close();
  });

  const { applied } = await migrate(ex, { logger: { info() {} } });
  assert.ok(Array.isArray(applied), "migrations did not run");

  const parsed = ingestFile("sample-data/GCIO_Portfolio_Master.xlsx");
  assert.equal(parsed.ok, true, parsed.error);

  const repos = { projects: projectsRepo(ex), posture: postureRepo(ex) };
  await repos.projects.replaceForFile(FILE, parsed.projects);
  await repos.posture.replaceForFile(FILE, parsed.posture || []);

  const store = new SqlStore(repos);
  await store.refresh();
  assert.ok(store.projectCount >= parsed.projects.length);

  const summary = buildSummary(store, "weekly", "2026-08-24");
  assert.ok(summary.sections.priorities.items.length > 0, "no priorities came back from SQL");
  assert.equal(summary.sections.posture.available, (parsed.posture || []).length > 0);

  /* Re-applying the same workbook must not duplicate anything. */
  const before = store.projectCount;
  await repos.projects.replaceForFile(FILE, parsed.projects);
  await store.refresh();
  assert.equal(store.projectCount, before, "re-ingesting the same workbook duplicated projects");
});
```

- [ ] **Step 3: Add the script to `package.json`**

```json
    "test:db": "node --test test/db/live.test.js"
```

- [ ] **Step 4: Run it**

Run: `DB_LIVE=1 npm run test:db`
Expected: PASS. A permissions failure inside `migrate` means the login is not `db_owner` in `GCIO` — recheck `scripts/db-create.sql`.

- [ ] **Step 5: Boot against SQL and watch an ingest land**

```bash
STORE=mssql AUTH_MODE=dev DEV_ROLE=admin npm start
```

Copy a workbook into `data/`, confirm the ingest log line, then:

```bash
sqlcmd -S "localhost\SQLEXPRESS" -U gcio_app -C -d GCIO -Q "SELECT COUNT(*) AS projects FROM dbo.Project"
```

Expected: a count matching the log line.

- [ ] **Step 6: Commit**

```bash
git add test/db/live.test.js package.json
git commit -m "test(db): end-to-end coverage against a real SQL Server instance"
```

---

### Task 3: Let an administrator read the audit trail ✅ DONE

**Delivered.** `GET /api/audit`, admin-only, bounded and filterable, and the
read is itself audited. The file-backed sink's `recent()` was returning an empty
array, so memory mode would have shown "no events" over a file full of them —
now implemented, newest first, opening only as many daily files as the limit
needs. 12 tests.

`auditRepo.recent()` exists and nothing exposes it, so the trail can only be read with a SQL client.

**Files:**
- Modify: `server/app.js`
- Test: `test/api/app.test.js`

- [ ] **Step 1: Add the helper and the failing test**

Append to `test/api/app.test.js`:

```js
/** Like makeApp, but with a caller-supplied audit backend. */
function makeAppWith({ role, auditBackend }) {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  return createApp({
    store,
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ [`gcio-dashboard-${role}s`]: role }),
    audit: auditBackend,
    ldapAuthenticate: devAuthenticate(role),
    dataDir: "data",
    clientDist: "client/dist",
  });
}

test("only an admin may read the audit trail", async () => {
  const events = [{ at: "2026-08-24T09:00:00.000Z", actor: "a@x", action: "export", subject: "pptx weekly" }];
  const auditBackend = { append: async () => {}, recent: async () => events };

  const pm = await signedIn(makeAppWith({ role: "pm", auditBackend }));
  assert.equal((await pm.get("/api/audit")).status, 403);

  const admin = await signedIn(makeAppWith({ role: "admin", auditBackend }));
  const res = await admin.get("/api/audit");
  assert.equal(res.status, 200);
  assert.equal(res.body.events[0].action, "export");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/api/app.test.js`
Expected: FAIL — `/api/audit` answers 404 for both roles.

- [ ] **Step 3: Add the route in `server/app.js`**

After the projects routes:

```js
  app.get("/api/audit", requireRole("admin"), wrap(async (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const action = req.query.action ? String(req.query.action) : null;
    const events = await audit.recent({ limit, action });
    res.json({ count: events.length, events });
  }));
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/api/app.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app.js test/api/app.test.js
git commit -m "feat(audit): expose the audit trail to administrators"
```

---

### Task 4: Sign in with SSO from the browser

`POST /api/auth/sso` is implemented and tested, and nothing in the client calls it, so SSO is unreachable in production.

**Files:**
- Create: `client/src/lib/sso.js`
- Modify: `client/src/components/SignIn.jsx`
- Modify: `client/src/App.jsx`
- Modify: `server/auth/routes.js`

- [ ] **Step 1: Install MSAL**

```bash
npm install @azure/msal-browser@3.28.1
```

- [ ] **Step 2: Create `client/src/lib/sso.js`**

```js
/**
 * Entra sign-in from the browser. MSAL acquires an ID token; the server
 * validates it and decides everything. Nothing here makes an authorisation
 * decision of its own.
 */
import { PublicClientApplication } from "@azure/msal-browser";
import { postJSON } from "./api.js";

let app = null;

async function client(cfg) {
  if (app) return app;
  app = new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: "sessionStorage" },
  });
  await app.initialize();
  return app;
}

/**
 * Pop up the Microsoft sign-in, then exchange the ID token for a session.
 * @param {{clientId: string, tenantId: string}} cfg from /api/me
 */
export async function signInWithSso(cfg) {
  const msal = await client(cfg);
  const nonce = crypto.randomUUID();
  const result = await msal.loginPopup({ scopes: ["openid", "profile", "email"], nonce });
  return postJSON("/api/auth/sso", { idToken: result.idToken, nonce });
}
```

- [ ] **Step 3: Publish the public client details in `server/auth/routes.js`**

Replace the signed-out `/api/me` body with:

```js
      return res.json({
        authenticated: false,
        sso: Boolean(config.ssoEnabled),
        devMode: config.authMode === "dev",
        entra: config.ssoEnabled
          ? { clientId: config.entra.clientId, tenantId: config.entra.tenantId }
          : null,
      });
```

Client id and tenant id are public values in a public-client flow. The client secret is never sent to the browser.

- [ ] **Step 4: Add the button in `client/src/components/SignIn.jsx`**

Change the signature to `({ onSignedIn, devMode, sso, entra })`, import `signInWithSso`, and put this above the username field:

```jsx
        {sso && entra && (
          <>
            <button
              type="button"
              className="btn primary signin-submit"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  onSignedIn(await signInWithSso(entra));
                } catch (err) {
                  setError(err.message || "single sign-on failed");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Sign in with Microsoft
            </button>
            <p className="micro">or use your network account</p>
          </>
        )}
```

- [ ] **Step 5: Pass the flags through in `client/src/App.jsx`**

```jsx
    return (
      <SignIn
        devMode={me.devMode}
        sso={me.sso}
        entra={me.entra}
        onSignedIn={(signedIn) => setMe({ authenticated: true, ...signedIn })}
      />
    );
```

- [ ] **Step 6: Build and check by hand**

```bash
npm run build
```

With `SSO_ENABLED=false` the button must be absent and password sign-in must still work. Proving the button itself needs a real tenant, so that is a production check.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/sso.js client/src/components/SignIn.jsx client/src/App.jsx server/auth/routes.js package.json package-lock.json
git commit -m "feat(client): sign in with Entra single sign-on"
```

---

### Task 5: Windows service and IIS

**Files:**
- Create: `deploy/install-service.ps1`
- Create: `deploy/iis-site.md`
- Modify: `README.md`

- [ ] **Step 1: Write `deploy/install-service.ps1`**

```powershell
<#
  Installs GCIO Project Intelligence as a Windows service using NSSM.
  Run from an elevated PowerShell prompt in the repository root:

      .\deploy\install-service.ps1 -EnvFile C:\gcio\.env

  NSSM must be on PATH: https://nssm.cc/download
#>
param(
  [string]$ServiceName = "GCIOProjectIntelligence",
  [string]$EnvFile = "$PSScriptRoot\..\.env",
  [string]$NodeExe = (Get-Command node).Source
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\.."
$entry = Join-Path $root "server\index.js"
$logDir = Join-Path $root "logs"

if (-not (Test-Path $EnvFile)) { throw "environment file not found: $EnvFile" }
New-Item -ItemType Directory -Force $logDir | Out-Null

nssm install $ServiceName $NodeExe $entry
nssm set $ServiceName AppDirectory $root
nssm set $ServiceName AppStdout (Join-Path $logDir "service-out.log")
nssm set $ServiceName AppStderr (Join-Path $logDir "service-err.log")
nssm set $ServiceName AppRotateFiles 1
nssm set $ServiceName AppRotateBytes 10485760
nssm set $ServiceName Start SERVICE_AUTO_START
nssm set $ServiceName AppExit Default Restart
nssm set $ServiceName AppRestartDelay 5000

$pairs = Get-Content $EnvFile | Where-Object { $_ -match "^\s*[A-Z_]+=" -and $_ -notmatch "^\s*#" }
nssm set $ServiceName AppEnvironmentExtra ($pairs -join "`n")

Start-Service $ServiceName
Get-Service $ServiceName
Write-Host "Installed. Check readiness: curl http://127.0.0.1:8123/readyz"
```

For Windows Integrated authentication to SQL, run the service as the domain account and give that account a login (see the note at the foot of `scripts/db-create.sql`) — but read the driver caveat in `server/db/pool.js` first, because `trustedConnection` alone does not achieve it.

- [ ] **Step 2: Write `deploy/iis-site.md`**

````markdown
# IIS in front of the dashboard

Node listens on `127.0.0.1:8123` and never terminates TLS itself. IIS holds the
certificate and proxies to it.

## Prerequisites

- IIS with **URL Rewrite** and **Application Request Routing**
- The corporate certificate in the machine store, bound to the site's host name

## Steps

1. Create a site bound to `https://dashboard.<domain>` on 443 with the
   certificate. Remove any port 80 binding, or redirect http to https.
2. **IIS Manager → server node → Application Request Routing Cache → Server
   Proxy Settings → Enable proxy**.
3. Put this `web.config` in the site root:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="Proxy to GCIO" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:8123/{R:1}" />
          <serverVariables>
            <set name="HTTP_X_FORWARDED_PROTO" value="https" />
          </serverVariables>
        </rule>
      </rules>
    </rewrite>
    <security>
      <requestFiltering>
        <!-- 20 workbooks at 25 MB, plus multipart overhead -->
        <requestLimits maxAllowedContentLength="545259520" />
      </requestFiltering>
    </security>
    <httpProtocol>
      <customHeaders><remove name="X-Powered-By" /></customHeaders>
    </httpProtocol>
  </system.webServer>
</configuration>
```

4. Allow the forwarded-proto variable: **URL Rewrite → View Server Variables →
   Add → `HTTP_X_FORWARDED_PROTO`**.
5. If SSO is enabled, register `https://dashboard.<domain>` as a redirect URI on
   the Entra app registration.

## Verify

```powershell
curl.exe -I https://dashboard.<domain>/healthz     # 200
curl.exe -I http://127.0.0.1:8123/healthz          # 200, loopback only
```

From another machine `http://<server>:8123` must fail: with
`NODE_ENV=production` the process binds loopback only.
````

- [ ] **Step 3: Add an operations section to `README.md`**

```markdown
## Running it for real

1. Copy `.env.example` to `.env` and fill it in.
2. Create the database and login with `scripts/db-create.sql` (needs a SQL sysadmin).
3. `npm ci && npm run build`
4. Install the service: `.\deploy\install-service.ps1`
5. Put IIS in front for TLS: `deploy/iis-site.md`

Local development without SQL or a directory:
`STORE=memory AUTH_MODE=dev DEV_ROLE=pm npm start`. Both are refused when
`NODE_ENV=production`.
```

- [ ] **Step 4: Commit**

```bash
git add deploy/install-service.ps1 deploy/iis-site.md README.md
git commit -m "docs(deploy): Windows service installer and IIS TLS runbook"
```

---

### Task 6: Close out the phase

- [ ] **Step 1: Run everything**

```bash
npm test
DB_LIVE=1 npm run test:db
npm run build
node scripts/pptx-audit.mjs exports/api_pptx.pptx
```

Expected: all green, and the deck audit reports 0 problems.

- [ ] **Step 2: Verify the two behaviours the phase exists for**

```bash
curl -i "http://127.0.0.1:8123/api/summary?period=weekly"    # 401
```

and from another machine, `http://<server>:8123/healthz` must refuse to connect.

- [ ] **Step 3: Mark the phase delivered and tag**

```bash
git add docs/superpowers/specs/2026-08-24-backend-production-design.md
git commit -m "docs(spec): mark Phase 0 delivered"
git tag -a v1.1.0-p0 -m "Phase 0: authenticated, hardened, service-packaged pilot on SQL Server"
git push origin main --tags
```

---

## Self-review against the spec

| Spec requirement | Where |
| --- | --- |
| LDAP sign-in | delivered, `9ef09a9` |
| Entra SSO, server side | delivered, `111f520` |
| Entra SSO, browser side | Task 4 |
| Roles from directory groups | delivered, `9ef09a9` |
| A fresh database is reachable | delivered, Task 1 |
| Server-side sessions in SQL | delivered, `9ef09a9` |
| Audit of sign-in, upload, export | delivered, `2c47b9a` |
| Audit readable by an administrator | delivered, Task 3 |
| Security headers, CSP, throttle | delivered, `610a2ca` |
| CSRF | deliberately absent — `SameSite=Strict`, reasoning recorded in `server/middleware/securityHeaders.js` |
| Upload content sniffing | delivered, `2c47b9a` |
| Loopback binding, proxy trusted from localhost | delivered in `config.host`; the IIS half is Task 5 |
| Secrets from the environment, failing loudly | delivered, `2c47b9a` |
| `/healthz`, `/readyz` | delivered, `2c47b9a` |
| SQL proven against a live instance | **Task 2** — blocked on database permissions |
| Windows service | Task 5 |
| Test suite | delivered — 77 hermetic tests, plus Task 2's live test |

**Deferred to later phases by design:** the temporal history model (`project_version`, `source_file`, `ingest_run`, `question_asked`), the file vault, trends and "changed since last week", `/metrics`, the ingest/web role split using `sp_getapplock`, worker-thread parsing, and backup/restore drills. Nothing in this phase changes a ranking rule or an export layout.
