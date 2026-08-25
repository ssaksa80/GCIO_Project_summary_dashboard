# Backend Phase 1 — History Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dashboard a memory — record every workbook it ingests and every time a project actually changes, so later phases can answer "what changed since last week" and "how long has this been Red".

**Architecture:** `dbo.Project` stays exactly as it is: the current snapshot the dashboard reads, untouched read path, untouched section engine. Three new tables sit beside it — `SourceFile` (every workbook, by content hash), `IngestRun` (every attempt and its outcome), `ProjectVersion` (an append-only row each time a project's content hash changes). Every ingested file is copied into a **vault** before parsing, so any period can be re-derived and a bad parse replayed after a fix. Nothing user-visible changes in this phase.

**Tech Stack:** Node 24, `mssql` (tedious), `node:test` + `supertest`, SQL Server 2025.

**Spec:** `docs/superpowers/specs/2026-08-24-backend-production-design.md`

**Decisions taken before writing this plan:**
- **History is additive.** The spec originally replaced `Project` with a `valid_from`/`valid_to` temporal table. That was decided against: the read path, the store and the live tests all work today, and a defect in a brand-new history writer must not be able to break the dashboard everyone already uses. The cost — the newest `ProjectVersion` duplicates what `Project` holds — is accepted and documented.
- **Foundation only.** No trends, no "changed since last week", no question ageing. Those are Phase 2, and they will be built against history that has actually accumulated rather than against a fixture.
- **Growth is bounded by the edition, and that is a Phase 2/3 problem.** The
  instance is SQL Server 2025 **Express**, which caps a database at 10 GB.
  `ProjectVersion` grows forever: one row per changed project per ingest, each
  carrying the whole project as JSON. Measured against the real sample data the
  payload averages about 1.8 kB, so a 500-project portfolio ingested daily costs
  roughly 80–250 MB a year at a modest change rate and closer to 1 GB a year if
  most projects move together. That is years of headroom, not a reason to build
  archival now — but it is a real ceiling on a fixed-size database, and the
  choice between upgrading the edition and purging old versions should be made
  deliberately in Phase 2 rather than by an outage.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/db/migrations.js` | **modify** — add migrations 6 (`SourceFile`, `IngestRun`), 7 (`ProjectVersion`) and 8 (their constraints) |
| `server/ingest/hash.js` | **create** — content hashes: one for a file's bytes, one for a project's meaningful fields |
| `server/vault.js` | **create** — copy a workbook's bytes into the vault; look one up again |
| `server/repos/sourceFiles.js` | **create** — record a workbook and its hash; find the newest for a name |
| `server/repos/ingestRuns.js` | **create** — start a run, finish it with counts, list recent runs |
| `server/repos/projectVersions.js` | **create** — append a version when a project's hash changes; read a project's history |
| `server/store/sqlStore.js` | **modify** — `applyFile` records the run, the file and any changed versions |
| `server/index.js` | **modify** — construct the new repositories and the vault, pass them to the store |
| `server/app.js` | **modify** — `GET /api/ingest/runs` (admin) so the last ingests are visible |
| `server/config.js` | **modify** — `VAULT_DIR` |
| `test/ingest/hash.test.js` | **create** |
| `test/vault.test.js` | **create** |
| `test/db/history.test.js` | **create** — repositories against a scripted executor |
| `test/db/live.test.js` | **modify** — live coverage of the whole history path |

**A note on the commands.** Every shell block in this plan is bash — the
`VAR=1 command` prefix, `find`, `wc`. On this machine run them in Git Bash, not
PowerShell, where that prefix is a parse error. The PowerShell equivalent is
`$env:DB_LIVE = "1"; npm run test:db`.

---

### Task 1: Content hashes

Two different questions: "have I seen this exact file before" and "has this
project actually changed". Both are answered by a hash, and neither should be
invented twice.

**Files:**
- Create: `server/ingest/hash.js`
- Test: `test/ingest/hash.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { hashBytes, hashProject } from "../../server/ingest/hash.js";

const project = (over = {}) => ({
  id: "PRJ-1", name: "A Project", description: "", department: "IT", pillar: "Core",
  program: "", parentId: null, owner: "An Owner", sponsor: "A Sponsor", vendor: "",
  status: "In Progress", health: "Amber", priority: "High", phase: "Execution",
  approvalDate: "2025-01-01", startDate: "2025-06-01", targetEndDate: "2026-06-30",
  actualEndDate: null, budget: 1000, spent: 400, percentComplete: 45, currency: "AED",
  lastUpdated: "2026-08-20", sourceFile: "master.xlsx",
  milestones: [], updates: [], risks: [], questions: [],
  ...over,
});

test("the same bytes hash the same, different bytes do not", () => {
  assert.equal(hashBytes(Buffer.from("abc")), hashBytes(Buffer.from("abc")));
  assert.notEqual(hashBytes(Buffer.from("abc")), hashBytes(Buffer.from("abd")));
  assert.match(hashBytes(Buffer.from("abc")), /^[0-9a-f]{64}$/);
});

test("an unchanged project hashes the same however the object was built", () => {
  const a = project();
  const b = { ...project(), extraFieldNobodyAskedFor: true };
  assert.equal(hashProject(a), hashProject(b), "an unknown field changed the hash");
});

test("a changed field changes the hash", () => {
  assert.notEqual(hashProject(project()), hashProject(project({ health: "Red" })));
  assert.notEqual(hashProject(project()), hashProject(project({ percentComplete: 46 })));
  assert.notEqual(hashProject(project()), hashProject(project({ targetEndDate: "2026-07-31" })));
});

test("which workbook a project came from is not part of its content", () => {
  /* Moving a project between workbooks is not a change to the project. */
  assert.equal(hashProject(project()), hashProject(project({ sourceFile: "other.xlsx" })));
});

test("children count as content, because the drill-down shows them", () => {
  const withRisk = project({ risks: [{ title: "A risk", severity: "High", status: "Open" }] });
  assert.notEqual(hashProject(project()), hashProject(withRisk));

  const sameRisk = project({ risks: [{ title: "A risk", severity: "High", status: "Open" }] });
  assert.equal(hashProject(withRisk), hashProject(sameRisk));
});

test("child order from the workbook does not change the hash", () => {
  const one = project({ milestones: [{ name: "A" }, { name: "B" }] });
  const two = project({ milestones: [{ name: "B" }, { name: "A" }] });
  assert.equal(hashProject(one), hashProject(two), "row order in the sheet counted as a change");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/ingest/hash.test.js`
Expected: FAIL — cannot find `server/ingest/hash.js`.

- [ ] **Step 3: Implement `server/ingest/hash.js`**

```js
/**
 * Content hashes.
 *
 * Two questions, two hashes:
 *   hashBytes   — have I already ingested this exact file?
 *   hashProject — has this project actually changed, or was the workbook
 *                 merely re-saved?
 *
 * hashProject deliberately hashes a fixed field list rather than the whole
 * object: a field added to the pipeline later must not silently invalidate
 * every project's history. Adding a field here is a conscious act.
 */
import crypto from "node:crypto";

/** @param {Buffer} buffer @returns {string} lower-case sha256 */
export function hashBytes(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/* The fields that mean something to a reader of the dashboard. sourceFile is
   absent on purpose: moving a project between workbooks is not a change to it. */
const FIELDS = [
  "id", "name", "description", "department", "pillar", "program", "parentId",
  "owner", "sponsor", "vendor", "status", "health", "priority", "phase",
  "approvalDate", "startDate", "targetEndDate", "actualEndDate",
  "budget", "spent", "percentComplete", "currency", "lastUpdated",
];

const CHILDREN = ["milestones", "updates", "risks", "questions"];

/** Stable JSON: keys sorted, so two equal objects always serialise identically. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @param {object} project a normalised project
 * @returns {string} sha256 over its meaningful content
 */
export function hashProject(project) {
  const subject = {};
  for (const field of FIELDS) subject[field] = project[field] ?? null;

  for (const kind of CHILDREN) {
    /* Sorted by their serialised form: the order rows happen to sit in a
       sheet is not a change to the project. */
    subject[kind] = (project[kind] || []).map(stable).sort();
  }
  return crypto.createHash("sha256").update(stable(subject)).digest("hex");
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/ingest/hash.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/ingest/hash.js test/ingest/hash.test.js
git commit -m "feat(ingest): content hashes for files and projects"
```

---

### Task 2: The file vault

Every workbook is copied before it is parsed. This is the recovery story: any
period can be re-derived from scratch, and a bad parse can be replayed once the
parser is fixed.

**Files:**
- Create: `server/vault.js`
- Modify: `server/config.js`
- Modify: `.gitignore`
- Test: `test/vault.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVault } from "../server/vault.js";
import { hashBytes } from "../server/ingest/hash.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "gcio-vault-"));
const quiet = { error() {}, info() {} };

test("a stored file can be read back byte for byte", () => {
  const vault = createVault(scratch(), { logger: quiet });
  const bytes = Buffer.from("a workbook's bytes");
  const at = new Date("2026-08-25T10:00:00Z");

  const stored = vault.store(bytes, "master.xlsx", { at });
  assert.equal(stored.hash, hashBytes(bytes));
  assert.deepEqual(vault.read(stored.hash, ".xlsx"), bytes);
});

test("files are filed by year and month, so a folder never grows without bound", () => {
  const dir = scratch();
  const vault = createVault(dir, { logger: quiet });
  const stored = vault.store(Buffer.from("x"), "a.xlsx", { at: new Date("2026-08-25T10:00:00Z") });

  assert.match(stored.vaultPath.replace(/\\/g, "/"), /2026\/08\//);
  assert.ok(fs.existsSync(path.join(dir, stored.vaultPath)));
});

test("storing identical bytes twice keeps one copy", () => {
  const dir = scratch();
  const vault = createVault(dir, { logger: quiet });
  const bytes = Buffer.from("identical");

  const first = vault.store(bytes, "a.xlsx", { at: new Date("2026-08-25T10:00:00Z") });
  const second = vault.store(bytes, "b.xlsx", { at: new Date("2026-08-25T10:00:00Z") });

  assert.equal(first.hash, second.hash);
  assert.equal(first.vaultPath, second.vaultPath);
  const files = fs.readdirSync(path.join(dir, "2026", "08"));
  assert.equal(files.length, 1, "the same bytes were stored twice");
});

test("the extension is preserved so a replayed file is still openable", () => {
  const vault = createVault(scratch(), { logger: quiet });
  const stored = vault.store(Buffer.from("x"), "legacy.XLS", { at: new Date("2026-08-25T10:00:00Z") });
  assert.match(stored.vaultPath, /\.xls$/);
});

test("a vault that cannot be written reports it rather than pretending", () => {
  const vault = createVault(path.join(" ", "impossible"), { logger: quiet });
  assert.throws(() => vault.store(Buffer.from("x"), "a.xlsx"), /vault/i);
});

test("reading something the vault does not hold returns null", () => {
  const vault = createVault(scratch(), { logger: quiet });
  assert.equal(vault.read("0".repeat(64), ".xlsx"), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/vault.test.js`
Expected: FAIL — cannot find `server/vault.js`.

- [ ] **Step 3: Implement `server/vault.js`**

```js
/**
 * The workbook vault.
 *
 * Every ingested file is copied here before it is parsed, named by content
 * hash. Two reasons, both learned the hard way in systems like this:
 *
 *   - a parser bug is recoverable. Fix the parser, replay the vault, and the
 *     portfolio is rebuilt without asking anyone to re-send last month's files.
 *   - "what did the workbook actually say on the 12th" is answerable.
 *
 * Files are filed by year and month so no single directory grows without
 * bound, and identical bytes are stored once.
 */
import fs from "node:fs";
import path from "node:path";
import { hashBytes } from "./ingest/hash.js";

/**
 * @param {string} root vault directory
 * @param {{logger?: object}} [options]
 */
export function createVault(root, { logger = console } = {}) {
  return {
    root,

    /**
     * Copy bytes into the vault.
     * @param {Buffer} buffer
     * @param {string} originalName used only for its extension
     * @param {{at?: Date}} [options]
     * @returns {{hash: string, vaultPath: string, bytes: number}} vaultPath is relative to the root
     */
    store(buffer, originalName, { at = new Date() } = {}) {
      const hash = hashBytes(buffer);
      const ext = path.extname(originalName).toLowerCase() || ".bin";
      const year = String(at.getUTCFullYear());
      const month = String(at.getUTCMonth() + 1).padStart(2, "0");
      const relative = path.join(year, month, `${hash}${ext}`);
      const absolute = path.join(root, relative);

      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        /* Identical bytes are the same file; writing again would be pointless
           churn on a folder that only ever grows. */
        if (!fs.existsSync(absolute)) {
          const tmp = `${absolute}.writing`;
          fs.writeFileSync(tmp, buffer);
          fs.renameSync(tmp, absolute);
        }
      } catch (err) {
        logger.error?.(`[vault] could not store ${originalName}: ${err.message}`);
        throw new Error(`vault write failed for ${originalName}: ${err.message}`);
      }

      return { hash, vaultPath: relative, bytes: buffer.length };
    },

    /**
     * @param {string} hash
     * @param {string} ext including the dot
     * @returns {Buffer|null} null when the vault does not hold it
     */
    read(hash, ext) {
      const candidates = [];
      try {
        for (const year of fs.readdirSync(root)) {
          for (const month of fs.readdirSync(path.join(root, year))) {
            candidates.push(path.join(root, year, month, `${hash}${ext}`));
          }
        }
      } catch {
        return null; // nothing stored yet
      }
      const found = candidates.find((p) => fs.existsSync(p));
      return found ? fs.readFileSync(found) : null;
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/vault.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Add the setting in `server/config.js`**

Beside `auditDir` in the returned object:

```js
    vaultDir: env.VAULT_DIR || "vault",
```

- [ ] **Step 6: Keep the vault out of git**

Append to `.gitignore`:

```
# Ingested workbooks, kept for replay and audit. Real portfolio data.
vault/
```

And document it in `.env.example`, under the audit line:

```bash
# Every ingested workbook is copied here before parsing, named by content hash,
# so a parser fix can be replayed and "what did the file say" is answerable.
VAULT_DIR=vault
```

- [ ] **Step 7: Commit**

```bash
git add server/vault.js server/config.js test/vault.test.js .gitignore .env.example
git commit -m "feat(vault): keep every ingested workbook for replay"
```

**Amended after review (commit `954af90` plus a follow-up).** Four changes to the
code above, all of them defects in this plan rather than in the implementation:

1. `store` returns `vaultPath` built with `path.posix.join`, and builds the
   on-disk `absolute` path separately with `path.join`. The returned value is
   persisted to `dbo.SourceFile.VaultPath` and read by humans and scripts, so it
   must not carry Windows separators on one host and POSIX ones on another.
2. The `.writing` temp path is unique per call
   (`${absolute}.${process.pid}.${randomUUID()}.writing`), and a failed write
   unlinks it. Sharing one temp path across processes let a half-written file be
   renamed into place — silent, permanent corruption of the only copy.
3. `read` no longer swallows every error. Only `ENOENT` on the root means "not
   found"; anything else is logged and rethrown, because a recovery tool must
   never report a permissions failure as "the data is gone".
4. The plan's fifth test used `createVault(path.join(" ", "impossible"))`, a
   POSIX assumption. It points the root at a real file instead, so `mkdir`
   beneath it fails with `ENOTDIR` on any platform.

The README paragraph that Task 9 originally carried was also brought forward to
here: `vault/` is gitignored, so nothing tracked in the repo would otherwise tell
an operator that real portfolio data now lives there.

---

### Task 3: Schema for source files, runs and versions

**Files:**
- Modify: `server/db/migrations.js`
- Test: `test/db/repos.test.js` (the existing ordering test covers the new ids)

- [ ] **Step 1: Add migrations 6 and 7**

Append to the `MIGRATIONS` array in `server/db/migrations.js`, before the
closing `];`:

```js
  {
    id: 6,
    name: "source_files_and_runs",
    sql: `
      IF OBJECT_ID('dbo.SourceFile', 'U') IS NULL
      CREATE TABLE dbo.SourceFile (
        SourceFileId  BIGINT IDENTITY(1,1) PRIMARY KEY,
        FileName      NVARCHAR(260)  NOT NULL,
        Sha256        CHAR(64)       NOT NULL,
        Bytes         BIGINT         NOT NULL,
        VaultPath     NVARCHAR(400)  NULL,
        UploadedBy    NVARCHAR(320)  NULL,
        FirstSeenAt   DATETIME2(3)   NOT NULL,
        LastSeenAt    DATETIME2(3)   NOT NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_SourceFile_Name_Sha')
        CREATE UNIQUE INDEX UX_SourceFile_Name_Sha ON dbo.SourceFile (FileName, Sha256);

      IF OBJECT_ID('dbo.IngestRun', 'U') IS NULL
      CREATE TABLE dbo.IngestRun (
        IngestRunId     BIGINT IDENTITY(1,1) PRIMARY KEY,
        SourceFileId    BIGINT         NULL,
        FileName        NVARCHAR(260)  NOT NULL,
        TriggerSource   VARCHAR(16)    NOT NULL,   -- TRIGGER is a reserved word
        StartedAt       DATETIME2(3)   NOT NULL,
        FinishedAt      DATETIME2(3)   NULL,
        Outcome         VARCHAR(16)    NULL,
        ProjectsSeen    INT            NOT NULL CONSTRAINT DF_IngestRun_Seen DEFAULT (0),
        ProjectsChanged INT            NOT NULL CONSTRAINT DF_IngestRun_Changed DEFAULT (0),
        PostureRows     INT            NOT NULL CONSTRAINT DF_IngestRun_Posture DEFAULT (0),
        Error           NVARCHAR(1000) NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_IngestRun_StartedAt')
        CREATE INDEX IX_IngestRun_StartedAt ON dbo.IngestRun (StartedAt DESC);
    `,
  },
  {
    id: 7,
    name: "project_version",
    sql: `
      IF OBJECT_ID('dbo.ProjectVersion', 'U') IS NULL
      CREATE TABLE dbo.ProjectVersion (
        ProjectVersionId BIGINT IDENTITY(1,1) PRIMARY KEY,
        ProjectId        NVARCHAR(60)   NOT NULL,
        ContentHash      CHAR(64)       NOT NULL,
        IngestRunId      BIGINT         NULL,
        RecordedAt       DATETIME2(3)   NOT NULL,
        Name             NVARCHAR(400)  NOT NULL,
        Department       NVARCHAR(200)  NULL,
        Status           NVARCHAR(40)   NOT NULL,
        Health           NVARCHAR(20)   NOT NULL,
        Priority         NVARCHAR(20)   NOT NULL,
        Phase            NVARCHAR(40)   NULL,
        Owner            NVARCHAR(200)  NULL,
        TargetEndDate    DATE           NULL,
        ActualEndDate    DATE           NULL,
        Budget           DECIMAL(19,2)  NOT NULL CONSTRAINT DF_ProjectVersion_Budget DEFAULT (0),
        Spent            DECIMAL(19,2)  NOT NULL CONSTRAINT DF_ProjectVersion_Spent DEFAULT (0),
        PercentComplete  DECIMAL(5,2)   NOT NULL CONSTRAINT DF_ProjectVersion_Pct DEFAULT (0),
        OpenRisks        INT            NOT NULL CONSTRAINT DF_ProjectVersion_Risks DEFAULT (0),
        OpenQuestions    INT            NOT NULL CONSTRAINT DF_ProjectVersion_Questions DEFAULT (0),
        Payload          NVARCHAR(MAX)  NOT NULL
      );
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProjectVersion_Project')
        CREATE INDEX IX_ProjectVersion_Project ON dbo.ProjectVersion (ProjectId, RecordedAt DESC);
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ProjectVersion_RecordedAt')
        CREATE INDEX IX_ProjectVersion_RecordedAt ON dbo.ProjectVersion (RecordedAt DESC);
    `,
  },
```

`TriggerSource` rather than the obvious `Trigger`: TRIGGER is a T-SQL reserved
word, and a column named it must be bracketed at every single use. The JS-facing
field is still `trigger`; the repository does the translation once.

The `ProjectVersion` columns are duplicated out of `Payload` on purpose: Phase 2 asks "how many
were Red each week", and answering that by parsing JSON in SQL would be slow and
unindexable. `Payload` keeps the whole project so a version can be shown in
full without a second schema to maintain.

- [ ] **Step 2: Run the existing migration tests**

Run: `node --test test/db/repos.test.js`
Expected: PASS — the ordering test now covers ids 1–7.

- [ ] **Step 3: Apply them to the live database**

Run: `DB_LIVE=1 npm run test:db`
Expected: PASS. The first subtest applies 6 and 7 and then asserts a re-run is
a no-op.

- [ ] **Step 4: Commit**

```bash
git add server/db/migrations.js
git commit -m "feat(db): schema for source files, ingest runs and project versions"
```

---

### Task 3b: Constraints the history tables should have had — DONE (`cd0737c`)

Added after a schema review of Task 3, while all three tables still held zero
rows. Migrations are immutable once shipped, so 6 and 7 were left alone and
everything went into migration 8, `history_constraints`:

- `IX_ProjectVersion_Project` gains `INCLUDE (ContentHash)`. The bulk
  newest-hash query in Task 5 runs for every changed project on every ingest and
  selects exactly `(ProjectId, ContentHash)`; without the include, each row costs
  a key lookup and the cost grows with the accumulated history.
- `FK_IngestRun_SourceFile` and `FK_ProjectVersion_IngestRun`. Nothing in the
  codebase ever deletes a `SourceFile` or an `IngestRun`, so both are safe. Both
  columns stay nullable — a run with no vault bytes has no source file, and a
  version appended outside a run has no run.
  `ProjectVersion.ProjectId` deliberately gets NO key to `dbo.Project`:
  `replaceForFile` deletes and reinserts every project row on each ingest, so a
  constraint there would destroy the history it exists to protect.
- `CK_IngestRun_TriggerSource` (`watcher|upload|boot|replay`) and
  `CK_IngestRun_Outcome` (NULL, or `applied|unchanged|failed|removed`). Both are
  written from a fixed vocabulary in JavaScript; a typo would quietly corrupt
  every Phase 2 aggregate that counts runs by outcome.

The index replacement uses `CREATE INDEX ... WITH (DROP_EXISTING = ON)` rather
than a guarded `DROP` followed by a guarded `CREATE`. The implementer tested the
guarded pair adversarially against the live instance and found a real race: one
booting instance evaluates `IF EXISTS`, stalls, and then drops the index a second
instance has just recreated, leaving the table with no index of that name and no
error anywhere. `DROP_EXISTING` replaces it in one atomic statement.

Both constraint kinds were proven to bite: `TriggerSource = 'nonsense'`,
`Outcome = 'bogus'` and a dangling `SourceFileId` were each rejected with error
547, while `Outcome = NULL` and `SourceFileId = NULL` were accepted.

---

### Task 4: The source-file and ingest-run repositories

**Files:**
- Create: `server/repos/sourceFiles.js`
- Create: `server/repos/ingestRuns.js`
- Test: `test/db/history.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { sourceFilesRepo } from "../../server/repos/sourceFiles.js";
import { ingestRunsRepo } from "../../server/repos/ingestRuns.js";

function scriptedExecutor({ recordsets = {} } = {}) {
  const statements = [];
  const ex = {
    statements,
    async query(text, params) {
      statements.push({ text: text.trim(), params: params || [] });
      const needles = Object.keys(recordsets).sort((a, b) => b.length - a.length);
      for (const needle of needles) {
        if (text.includes(needle)) {
          const rows = recordsets[needle];
          return { recordset: rows, rowsAffected: [rows.length] };
        }
      }
      return { recordset: [], rowsAffected: [0] };
    },
    async tx(fn) { return fn(ex); },
  };
  return ex;
}

test("recording a file returns its id and whether it was already known", async () => {
  const ex = scriptedExecutor({ "SELECT SourceFileId": [{ SourceFileId: 7 }] });
  const result = await sourceFilesRepo(ex).record({
    fileName: "master.xlsx", sha256: "a".repeat(64), bytes: 1234,
    vaultPath: "2026/08/aaa.xlsx", uploadedBy: "pat@x",
  });

  assert.equal(result.sourceFileId, 7);
  assert.equal(result.alreadySeen, true);
  assert.ok(ex.statements.some((s) => s.text.startsWith("UPDATE dbo.SourceFile")),
    "a file we have seen before should have its LastSeenAt touched");
});

test("a file never seen before is inserted", async () => {
  const ex = scriptedExecutor({ "INSERT INTO dbo.SourceFile": [{ SourceFileId: 11 }] });
  const result = await sourceFilesRepo(ex).record({
    fileName: "new.xlsx", sha256: "b".repeat(64), bytes: 10, vaultPath: "2026/08/b.xlsx",
  });

  assert.equal(result.sourceFileId, 11);
  assert.equal(result.alreadySeen, false);
});

test("the newest hash for a name is what decides whether to re-parse", async () => {
  const ex = scriptedExecutor({ "SELECT TOP (1) Sha256": [{ Sha256: "c".repeat(64) }] });
  assert.equal(await sourceFilesRepo(ex).newestHashFor("master.xlsx"), "c".repeat(64));

  const empty = scriptedExecutor();
  assert.equal(await sourceFilesRepo(empty).newestHashFor("unknown.xlsx"), null);
});

test("a run is started, then finished with its counts", async () => {
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 42 }] });
  const runs = ingestRunsRepo(ex);

  const runId = await runs.start({ fileName: "master.xlsx", trigger: "watcher", sourceFileId: 7 });
  assert.equal(runId, 42);

  await runs.finish(runId, { outcome: "applied", projectsSeen: 34, projectsChanged: 3, postureRows: 10 });
  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  assert.ok(update, "the run was never finished");
  assert.equal(update.params.find((p) => p.name === "outcome").value, "applied");
  assert.equal(update.params.find((p) => p.name === "changed").value, 3);
});

test("a failed run records the reason, truncated to fit the column", async () => {
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 43 }] });
  const runs = ingestRunsRepo(ex);
  const runId = await runs.start({ fileName: "bad.xlsx", trigger: "upload" });

  await runs.finish(runId, { outcome: "failed", error: "x".repeat(5000) });
  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  assert.equal(update.params.find((p) => p.name === "error").value.length, 1000);
});

test("recent runs come back newest first and bounded", async () => {
  const ex = scriptedExecutor({ "FROM dbo.IngestRun": [] });
  await ingestRunsRepo(ex).recent({ limit: 999999 });
  const select = ex.statements.find((s) => s.text.includes("FROM dbo.IngestRun"));
  assert.equal(select.params.find((p) => p.name === "limit").value, 200);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/db/history.test.js`
Expected: FAIL — cannot find `server/repos/sourceFiles.js`.

- [ ] **Step 3: Implement `server/repos/sourceFiles.js`**

```js
/**
 * Every workbook the dashboard has ever ingested, identified by content hash.
 *
 * A file re-saved with no changes has the same hash, which is what lets the
 * ingester skip work instead of rewriting the portfolio for nothing.
 */
import { sql } from "../db/executor.js";

export function sourceFilesRepo(ex) {
  return {
    /**
     * Record that this exact file was seen. Idempotent on (name, hash).
     * @param {{fileName: string, sha256: string, bytes: number, vaultPath?: string, uploadedBy?: string}} file
     * @returns {Promise<{sourceFileId: number, alreadySeen: boolean}>}
     */
    async record({ fileName, sha256, bytes, vaultPath = null, uploadedBy = null }) {
      const existing = await ex.query(`
        SELECT SourceFileId FROM dbo.SourceFile WHERE FileName = @name AND Sha256 = @sha
      `, [
        { name: "name", type: sql.NVarChar(260), value: fileName },
        { name: "sha", type: sql.Char(64), value: sha256 },
      ]);

      if (existing.recordset.length) {
        await ex.query("UPDATE dbo.SourceFile SET LastSeenAt = SYSUTCDATETIME() WHERE SourceFileId = @id", [
          { name: "id", type: sql.BigInt, value: existing.recordset[0].SourceFileId },
        ]);
        return { sourceFileId: Number(existing.recordset[0].SourceFileId), alreadySeen: true };
      }

      const inserted = await ex.query(`
        INSERT INTO dbo.SourceFile (FileName, Sha256, Bytes, VaultPath, UploadedBy, FirstSeenAt, LastSeenAt)
        OUTPUT INSERTED.SourceFileId
        VALUES (@name, @sha, @bytes, @vault, @by, SYSUTCDATETIME(), SYSUTCDATETIME())
      `, [
        { name: "name", type: sql.NVarChar(260), value: fileName },
        { name: "sha", type: sql.Char(64), value: sha256 },
        { name: "bytes", type: sql.BigInt, value: Number(bytes) || 0 },
        { name: "vault", type: sql.NVarChar(400), value: vaultPath },
        { name: "by", type: sql.NVarChar(320), value: uploadedBy },
      ]);
      return { sourceFileId: Number(inserted.recordset[0].SourceFileId), alreadySeen: false };
    },

    /** The hash of the most recent version of a named file, or null. */
    async newestHashFor(fileName) {
      const { recordset } = await ex.query(`
        SELECT TOP (1) Sha256 FROM dbo.SourceFile WHERE FileName = @name ORDER BY LastSeenAt DESC
      `, [{ name: "name", type: sql.NVarChar(260), value: fileName }]);
      return recordset.length ? recordset[0].Sha256 : null;
    },
  };
}
```

- [ ] **Step 4: Implement `server/repos/ingestRuns.js`**

```js
/**
 * One row per ingest attempt, successful or not.
 *
 * This is the answer to "why does the dashboard not show last night's file":
 * either there is no run, or there is a run with an outcome and a reason.
 */
import { sql } from "../db/executor.js";

const ERROR_MAX = 1000;

export function ingestRunsRepo(ex) {
  return {
    /**
     * @param {{fileName: string, trigger: "watcher"|"upload"|"boot"|"replay", sourceFileId?: number|null}} run
     * @returns {Promise<number>} the run id
     */
    async start({ fileName, trigger, sourceFileId = null }) {
      const { recordset } = await ex.query(`
        INSERT INTO dbo.IngestRun (SourceFileId, FileName, TriggerSource, StartedAt)
        OUTPUT INSERTED.IngestRunId
        VALUES (@sourceFileId, @name, @trigger, SYSUTCDATETIME())
      `, [
        { name: "sourceFileId", type: sql.BigInt, value: sourceFileId },
        { name: "name", type: sql.NVarChar(260), value: fileName },
        { name: "trigger", type: sql.VarChar(16), value: trigger },
      ]);
      return Number(recordset[0].IngestRunId);
    },

    /**
     * @param {number} runId
     * @param {{outcome: "applied"|"unchanged"|"failed"|"removed", projectsSeen?: number,
     *          projectsChanged?: number, postureRows?: number, error?: string|null}} result
     */
    async finish(runId, { outcome, projectsSeen = 0, projectsChanged = 0, postureRows = 0, error = null }) {
      await ex.query(`
        UPDATE dbo.IngestRun
           SET FinishedAt = SYSUTCDATETIME(), Outcome = @outcome,
               ProjectsSeen = @seen, ProjectsChanged = @changed,
               PostureRows = @posture, Error = @error
         WHERE IngestRunId = @id
      `, [
        { name: "id", type: sql.BigInt, value: runId },
        { name: "outcome", type: sql.VarChar(16), value: outcome },
        { name: "seen", type: sql.Int, value: Number(projectsSeen) || 0 },
        { name: "changed", type: sql.Int, value: Number(projectsChanged) || 0 },
        { name: "posture", type: sql.Int, value: Number(postureRows) || 0 },
        /* Truncated rather than rejected: a run must always be closed, and a
           5,000-character parser message must not be what stops that. */
        { name: "error", type: sql.NVarChar(ERROR_MAX), value: error ? String(error).slice(0, ERROR_MAX) : null },
      ]);
    },

    /** Newest first. */
    async recent({ limit = 200 } = {}) {
      const { recordset } = await ex.query(`
        SELECT TOP (@limit) IngestRunId, FileName, TriggerSource, StartedAt, FinishedAt,
               Outcome, ProjectsSeen, ProjectsChanged, PostureRows, Error
        FROM dbo.IngestRun ORDER BY StartedAt DESC
      `, [{ name: "limit", type: sql.Int, value: Math.min(500, Math.max(1, Number(limit) || 200)) }]);

      return recordset.map((r) => ({
        id: Number(r.IngestRunId),
        fileName: r.FileName,
        trigger: r.TriggerSource,
        startedAt: r.StartedAt.toISOString(),
        finishedAt: r.FinishedAt ? r.FinishedAt.toISOString() : null,
        outcome: r.Outcome,
        projectsSeen: r.ProjectsSeen,
        projectsChanged: r.ProjectsChanged,
        postureRows: r.PostureRows,
        error: r.Error || null,
      }));
    },
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/db/history.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add server/repos/sourceFiles.js server/repos/ingestRuns.js test/db/history.test.js
git commit -m "feat(db): source-file and ingest-run repositories"
```

**Amended after review.** Six changes to the code above, all defects in this
plan rather than in the implementation:

1. **`record()` is one `MERGE ... WITH (HOLDLOCK)`**, not SELECT-then-branch.
   `UX_SourceFile_Name_Sha` is UNIQUE, and chokidar registers `add` and `change`
   independently without awaiting one handler before firing the next — so a
   save-then-touch from Excel can put two `record()` calls for identical bytes in
   flight at once and one dies on a duplicate key. A plain transaction does not
   help under READ COMMITTED; the range lock does. `OUTPUT $action` yields
   `alreadySeen`. This matches the upsert idiom already in `roleMapping.set()`.
2. **`finish()` logs when it closes nothing.** A zero-row UPDATE is not an
   error, so a stale id would leave a run open forever — the exact failure this
   table exists to make visible. Logged, not thrown: the caller is usually
   already handling its own failure.
3. **`recent()` guards the date conversion** with `instanceof Date`, matching
   `audit.js`, `sessions.js` and `projects.js`. This was the only repository
   breaking that convention.
4. **`finish()` takes an optional `sourceFileId`**, applied with `COALESCE` so
   omitting it does not blank an existing value. Task 6 needs this because the
   run is now opened before the source file is recorded.
5. **Surrogate-safe truncation** of the error text, and the trigger and outcome
   vocabularies exported as `INGEST_TRIGGERS` / `INGEST_OUTCOMES` with `start()`
   and `finish()` rejecting anything outside them. There is no type checking in
   this project, so without that a typo surfaces as SQL error 547 at runtime.
6. The plan's `scriptedExecutor` helper was declared
   `function scriptedExecutor({ recordsets = {} } = {})` while every call site
   passes the needle map directly, so no needle would ever have matched and every
   test would have failed on undefined rows. Signature corrected to
   `function scriptedExecutor(recordsets = {})`. The plan's last test also
   asserted a clamp of `200` against an implementation clamping at `500`; the
   implementation is right, because Task 7's route allows 500 and a lower
   repository ceiling would silently return less than the caller asked for.

Note that `test/db/repos.test.js` has a DIFFERENT helper of the same name, with
a `{ recordsets }` signature, transaction markers and `failOn` support. They are
deliberately not merged; the header comment in each says so.

---

### Task 5: The project-version repository

**Files:**
- Create: `server/repos/projectVersions.js`
- Modify: `test/db/history.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/db/history.test.js`:

```js
import { projectVersionsRepo } from "../../server/repos/projectVersions.js";

const versionProject = (over = {}) => ({
  id: "PRJ-1", name: "A Project", department: "IT", status: "In Progress",
  health: "Amber", priority: "High", phase: "Execution", owner: "An Owner",
  targetEndDate: "2026-06-30", actualEndDate: null,
  budget: 1000, spent: 400, percentComplete: 45,
  milestones: [], updates: [],
  risks: [{ title: "r", severity: "High", status: "Open" }],
  questions: [{ text: "q", status: "Open", source: "workbook" }],
  ...over,
});

test("only projects whose hash changed are appended", async () => {
  /* PRJ-1 is unchanged, PRJ-2 is new. */
  const ex = scriptedExecutor({
    "SELECT ProjectId, ContentHash": [{ ProjectId: "PRJ-1", ContentHash: "known-hash" }],
  });

  const written = await projectVersionsRepo(ex).appendChanged(
    [
      { project: versionProject({ id: "PRJ-1" }), hash: "known-hash" },
      { project: versionProject({ id: "PRJ-2" }), hash: "new-hash" },
    ],
    { ingestRunId: 5 }
  );

  assert.equal(written, 1, "an unchanged project was versioned again");
  const inserts = ex.statements.filter((s) => s.text.includes("INSERT INTO dbo.ProjectVersion"));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params.find((p) => p.name === "projectId").value, "PRJ-2");
});

test("open risks and questions are counted out for later querying", async () => {
  const ex = scriptedExecutor();
  await projectVersionsRepo(ex).appendChanged(
    [{ project: versionProject({
        risks: [
          { title: "a", severity: "High", status: "Open" },
          { title: "b", severity: "Low", status: "Closed" },
        ],
        questions: [{ text: "q", status: "Open" }],
      }), hash: "h" }],
    { ingestRunId: 1 }
  );

  const insert = ex.statements.find((s) => s.text.includes("INSERT INTO dbo.ProjectVersion"));
  assert.equal(insert.params.find((p) => p.name === "openRisks").value, 1, "closed risks were counted");
  assert.equal(insert.params.find((p) => p.name === "openQuestions").value, 1);
});

test("the whole project is kept in the payload", async () => {
  const ex = scriptedExecutor();
  await projectVersionsRepo(ex).appendChanged(
    [{ project: versionProject({ name: "Payload Test" }), hash: "h" }], { ingestRunId: 1 });

  const insert = ex.statements.find((s) => s.text.includes("INSERT INTO dbo.ProjectVersion"));
  const payload = JSON.parse(insert.params.find((p) => p.name === "payload").value);
  assert.equal(payload.name, "Payload Test");
  assert.equal(payload.risks.length, 1);
});

test("a project's history reads back newest first", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.ProjectVersion": [
      { RecordedAt: new Date("2026-08-20T09:00:00Z"), Health: "Red", Status: "In Progress",
        PercentComplete: 40, Budget: 1000, Spent: 500, OpenRisks: 2, OpenQuestions: 1,
        ContentHash: "h2", TargetEndDate: new Date("2026-06-30T00:00:00Z") },
    ],
  });

  const history = await projectVersionsRepo(ex).historyFor("PRJ-1", { limit: 10 });
  assert.equal(history.length, 1);
  assert.equal(history[0].health, "Red");
  assert.equal(history[0].recordedAt, "2026-08-20T09:00:00.000Z");
  assert.equal(history[0].targetEndDate, "2026-06-30");
});

test("nothing to write is not a database round trip", async () => {
  const ex = scriptedExecutor();
  assert.equal(await projectVersionsRepo(ex).appendChanged([], { ingestRunId: 1 }), 0);
  assert.equal(ex.statements.length, 0, "an empty ingest still queried the database");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/db/history.test.js`
Expected: FAIL — cannot find `server/repos/projectVersions.js`.

- [ ] **Step 3: Implement `server/repos/projectVersions.js`**

```js
/**
 * Append-only project history.
 *
 * A row is written only when a project's content hash differs from the newest
 * one already recorded, so re-saving a workbook does not manufacture history.
 * dbo.Project remains the current snapshot the dashboard reads; this table is
 * purely additive, and a defect here cannot break today's view.
 */
import { sql } from "../db/executor.js";

const openCount = (items, kind) =>
  (items || []).filter((item) => {
    const status = String(item.status || "Open").toLowerCase();
    return kind === "risk" ? status !== "closed" : status !== "closed" && status !== "answered";
  }).length;

const toDate = (v) => (v ? new Date(v) : null);
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d || null);

export function projectVersionsRepo(ex) {
  return {
    /**
     * Append a version for each project whose hash is new.
     * @param {{project: object, hash: string}[]} candidates
     * @param {{ingestRunId: number|null}} context
     * @returns {Promise<number>} how many versions were written
     */
    async appendChanged(candidates, { ingestRunId = null } = {}) {
      if (!candidates || candidates.length === 0) return 0;

      /* One query for the newest hash of every project in this file, rather
         than one per project: a 500-project workbook should not cost 500
         round trips to discover that nothing changed. */
      const ids = candidates.map((c) => c.project.id);
      const { recordset } = await ex.query(`
        SELECT ProjectId, ContentHash FROM (
          SELECT ProjectId, ContentHash,
                 ROW_NUMBER() OVER (PARTITION BY ProjectId ORDER BY RecordedAt DESC, ProjectVersionId DESC) AS rn
          FROM dbo.ProjectVersion
          WHERE ProjectId IN (SELECT value FROM STRING_SPLIT(@ids, ','))
        ) newest WHERE rn = 1
      `, [{ name: "ids", type: sql.NVarChar(sql.MAX), value: ids.join(",") }]);

      const newestByProject = new Map(recordset.map((r) => [r.ProjectId, r.ContentHash]));

      let written = 0;
      for (const { project, hash } of candidates) {
        if (newestByProject.get(project.id) === hash) continue;

        await ex.query(`
          INSERT INTO dbo.ProjectVersion
            (ProjectId, ContentHash, IngestRunId, RecordedAt, Name, Department, Status, Health,
             Priority, Phase, Owner, TargetEndDate, ActualEndDate, Budget, Spent, PercentComplete,
             OpenRisks, OpenQuestions, Payload)
          VALUES
            (@projectId, @hash, @runId, SYSUTCDATETIME(), @name, @department, @status, @health,
             @priority, @phase, @owner, @targetEnd, @actualEnd, @budget, @spent, @pct,
             @openRisks, @openQuestions, @payload)
        `, [
          { name: "projectId", type: sql.NVarChar(60), value: project.id },
          { name: "hash", type: sql.Char(64), value: hash },
          { name: "runId", type: sql.BigInt, value: ingestRunId },
          { name: "name", type: sql.NVarChar(400), value: project.name },
          { name: "department", type: sql.NVarChar(200), value: project.department || null },
          { name: "status", type: sql.NVarChar(40), value: project.status },
          { name: "health", type: sql.NVarChar(20), value: project.health },
          { name: "priority", type: sql.NVarChar(20), value: project.priority },
          { name: "phase", type: sql.NVarChar(40), value: project.phase || null },
          { name: "owner", type: sql.NVarChar(200), value: project.owner || null },
          { name: "targetEnd", type: sql.Date, value: toDate(project.targetEndDate) },
          { name: "actualEnd", type: sql.Date, value: toDate(project.actualEndDate) },
          { name: "budget", type: sql.Decimal(19, 2), value: Number(project.budget) || 0 },
          { name: "spent", type: sql.Decimal(19, 2), value: Number(project.spent) || 0 },
          { name: "pct", type: sql.Decimal(5, 2), value: Number(project.percentComplete) || 0 },
          { name: "openRisks", type: sql.Int, value: openCount(project.risks, "risk") },
          { name: "openQuestions", type: sql.Int, value: openCount(project.questions, "question") },
          { name: "payload", type: sql.NVarChar(sql.MAX), value: JSON.stringify(project) },
        ]);
        written += 1;
      }
      return written;
    },

    /**
     * One project's recorded history, newest first.
     * @param {string} projectId
     * @param {{limit?: number}} [options]
     */
    async historyFor(projectId, { limit = 50 } = {}) {
      const { recordset } = await ex.query(`
        SELECT TOP (@limit) RecordedAt, ContentHash, Status, Health, PercentComplete,
               Budget, Spent, OpenRisks, OpenQuestions, TargetEndDate
        FROM dbo.ProjectVersion
        WHERE ProjectId = @id
        ORDER BY RecordedAt DESC, ProjectVersionId DESC
      `, [
        { name: "id", type: sql.NVarChar(60), value: projectId },
        { name: "limit", type: sql.Int, value: Math.min(500, Math.max(1, Number(limit) || 50)) },
      ]);

      return recordset.map((r) => ({
        recordedAt: r.RecordedAt.toISOString(),
        contentHash: r.ContentHash,
        status: r.Status,
        health: r.Health,
        percentComplete: Number(r.PercentComplete),
        budget: Number(r.Budget),
        spent: Number(r.Spent),
        openRisks: r.OpenRisks,
        openQuestions: r.OpenQuestions,
        targetEndDate: iso(r.TargetEndDate),
      }));
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/db/history.test.js`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add server/repos/projectVersions.js test/db/history.test.js
git commit -m "feat(db): append-only project version history"
```

**Amended after the Task 3 schema review.** Two changes to `appendChanged`
above, both found by reading its SQL rather than running it:

1. **Wrap the read and the writes in one transaction.** The method reads each
   project's newest hash and then conditionally inserts. Two ingests of the same
   project interleaving between those two steps would append two consecutive
   rows with an identical hash — precisely what the method exists to prevent.
   The watcher handles events serially today, so this is not reachable yet, but
   a manual replay running alongside it would reach it. Change the body to:

   ```js
     async appendChanged(candidates, { ingestRunId = null } = {}) {
       if (!candidates || candidates.length === 0) return 0;

       return ex.tx(async (tx) => {
         /* ... the existing body, with every ex.query replaced by tx.query ... */
         return written;
       });
     },
   ```

   The scripted executor in the test already implements `tx(fn)` as `fn(ex)`, so
   the existing tests keep working unchanged.

2. **Refuse a project id containing a comma.** The bulk query passes ids to
   `STRING_SPLIT(@ids, ',')` as one comma-joined string. A project id with a
   comma in it would split into two ids that match nothing, and the method would
   silently append a version for a project it had just decided was unchanged.
   Fail loudly instead, immediately after building `ids`:

   ```js
         const offending = ids.filter((id) => String(id).includes(","));
         if (offending.length) {
           /* The bulk lookup joins ids with commas for STRING_SPLIT. A comma in
              an id would split it in two, match nothing, and silently append a
              version for a project that had not changed. */
           throw new Error(`project ids must not contain a comma: ${offending.join(" ")}`);
         }
   ```

   Add a test asserting it throws rather than silently mis-splitting.

---

### Task 6: Wire history into the ingest path

**Files:**
- Modify: `server/store/sqlStore.js`
- Modify: `server/index.js`
- Test: `test/db/sqlStoreHistory.test.js`

- [ ] **Step 1: Write the failing test**

```js
/**
 * SqlStore's history side. The repositories are faked: what matters here is
 * that a run is always opened and always closed, that the vault is written
 * before anything else, and that an unchanged file is recognised as such.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SqlStore } from "../../server/store/sqlStore.js";

const quiet = { error() {}, info() {} };

function harness({ newestHash = null, changed = 2 } = {}) {
  const calls = [];
  const repos = {
    projects: {
      async all() { return []; },
      async replaceForFile(file, projects) { calls.push(["projects.replace", file, projects.length]); },
      async removeFile(file) { calls.push(["projects.remove", file]); return 3; },
    },
    posture: {
      async list() { return []; },
      async replaceForFile(file, rows) { calls.push(["posture.replace", file, rows.length]); },
      async removeFile(file) { calls.push(["posture.remove", file]); return 1; },
    },
    sourceFiles: {
      async record(file) { calls.push(["sourceFiles.record", file.fileName, file.sha256]); return { sourceFileId: 1, alreadySeen: false }; },
      async newestHashFor() { return newestHash; },
    },
    ingestRuns: {
      async start(run) { calls.push(["runs.start", run.fileName, run.trigger]); return 99; },
      async finish(id, result) {
        /* The error text carries whether the snapshot had already moved, so the
           harness has to keep it rather than only the counts. */
        calls.push(["runs.finish", id, result.outcome, result.error ?? result.projectsChanged]);
      },
    },
    projectVersions: {
      async appendChanged() { calls.push(["versions.append"]); return changed; },
    },
  };
  const vault = {
    store(buffer, name) { calls.push(["vault.store", name, buffer.length]); return { hash: "deadbeef", vaultPath: "2026/08/x.xlsx", bytes: buffer.length }; },
  };
  return { calls, store: new SqlStore(repos, { vault, logger: quiet }) };
}

const parsed = (over = {}) => ({
  ok: true, file: "master.xlsx",
  projects: [{ id: "PRJ-1", name: "One", status: "In Progress", health: "Green", priority: "Low",
               milestones: [], updates: [], risks: [], questions: [] }],
  posture: [{ domain: "Identity", status: "Partial", score: 60, target: 90 }],
  bytes: Buffer.from("workbook bytes"),
  ...over,
});

test("an ingest vaults the bytes, records the file, and closes the run", async () => {
  const { calls, store } = harness();
  await store.applyFile(parsed(), { trigger: "watcher" });

  const order = calls.map((c) => c[0]);
  assert.equal(order[0], "runs.start", "the run must be open before anything that can fail");
  assert.ok(order.indexOf("vault.store") < order.indexOf("projects.replace"),
    "the bytes must be vaulted before they are parsed into the database");
  assert.ok(order.includes("sourceFiles.record"));
  assert.ok(order.includes("versions.append"));

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.deepEqual(finish, ["runs.finish", 99, "applied", 2]);   // no error, so the count
});

test("a file whose hash has not changed is recorded as unchanged and not rewritten", async () => {
  const { calls, store } = harness({ newestHash: "deadbeef" });
  await store.applyFile(parsed(), { trigger: "watcher" });

  assert.ok(!calls.some((c) => c[0] === "projects.replace"), "an unchanged file was rewritten");
  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.equal(finish[2], "unchanged");
});

test("a failure still closes the run, with the reason", async () => {
  const { calls, store } = harness();
  store.repos.projects.replaceForFile = async () => { throw new Error("database is down"); };

  await assert.rejects(() => store.applyFile(parsed(), { trigger: "upload" }), /database is down/);

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.ok(finish, "the run was left open");
  assert.equal(finish[2], "failed");
});

test("a history failure after the snapshot moved says so", async () => {
  /* appendChanged rolls itself back, but dbo.Project has already been updated.
     A bare "failed" would read as "nothing happened", which is the opposite of
     what an operator needs to know. */
  const { calls, store } = harness();
  store.repos.projectVersions.appendChanged = async () => { throw new Error("lock timeout"); };

  await assert.rejects(() => store.applyFile(parsed(), { trigger: "watcher" }), /lock timeout/);

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.equal(finish[2], "failed");
  assert.match(finish[3] ?? "", /snapshot applied but history not recorded/);
});

test("a vault failure is recorded as a failed run, not as no run at all", async () => {
  /* The vault write happens before any database write. If it throws and the
     run were opened later, there would be nothing anywhere saying why the
     workbook never appeared. */
  const { calls, store } = harness();
  store.vault = { store() { throw new Error("vault write failed for master.xlsx: EACCES"); } };

  await assert.rejects(() => store.applyFile(parsed(), { trigger: "watcher" }), /vault write failed/);

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.ok(finish, "a vault failure left no run behind");
  assert.equal(finish[2], "failed");
  assert.ok(!calls.some((c) => c[0] === "projects.replace"), "the database was written despite the vault failing");
});

test("removing a file records a run too", async () => {
  const { calls, store } = harness();
  await store.removeFile("master.xlsx");

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.equal(finish[2], "removed");
});

test("history is optional, so the store still works without it", async () => {
  /* STORE=mssql on a database migrated only to Phase 0 must not crash. */
  const repos = {
    projects: { async all() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
    posture: { async list() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
  };
  const store = new SqlStore(repos, { logger: quiet });
  await store.applyFile(parsed(), { trigger: "boot" });
  assert.equal(store.projectCount, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/db/sqlStoreHistory.test.js`
Expected: FAIL — `applyFile` ignores the second argument and never touches the
vault or the run repositories.

- [ ] **Step 3: Rewrite `applyFile` and `removeFile` in `server/store/sqlStore.js`**

Add the import at the top of the file:

```js
import { hashProject } from "../ingest/hash.js";
```

Then replace the constructor (`server/store/sqlStore.js:22-40`) and both write
methods (`:79-104`). `log`, `emit`, `refresh` and the whole read side stay
exactly as they are:

```js
  /**
   * @param {{projects: object, posture: object, sourceFiles?: object,
   *          ingestRuns?: object, projectVersions?: object}} repos
   * @param {{vault?: object, logger?: object}} [options]
   */
  constructor(repos, { vault = null, logger = console } = {}) {
    this.repos = repos;
    this.vault = vault;
    this.logger = logger;

    /** @type {Map<string, object>} the read model */
    this.projectsById = new Map();
    /** @type {object[]} */
    this.postureRows = [];
    /** @type {Set<function>} SSE listeners: fn(eventName, payload) */
    this.listeners = new Set();
    /** @type {Array<object>} newest-first, capped */
    this.ingestLog = [];

    this.lastIngestAt = null;
    this.demoMode = false;
    this.sourceFiles = new Set();
    this.ready = false;
  }

  /** True when the database has the Phase 1 history tables wired in. */
  get tracksHistory() {
    return Boolean(this.repos.sourceFiles && this.repos.ingestRuns && this.repos.projectVersions);
  }

  /**
   * Persist one workbook's parse result and record what happened.
   *
   * Order matters: the bytes go to the vault first, so a crash midway leaves a
   * replayable file rather than a half-written portfolio and no source.
   *
   * @param {{file: string, projects: object[], posture?: object[], bytes?: Buffer}} result
   * @param {{trigger?: "watcher"|"upload"|"boot"|"replay", actor?: string}} [context]
   */
  async applyFile(result, { trigger = "watcher", actor = null } = {}) {
    if (!this.tracksHistory) {
      await this.repos.projects.replaceForFile(result.file, result.projects);
      await this.repos.posture.replaceForFile(result.file, result.posture || []);
      this.lastIngestAt = new Date().toISOString();
      await this.refresh();
      this.log({
        file: result.file, ok: true,
        projects: result.projects.length,
        postureDomains: (result.posture || []).length,
      });
      return result.projects.length;
    }

    /* The run is opened before anything else can fail. Vaulting the bytes and
       recording the source file can both throw, and if the run were opened
       after them the one failure mode that happens first would be the one this
       table cannot explain. The source file is attached when the run closes. */
    const runId = await this.repos.ingestRuns.start({ fileName: result.file, trigger });

    /* "failed" would otherwise mean two different things: nothing happened, or
       the dashboard moved and only the history is missing. An operator reading
       the run needs to know which. */
    let snapshotWritten = false;

    try {
      const vaulted = this.vault && result.bytes
        ? this.vault.store(result.bytes, result.file)
        : null;

      /* Read the newest hash BEFORE recording this one, or it compares the file
         against itself and every ingest looks unchanged. */
      const unchanged = vaulted
        ? (await this.repos.sourceFiles.newestHashFor(result.file)) === vaulted.hash
        : false;

      const recorded = vaulted
        ? await this.repos.sourceFiles.record({
            fileName: result.file, sha256: vaulted.hash, bytes: vaulted.bytes,
            vaultPath: vaulted.vaultPath, uploadedBy: actor,
          })
        : { sourceFileId: null };

      if (unchanged) {
        await this.repos.ingestRuns.finish(runId, {
          outcome: "unchanged",
          projectsSeen: result.projects.length,
          sourceFileId: recorded.sourceFileId,
        });
        this.log({ file: result.file, ok: true, unchanged: true });
        return 0;
      }

      await this.repos.projects.replaceForFile(result.file, result.projects);
      await this.repos.posture.replaceForFile(result.file, result.posture || []);
      snapshotWritten = true;

      const changed = await this.repos.projectVersions.appendChanged(
        result.projects.map((project) => ({ project, hash: hashProject(project) })),
        { ingestRunId: runId }
      );

      this.lastIngestAt = new Date().toISOString();
      await this.refresh();

      await this.repos.ingestRuns.finish(runId, {
        outcome: "applied",
        projectsSeen: result.projects.length,
        projectsChanged: changed,
        postureRows: (result.posture || []).length,
        sourceFileId: recorded.sourceFileId,
      });

      this.log({
        file: result.file, ok: true,
        projects: result.projects.length, changed,
        postureDomains: (result.posture || []).length,
      });
      return result.projects.length;
    } catch (err) {
      const reason = snapshotWritten
        ? `snapshot applied but history not recorded: ${err.message}`
        : err.message;
      await this.repos.ingestRuns.finish(runId, { outcome: "failed", error: reason });
      this.log({ file: result.file, ok: false, error: reason });
      throw err;
    }
  }

  /** Forget a workbook that was deleted from the drop folder. */
  async removeFile(sourceFile) {
    const runId = this.tracksHistory
      ? await this.repos.ingestRuns.start({ fileName: sourceFile, trigger: "watcher" })
      : null;

    const removed = await this.repos.projects.removeFile(sourceFile);
    await this.repos.posture.removeFile(sourceFile);
    this.lastIngestAt = new Date().toISOString();
    await this.refresh();

    if (runId !== null) {
      await this.repos.ingestRuns.finish(runId, { outcome: "removed", projectsSeen: removed });
    }
    this.log({ file: sourceFile, ok: true, removed });
    return removed;
  }
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/db/sqlStoreHistory.test.js`
Expected: PASS — 5 tests.

- [ ] **Step 5: Give the ingester the bytes it now needs**

`applyFile` vaults `result.bytes`, and `ingestFile` does not return them.
Replace `ingestFile` at `server/ingest.js:463-471` with:

```js
export function ingestFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const mtime = dayjs(fs.statSync(filePath).mtime).format("YYYY-MM-DD");
    const parsed = ingestBuffer(buffer, filePath, mtime);
    /* The vault needs the original bytes, and only the caller that already
       read them can supply them without reading the file a second time. */
    return parsed.ok ? { ...parsed, bytes: buffer } : parsed;
  } catch (err) {
    return { ok: false, file: path.basename(filePath), error: err.message };
  }
}
```

- [ ] **Step 6: Construct the new repositories in `server/index.js`**

Add the imports beside the existing repository imports:

```js
import { sourceFilesRepo } from "./repos/sourceFiles.js";
import { ingestRunsRepo } from "./repos/ingestRuns.js";
import { projectVersionsRepo } from "./repos/projectVersions.js";
import { createVault } from "./vault.js";
```

In the `config.store === "mssql"` branch (`server/index.js:55-63`), extend the
`repos` object and replace the store construction. Current:

```js
  const repos = {
    projects: projectsRepo(ex),
    posture: postureRepo(ex),
    audit: auditRepo(ex),
    sessions: sessionsRepo(ex),
    roleMapping: roleMappingRepo(ex),
  };

  store = new SqlStore({ projects: repos.projects, posture: repos.posture });
```

Becomes:

```js
  const repos = {
    projects: projectsRepo(ex),
    posture: postureRepo(ex),
    audit: auditRepo(ex),
    sessions: sessionsRepo(ex),
    roleMapping: roleMappingRepo(ex),
    sourceFiles: sourceFilesRepo(ex),
    ingestRuns: ingestRunsRepo(ex),
    projectVersions: projectVersionsRepo(ex),
  };

  store = new SqlStore({
    projects: repos.projects,
    posture: repos.posture,
    sourceFiles: repos.sourceFiles,
    ingestRuns: repos.ingestRuns,
    projectVersions: repos.projectVersions,
  }, { vault: createVault(path.join(ROOT, config.vaultDir)) });
```

- [ ] **Step 7: Name the trigger at both call sites**

`server/index.js` calls `applyFile` twice. The boot sweep, in `apply()` at
`server/index.js:106`:

```js
    return store.applyFile(result, { trigger: "boot" });
```

and the watcher's `onUpsert`, at `server/index.js:155`:

```js
      await store.applyFile(parsed, { trigger: "watcher" });
```

The upload route in `server/app.js` writes into `dataDir` and lets the watcher
ingest it, so it needs no change: the upload is already audited with the
actor's name, and the run that follows is recorded by the watcher.

- [ ] **Step 8: Run everything**

Run: `npm test`
Expected: PASS, including the existing `test/db/projects.test.js`, which
constructs `SqlStore` with only the two Phase 0 repositories and must still work.

- [ ] **Step 9: Commit**

```bash
git add server/store/sqlStore.js server/index.js server/ingest.js test/db/sqlStoreHistory.test.js
git commit -m "feat(ingest): vault every workbook and record what each ingest changed"
```

**Amended after the Task 4 review.** The run is now opened FIRST, before the
bytes are vaulted and before the source file is recorded, and the source file id
is attached when the run closes. (Superseded in part by the amendment below —
`newestHashFor` is no longer what decides "unchanged".) Originally `vault.store()` and
`sourceFiles.record()` both ran before `ingestRuns.start()`, so a failure in
either produced no run at all — and "either there is no run, or there is a run
with a reason" stopped being true for the one failure mode that happens first.
`newestHashFor` is still read before `record()`, or the file would be compared
against itself and every ingest would look unchanged.

**Amended again after the Task 6 review — two Critical defects in this plan.**

Deciding "unchanged" from `sourceFiles.newestHashFor` was wrong, and wrong in a
way that could hide a portfolio permanently. `record()` writes the `SourceFile`
row before the snapshot write and outside its transaction, so the hash becomes
durable whether or not the write that follows succeeds. Four reachable
consequences, none of which a restart recovers, because the boot sweep runs
through the same code:

- A first ingest that fails between `record()` and `replaceForFile` leaves that
  file's portfolio permanently invisible — every later drop of the identical
  file is short-circuited as "unchanged".
- A re-ingest that fails the same way rolls the snapshot back cleanly, so the
  OLD rows survive and the dashboard is stuck on stale data — and resending the
  corrected file is swallowed as "unchanged".
- `dbo.Project` emptied by a restore or a manual DELETE cannot be repopulated by
  re-dropping the same workbook.
- `removeFile` deletes the project rows but leaves the `SourceFile` row, so an
  operator who removes a workbook and puts it straight back gets nothing.

The root cause is using "these bytes have been seen" as an oracle for "this
content is what is currently live". The fix is to ask the second question
directly: `ingestRuns.liveHashFor(fileName)` returns the hash of the file whose
most recently CLOSED run for that name closed `applied` or `unchanged`, and null
otherwise. A `failed` run proves nothing was applied; a `removed` run proves it
was taken away; both must let the next ingest do the work even for identical
bytes. `Outcome IS NOT NULL` excludes the run just opened, which is what makes
this work at all. `sourceFiles.newestHashFor` is deleted — a method whose name
invites exactly this bug is worse than no method. `record()` stays: it is the
vault ledger, and recording bytes we vaulted is correct unconditionally.

The `snapshotWritten` flag was also wrong in two of its three cases. It is set
before `appendChanged` runs, so "snapshot applied but history not recorded" is
only true for a failure inside `appendChanged`; a failure in `refresh()` or in
the closing `finish()` happens after both are committed. Worse, if the closing
`finish()` threw after its UPDATE committed, the catch overwrote a correct
`applied` row with `failed`. Replaced by a `stage` marker — `opening`,
`snapshot`, `history`, `closed` — with a distinct message for each, and a
`closed` stage that refuses to touch the run at all, because at that point only
the in-memory read model is stale.

---

### Task 7: Make the runs visible

A history nobody can see is a table nobody trusts.

**Files:**
- Modify: `server/app.js`
- Test: `test/api/app.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/api/app.test.js`:

```js
test("an admin can see recent ingest runs, and a pm cannot", async () => {
  const runs = [{
    id: 1, fileName: "master.xlsx", trigger: "watcher",
    startedAt: "2026-08-25T09:00:00.000Z", finishedAt: "2026-08-25T09:00:02.000Z",
    outcome: "applied", projectsSeen: 34, projectsChanged: 3, postureRows: 10, error: null,
  }];
  const ingestRuns = { recent: async () => runs };

  const pmApp = makeAppWith({ role: "pm", auditBackend: { append: async () => {}, recent: async () => [] } });
  const pm = await signedIn(pmApp);
  assert.equal((await pm.get("/api/ingest/runs")).status, 403);

  const adminApp = makeAppWith({
    role: "admin",
    auditBackend: { append: async () => {}, recent: async () => [] },
    ingestRuns,
  });
  const admin = await signedIn(adminApp);
  const res = await admin.get("/api/ingest/runs");
  assert.equal(res.status, 200);
  assert.equal(res.body.runs[0].outcome, "applied");
  assert.equal(res.body.runs[0].projectsChanged, 3);
});

test("ingest runs report cleanly when the store keeps no history", async () => {
  const adminApp = makeAppWith({ role: "admin", auditBackend: { append: async () => {}, recent: async () => [] } });
  const admin = await signedIn(adminApp);
  const res = await admin.get("/api/ingest/runs");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.runs, []);
  assert.equal(res.body.historyEnabled, false);
});
```

and extend the `makeAppWith` helper at `test/api/app.test.js:176-189` — only the
signature and one property change:

```js
/** Like makeApp, but with a caller-supplied audit backend. */
function makeAppWith({ role, auditBackend, ingestRuns = null }) {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  return createApp({
    store,
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ [`gcio-dashboard-${role}s`]: role }),
    audit: auditBackend,
    ingestRuns,
    ldapAuthenticate: devAuthenticate(role),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/api/app.test.js`
Expected: FAIL — `/api/ingest/runs` is 404 for both roles.

- [ ] **Step 3: Add the route in `server/app.js`**

Take the dependency at the top of `createApp`, beside `audit`:

```js
  const ingestRuns = deps.ingestRuns || null;
```

and add the route immediately after `/api/audit`:

```js
  /**
   * The last ingests and what each one did. This is the answer to "why does
   * the dashboard not show last night's file": either there is no run, or
   * there is one with an outcome and a reason.
   */
  app.get("/api/ingest/runs", requireRole("admin"), wrap(async (req, res) => {
    if (!ingestRuns) return res.json({ historyEnabled: false, count: 0, runs: [] });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const runs = await ingestRuns.recent({ limit });
    res.json({ historyEnabled: true, count: runs.length, runs });
  }));
```

- [ ] **Step 4: Pass it in from `server/index.js`**

Both branches set `backends`, so both must name the key or the `createApp` call
reads `undefined` from the in-memory one. In the mssql branch
(`server/index.js:78`):

```js
  backends = {
    audit: repos.audit,
    sessions: repos.sessions,
    roleMapping: repos.roleMapping,
    ingestRuns: repos.ingestRuns,
  };
```

and in the in-memory branch (`server/index.js:81-93`), add to the object
literal:

```js
    /* No database, so no run history to show. The route says so rather than
       pretending the list is empty. */
    ingestRuns: null,
```

Then in the `createApp({ ... })` call at `server/index.js:190`, beside `audit`:

```js
  ingestRuns: backends.ingestRuns,
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/api/app.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/app.js server/index.js test/api/app.test.js
git commit -m "feat(api): expose recent ingest runs to administrators"
```

---

### Task 8: Prove the whole thing against real SQL

The hermetic suite fakes every repository and the vault. That proves ordering
and branching; it cannot prove anything about SQL Server, about transaction
boundaries between repositories, or about a SEQUENCE of ingests sharing state.
The Task 6 review found two Critical defects that no amount of faking could
catch, precisely because the fakes do not share a database the way `SourceFile`
and `Project` do. So the live subtests below are not a formality — they are the
only place several of these behaviours are ever exercised for real.

**The scenarios this task must prove, beyond the happy path:**

1. **A failed ingest does not hide the file forever.** Ingest a new workbook,
   force `projects.replaceForFile` to fail, then drop the identical bytes again
   and assert the portfolio DOES appear. Repeat with a fresh `SqlStore` between
   the two attempts, since a restart was the obvious escape hatch and is not one.
2. **Remove then re-drop.** Ingest, remove the file, drop the byte-identical
   file back in, and assert it is applied rather than reported unchanged.
3. **A failed update does not freeze stale data.** Ingest v1 successfully, then
   attempt v2 of the same name with a failing snapshot write. Confirm v1's rows
   survive the rollback, then confirm v2 CAN still be applied by re-dropping it.
4. **A misleading outcome is not recorded.** Force `refresh()` to fail after a
   genuinely successful apply and confirm the run still reads `applied`, with
   `dbo.Project` and `dbo.ProjectVersion` holding correct data.
5. **`liveHashFor` under two versions of one name.** Ingest v1, then v2, and
   confirm the answer tracks the most recently settled run rather than whichever
   `SourceFile` row was touched last.
6. **A cold process.** Everything above with a freshly constructed store, not
   the same in-memory instance — `store.sourceFiles` is only populated by
   `refresh()`, and this is the first place that boundary is real.

**Files:**
- Modify: `test/db/live.test.js`

- [ ] **Step 1: Add the live subtests**

Inside the existing `test("the SQL path works end to end against a real instance", ...)`
block, after the "removing a workbook removes its rows" subtest, add:

```js
  await t.test("history records a version once, and not again for an unchanged file", async () => {
    const { sourceFilesRepo } = await import("../../server/repos/sourceFiles.js");
    const { ingestRunsRepo } = await import("../../server/repos/ingestRuns.js");
    const { projectVersionsRepo } = await import("../../server/repos/projectVersions.js");
    const { createVault } = await import("../../server/vault.js");
    const { SqlStore } = await import("../../server/store/sqlStore.js");
    const fs = await import("node:fs");
    const os = await import("node:os");
    const pathMod = await import("node:path");

    const vaultDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "gcio-live-vault-"));
    const repos = {
      projects: projectsRepo(ex),
      posture: postureRepo(ex),
      sourceFiles: sourceFilesRepo(ex),
      ingestRuns: ingestRunsRepo(ex),
      projectVersions: projectVersionsRepo(ex),
    };
    const store = new SqlStore(repos, { vault: createVault(vaultDir), logger: quiet });

    const parsed = ingestFile("sample-data/GCIO_Portfolio_Master.xlsx");
    parsed.file = FILE;

    await store.applyFile(parsed, { trigger: "replay" });
    const firstVersions = await ex.query(
      "SELECT COUNT(*) AS n FROM dbo.ProjectVersion WHERE ProjectId IN (SELECT ProjectId FROM dbo.Project WHERE SourceFile = @f)",
      [{ name: "f", type: sql.NVarChar(260), value: FILE }]);
    assert.ok(firstVersions.recordset[0].n > 0, "no history was recorded");

    /* The identical file again: same bytes, so this must be a no-op. */
    await store.applyFile(parsed, { trigger: "replay" });
    const secondVersions = await ex.query(
      "SELECT COUNT(*) AS n FROM dbo.ProjectVersion WHERE ProjectId IN (SELECT ProjectId FROM dbo.Project WHERE SourceFile = @f)",
      [{ name: "f", type: sql.NVarChar(260), value: FILE }]);
    assert.equal(secondVersions.recordset[0].n, firstVersions.recordset[0].n,
      "re-ingesting an unchanged workbook manufactured history");

    const runs = await repos.ingestRuns.recent({ limit: 5 });
    assert.equal(runs[0].outcome, "unchanged", "the second run should have been recognised as unchanged");
    assert.equal(runs[1].outcome, "applied");

    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  await t.test("a changed project appends exactly one new version", async () => {
    const { projectVersionsRepo } = await import("../../server/repos/projectVersions.js");
    const { hashProject } = await import("../../server/ingest/hash.js");
    const versions = projectVersionsRepo(ex);

    const parsed = ingestFile("sample-data/GCIO_Portfolio_Master.xlsx");
    const subject = { ...parsed.projects[0], id: "PRJ-HIST-TEST" };

    const before = await versions.historyFor(subject.id);
    await versions.appendChanged([{ project: subject, hash: hashProject(subject) }], { ingestRunId: null });
    await versions.appendChanged([{ project: subject, hash: hashProject(subject) }], { ingestRunId: null });

    const afterSame = await versions.historyFor(subject.id);
    assert.equal(afterSame.length, before.length + 1, "an unchanged project was versioned twice");

    const changed = { ...subject, health: subject.health === "Red" ? "Green" : "Red" };
    await versions.appendChanged([{ project: changed, hash: hashProject(changed) }], { ingestRunId: null });

    const afterChange = await versions.historyFor(subject.id);
    assert.equal(afterChange.length, before.length + 2);
    assert.equal(afterChange[0].health, changed.health, "history is not newest-first");

    await ex.query("DELETE FROM dbo.ProjectVersion WHERE ProjectId = @id",
      [{ name: "id", type: sql.NVarChar(60), value: "PRJ-HIST-TEST" }]);
  });
```

- [ ] **Step 2: Teach the table-coverage subtest about the new tables**

The "every table the application needs exists" subtest filters by an explicit
`IN` list, so it would pass without ever looking at the new tables. In
`test/db/live.test.js:71-82`, add them to both the query and the expectation:

```js
    const { recordset } = await ex.query(`
      SELECT name FROM sys.tables
      WHERE name IN ('Project','ProjectChild','PostureDomain','Sessions','RoleMapping',
                     'AuditEvent','SchemaMigration','SourceFile','IngestRun','ProjectVersion')
    `);
    const expected = [
      "AuditEvent", "IngestRun", "PostureDomain", "Project", "ProjectChild", "ProjectVersion",
      "RoleMapping", "SchemaMigration", "Sessions", "SourceFile",
    ].sort();
```

Tables alone are not enough. An index silently dropped or renamed by a later
migration turns a seek into a scan with nothing failing, and a constraint
dropped by hand stops protecting anything. Add a second subtest beside it:

```js
  await t.test("the history tables keep the indexes and constraints they were given", async () => {
    const { recordset: indexes } = await ex.query(`
      SELECT name FROM sys.indexes
      WHERE name IN ('UX_SourceFile_Name_Sha','IX_IngestRun_StartedAt',
                     'IX_ProjectVersion_Project','IX_ProjectVersion_RecordedAt')
    `);
    assert.deepEqual(indexes.map((r) => r.name).sort(), [
      "IX_IngestRun_StartedAt", "IX_ProjectVersion_Project",
      "IX_ProjectVersion_RecordedAt", "UX_SourceFile_Name_Sha",
    ]);

    /* The hot path selects ContentHash for every changed project on every
       ingest; without the include it pays a key lookup per row. */
    const { recordset: included } = await ex.query(`
      SELECT c.name FROM sys.index_columns ic
      JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.name = 'IX_ProjectVersion_Project' AND ic.is_included_column = 1
    `);
    assert.deepEqual(included.map((r) => r.name), ["ContentHash"]);

    const { recordset: keys } = await ex.query(`
      SELECT name FROM sys.foreign_keys
      WHERE name IN ('FK_IngestRun_SourceFile','FK_ProjectVersion_IngestRun') AND is_disabled = 0
    `);
    assert.equal(keys.length, 2, "a foreign key on the history tables is missing or disabled");

    const { recordset: checks } = await ex.query(`
      SELECT name FROM sys.check_constraints
      WHERE name IN ('CK_IngestRun_TriggerSource','CK_IngestRun_Outcome')
        AND is_disabled = 0 AND is_not_trusted = 0
    `);
    assert.equal(checks.length, 2, "a check constraint on dbo.IngestRun is missing or untrusted");
  });
```

- [ ] **Step 3: Extend the cleanup so the suite leaves nothing behind**

In the `cleanup` helper in the same file, add:

```js
  await ex.query(`
    IF OBJECT_ID('dbo.ProjectVersion','U') IS NOT NULL
      DELETE FROM dbo.ProjectVersion WHERE ProjectId = 'PRJ-HIST-TEST'
         OR IngestRunId IN (SELECT IngestRunId FROM dbo.IngestRun WHERE FileName = @f)`,
    [{ name: "f", type: sql.NVarChar(260), value: FILE }]);
  await ex.query("IF OBJECT_ID('dbo.IngestRun','U') IS NOT NULL DELETE FROM dbo.IngestRun WHERE FileName = @f",
    [{ name: "f", type: sql.NVarChar(260), value: FILE }]);
  await ex.query("IF OBJECT_ID('dbo.SourceFile','U') IS NOT NULL DELETE FROM dbo.SourceFile WHERE FileName = @f",
    [{ name: "f", type: sql.NVarChar(260), value: FILE }]);
```

- [ ] **Step 4: Run it**

Run: `DB_LIVE=1 npm run test:db`
Expected: PASS — 11 subtests.

- [ ] **Step 5: Verify by hand, because this is the phase's whole point**

```bash
STORE=mssql AUTH_MODE=dev DEV_ROLE=admin npm start
```

Copy a workbook into `data/`, wait for the ingest line, then copy the **same**
file again and check:

```bash
sqlcmd -S "localhost\SQLEXPRESS" -E -C -W -d GCIO -Q "SELECT TOP 5 FileName, TriggerSource, Outcome, ProjectsSeen, ProjectsChanged FROM dbo.IngestRun ORDER BY StartedAt DESC"
```

Expected: the first run `applied` with a non-zero `ProjectsChanged`, the second
`unchanged` with `ProjectsChanged` of 0. And the vault holds exactly one copy:

```bash
find vault -type f | wc -l
```

Expected: `1`.

- [ ] **Step 6: Commit**

```bash
git add test/db/live.test.js
git commit -m "test(db): live coverage of the history foundation"
```

---

### Task 9: Close out the phase

**Files:**
- Modify: `docs/superpowers/specs/2026-08-24-backend-production-design.md`
- Modify: `README.md`

- [ ] **Step 1: Run everything**

```bash
npm test
DB_LIVE=1 npm run test:db
npm run build
```

Expected: all green.

- [ ] **Step 2: Confirm the vault is documented**

The README paragraph this step originally carried was brought forward to Task 2,
so that `vault/` was documented from the moment it started holding real data
rather than at the end of the phase. Confirm it is present and still accurate —
`grep -n VAULT_DIR README.md` — and correct it if the implementation drifted.

- [ ] **Step 3: Mark the phase in the spec**

Two edits. The status line at the top (`:4`) becomes:

```markdown
**Status:** Phase 1 delivered, tagged `v1.2.0-p1`. The SQL Server path is now
```

and the P1 row of the rollout table (`:233`), which still describes the
abandoned Postgres plan, is replaced with what was actually built:

```markdown
| **P1 — history foundation** | SourceFile, IngestRun, ProjectVersion, content-hash idempotency, the file vault; `STORE=memory` retained | **Met.** Re-ingesting an unchanged workbook records `unchanged` and manufactures no history; a changed project appends exactly one version; the in-memory store is untouched |
```

Note beneath the table that the store is SQL Server, not Postgres — the row was
written before the DEDB stack decision and the wording outlived it.

- [ ] **Step 4: Commit and tag**

```bash
git add docs/superpowers/specs/2026-08-24-backend-production-design.md README.md
git commit -m "docs: Phase 1 delivered — the dashboard now has a memory"
git tag -a v1.2.0-p1 -m "Phase 1: history foundation — source files, ingest runs, project versions, file vault"
git push origin main --tags
```

---

## Self-review against the spec

| Spec requirement | Where |
| --- | --- |
| `source_file` — every workbook by hash, with vault path | Task 3 (schema), Task 4 (repository) |
| `ingest_run` — one per file event with counts and outcome | Task 3, Task 4, visible in Task 7 |
| `project_version` — a row only when content changes | Task 3, Task 5, proven live in Task 8 |
| Hash the file; skip re-parsing when unchanged | Task 1, Task 6 |
| Copy to the vault **before** parsing | Task 2, Task 6 (test asserts the ordering) |
| Malformed rows rejected individually, never aborting the file | unchanged from Phase 0; Task 6 records the failure as a run |
| Deletion closes rather than hard-deletes | Task 6 — removal is recorded as a run; `ProjectVersion` is append-only, so history survives |
| `STORE=memory` keeps working | Task 6, guarded by "history is optional" and by the untouched Phase 0 tests |

**Deviation from the spec, deliberate:** the spec replaced `dbo.Project` with a
`valid_from`/`valid_to` temporal table and derived current state from it. This
plan keeps `Project` as the current snapshot and adds history beside it, for the
reasons in the header. `question_asked` ageing is **not** in this phase — it is a
Phase 2 feature and belongs with the other things history makes possible.

**Not in this phase:** trends, "changed since last week", question ageing,
`/metrics`, the ingest/web role split, worker-thread parsing, backup drills.
