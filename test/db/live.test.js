/**
 * The SQL Server path, against a real instance.
 *
 * Everything else in the data layer is tested against a fake pool, which proves
 * the shapes and the failure semantics but not that the schema applies, that
 * migrations run in order, or that an ingest actually persists. This is the
 * test that proves those.
 *
 * It skips itself unless DB_LIVE=1, so the default suite stays hermetic:
 *
 *     DB_LIVE=1 npm run test:db
 */
import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import sql from "mssql";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildConfig } from "../../server/db/pool.js";
import { makeExecutor } from "../../server/db/executor.js";
import { migrate, MIGRATIONS } from "../../server/db/migrations.js";
import { projectsRepo } from "../../server/repos/projects.js";
import { postureRepo } from "../../server/repos/posture.js";
import { auditRepo } from "../../server/repos/audit.js";
import { sessionsRepo, computeExpiry } from "../../server/repos/sessions.js";
import { roleMappingRepo } from "../../server/repos/roleMapping.js";
import { sourceFilesRepo } from "../../server/repos/sourceFiles.js";
import { ingestRunsRepo } from "../../server/repos/ingestRuns.js";
import { projectVersionsRepo } from "../../server/repos/projectVersions.js";
import { documentExtractsRepo } from "../../server/repos/documentExtracts.js";
import { createVault } from "../../server/vault.js";
import { hashBytes, hashProject } from "../../server/ingest/hash.js";
import { SqlStore } from "../../server/store/sqlStore.js";
import { buildSummary } from "../../server/summarize.js";
import { ingestFile } from "../../server/ingest.js";

const live = process.env.DB_LIVE === "1";
const FILE = "livetest.xlsx";
/* Every filename this suite ever ingests starts with this prefix, so cleanup
   can sweep all of them -- including the per-scenario names Task 8 adds below
   -- with one LIKE rather than an ever-growing list of exact values. */
const FILE_PREFIX = "livetest";
/* Every ProjectId this suite ever writes starts with this prefix, for the same
   reason FILE_PREFIX exists: cleanup() sweeps them with one LIKE that no real
   project id can match. The markers this replaced -- 'P2-%', 'TIMING-%',
   'S[1-6V]-%' -- were shapes a real portfolio could plausibly use, so a stray
   DB_LIVE=1 against a populated database would have deleted real history.
   Upper case because projectVersions.appendChanged() normalises every
   ProjectId with .toUpperCase() before inserting it. Lower case would still
   sweep correctly -- the collation is case-insensitive -- but the ids read
   back would not equal the ids the tests hold, and assertions of the form
   !changes.has(id) would pass on a lookup miss rather than on the behaviour
   they mean to check. */
const ID_PREFIX = "LIVETEST-";
/** The one project whose history this suite writes by hand, not via ingest. */
const HIST_ID = `${ID_PREFIX}HIST`;
const quiet = { info() {}, error() {}, warn() {} };

/**
 * Everything this suite writes is tagged so cleanup cannot touch real rows.
 *
 * Child-first, because migration 8 added real foreign keys: ProjectVersion
 * references IngestRun, and IngestRun references SourceFile. Deleting a
 * SourceFile (or an IngestRun) before the rows that point at it now fails
 * with a foreign key violation instead of quietly doing nothing.
 */
async function cleanup(ex) {
  const pattern = { name: "pattern", type: sql.NVarChar(260), value: `${FILE_PREFIX}%` };
  const idPattern = { name: "idPattern", type: sql.NVarChar(60), value: `${ID_PREFIX}%` };

  await ex.query(`
    IF OBJECT_ID('dbo.ProjectVersion','U') IS NOT NULL
      DELETE FROM dbo.ProjectVersion WHERE ProjectId LIKE @idPattern
         OR IngestRunId IN (SELECT IngestRunId FROM dbo.IngestRun WHERE FileName LIKE @pattern)`,
    [pattern, idPattern]);
  await ex.query(
    "IF OBJECT_ID('dbo.IngestRun','U') IS NOT NULL DELETE FROM dbo.IngestRun WHERE FileName LIKE @pattern",
    [pattern]);
  /* Before SourceFile, not after: dbo.DocumentExtract carries a foreign key to
     it, so deleting the parent first fails on the constraint and takes the
     whole cleanup -- and therefore every later scenario -- down with it. */
  await ex.query(`
    IF OBJECT_ID('dbo.DocumentExtract','U') IS NOT NULL
      DELETE FROM dbo.DocumentExtract
       WHERE SourceFileId IN (SELECT SourceFileId FROM dbo.SourceFile WHERE FileName LIKE @pattern)`,
    [pattern]);
  await ex.query(
    "IF OBJECT_ID('dbo.SourceFile','U') IS NOT NULL DELETE FROM dbo.SourceFile WHERE FileName LIKE @pattern",
    [pattern]);

  for (const table of ["ProjectChild", "Project", "PostureDomain"]) {
    await ex.query(
      `IF OBJECT_ID('dbo.${table}','U') IS NOT NULL DELETE FROM dbo.${table} WHERE SourceFile LIKE @pattern`,
      [pattern]
    );
  }
  await ex.query("IF OBJECT_ID('dbo.AuditEvent','U') IS NOT NULL DELETE FROM dbo.AuditEvent WHERE Actor = @a",
    [{ name: "a", type: sql.NVarChar(320), value: "livetest@example" }]);
  await ex.query("IF OBJECT_ID('dbo.Sessions','U') IS NOT NULL DELETE FROM dbo.Sessions WHERE Principal = @p",
    [{ name: "p", type: sql.NVarChar(200), value: "livetest@example" }]);
  await ex.query("IF OBJECT_ID('dbo.RoleMapping','U') IS NOT NULL DELETE FROM dbo.RoleMapping WHERE GroupName = @g",
    [{ name: "g", type: sql.NVarChar(300), value: "livetest-group" }]);
}

/**
 * A repos bundle wired for history, built fresh so one scenario's monkey-patch
 * of e.g. replaceForFile can never leak into another scenario.
 */
function scenarioRepos(ex) {
  return {
    projects: projectsRepo(ex),
    posture: postureRepo(ex),
    sourceFiles: sourceFilesRepo(ex),
    ingestRuns: ingestRunsRepo(ex),
    projectVersions: projectVersionsRepo(ex),
  };
}

/**
 * A trimmed, real parse of the sample workbook, with every project id
 * namespaced to one scenario tag. dbo.Project's primary key is ProjectId
 * ALONE -- not (ProjectId, SourceFile) -- so two scenarios ingesting the same
 * real workbook under different pretend filenames would otherwise collide on
 * the same ids. A real ingest never does this (a workbook keeps its ids
 * across drops); only this test's design of "one fixture, many pretend
 * filenames" does. Trimmed to a handful of projects so a dozen scenarios like
 * this do not spend the run on redundant row-by-row inserts.
 */
function scenarioParsed(fileName, tag, { count = 5 } = {}) {
  const base = ingestFile("sample-data/GCIO_Portfolio_Master.xlsx");
  assert.equal(base.ok, true, base.error);
  return {
    ok: true,
    file: fileName,
    projects: base.projects.slice(0, count).map((p) => ({ ...p, id: `${ID_PREFIX}${tag}-${p.id}` })),
    posture: base.posture,
    bytes: base.bytes,
  };
}

/**
 * The whole sample workbook, namespaced, for the subtests that persist it
 * under FILE rather than under a per-scenario pretend name.
 *
 * They used to write the workbook's own ids. That was safe only while the
 * target database held nothing else: dbo.Project's key is ProjectId alone, so
 * the fixture's PRJ-1001 collides with a real PRJ-1001 the moment anyone
 * ingests an actual portfolio into the shared development instance -- which
 * is exactly what happened. Namespacing here is the same guard scenarioParsed
 * applies between scenarios, turned outward at the rest of the database.
 */
function fixtureParsed(fileName) {
  return scenarioParsed(fileName, "MAIN", { count: Infinity });
}

/**
 * How many projects one SourceFile has in SQL.
 *
 * The only project count this suite may assert on. SqlStore.refresh() loads
 * every row in dbo.Project, so store.projectCount includes rows this suite
 * did not write and cannot predict; scoping to the file under test makes the
 * assertion about this suite's own work again.
 */
async function countForFile(ex, fileName) {
  const { recordset } = await ex.query(
    "SELECT COUNT(*) AS n FROM dbo.Project WHERE SourceFile = @f",
    [{ name: "f", type: sql.NVarChar(260), value: fileName }]);
  return recordset[0].n;
}

/** A vault directory scoped to one scenario, in the OS temp dir. */
function scenarioVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcio-live-vault-"));
  return { dir, vault: createVault(dir, { logger: quiet }) };
}

/**
 * Every run recorded for one filename, newest first. A raw query rather than
 * repos.ingestRuns.recent(), so a scenario running late in a long suite is
 * not at the mercy of some earlier scenario's rows pushing it past a fixed
 * limit.
 */
async function runsFor(ex, fileName) {
  const { recordset } = await ex.query(`
    SELECT Outcome, Error, ProjectsSeen, ProjectsChanged, FinishedAt
    FROM dbo.IngestRun WHERE FileName = @f ORDER BY StartedAt DESC, IngestRunId DESC
  `, [{ name: "f", type: sql.NVarChar(260), value: fileName }]);
  return recordset;
}

/** How many dbo.Project rows currently belong to one filename. */
async function projectCountFor(ex, fileName) {
  const { recordset } = await ex.query(
    "SELECT COUNT(*) AS n FROM dbo.Project WHERE SourceFile = @f",
    [{ name: "f", type: sql.NVarChar(260), value: fileName }]
  );
  return recordset[0].n;
}

/**
 * Make repo[method] throw once, with `message`, then delegate to the real
 * implementation for every call after. Mutates repo in place -- callers use
 * a fresh scenarioRepos(ex) each time, so this can never leak between
 * scenarios.
 */
function failOnce(repo, method, message) {
  const original = repo[method].bind(repo);
  let failed = false;
  repo[method] = async (...args) => {
    if (!failed) { failed = true; throw new Error(message); }
    return original(...args);
  };
}

test("the SQL path works end to end against a real instance", { skip: !live }, async (t) => {
  const pool = await new sql.ConnectionPool(buildConfig(process.env)).connect();
  const ex = makeExecutor(pool, { logger: quiet });
  t.after(async () => {
    await cleanup(ex);
    await pool.close();
  });

  /* This suite migrates and deletes. Say where, so a stray DB_LIVE=1 in the
     wrong shell is visible in the output rather than discovered afterwards.
     A name allow-list would not help -- the development database is called
     GCIO and so would production be -- so refuse outright on NODE_ENV first,
     then announce the target regardless of what it turns out to be. */
  assert.notEqual(process.env.NODE_ENV, "production",
    "refusing to run the destructive live suite with NODE_ENV=production");
  const target = await ex.query("SELECT @@SERVERNAME AS server, DB_NAME() AS db");
  console.log(`[live] running against ${target.recordset[0].server} / ${target.recordset[0].db}`);

  await cleanup(ex);

  await t.test("migrations apply, and re-applying them is a no-op", async () => {
    const first = await migrate(ex, { logger: quiet });
    assert.ok(Array.isArray(first.applied));

    const second = await migrate(ex, { logger: quiet });
    assert.deepEqual(second.applied, [], "migrations ran twice");
    assert.equal(second.alreadyCurrent, true);

    const { recordset } = await ex.query("SELECT Id FROM dbo.SchemaMigration ORDER BY Id");
    assert.deepEqual(recordset.map((r) => r.Id), MIGRATIONS.map((m) => m.id));
  });

  await t.test("every table the application needs exists", async () => {
    const { recordset } = await ex.query(`
      SELECT name FROM sys.tables
      WHERE name IN ('Project','ProjectChild','PostureDomain','Sessions','RoleMapping',
                     'AuditEvent','SchemaMigration','SourceFile','IngestRun','ProjectVersion')
    `);
    /* Sort both sides: hand-ordering the expectation is how this failed the
       first time, on SchemaMigration vs Sessions rather than on anything real. */
    const expected = [
      "AuditEvent", "IngestRun", "PostureDomain", "Project", "ProjectChild", "ProjectVersion",
      "RoleMapping", "SchemaMigration", "Sessions", "SourceFile",
    ].sort();
    assert.deepEqual(recordset.map((r) => r.name).sort(), expected);
  });

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

    /* appendChanged's hot path selects ContentHash for every changed project on
       every ingest, and changedSince (migration 9) selects the other eight
       columns for every project on every request; without the includes each
       pays a key lookup per row. Ordered by index_column_id so this pins the
       declared INCLUDE order in migration 9, not just set membership. */
    const { recordset: included } = await ex.query(`
      SELECT c.name FROM sys.index_columns ic
      JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.name = 'IX_ProjectVersion_Project' AND ic.is_included_column = 1
      ORDER BY ic.index_column_id
    `);
    assert.deepEqual(included.map((r) => r.name), [
      "ContentHash", "Status", "Health", "PercentComplete", "Budget", "Spent",
      "OpenRisks", "OpenQuestions", "TargetEndDate",
    ]);

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

  await t.test("a real workbook persists and reads back through the store", async () => {
    const parsed = fixtureParsed(FILE);

    const repos = { projects: projectsRepo(ex), posture: postureRepo(ex) };
    await repos.projects.replaceForFile(FILE, parsed.projects);
    await repos.posture.replaceForFile(FILE, parsed.posture || []);

    const store = new SqlStore(repos, { logger: quiet });
    await store.refresh();

    assert.equal(await countForFile(ex, FILE), parsed.projects.length,
      "not every project in the workbook reached SQL");
    const first = parsed.projects[0];
    const roundTripped = store.get(first.id);
    assert.ok(roundTripped, `${first.id} did not come back from SQL`);
    assert.equal(roundTripped.name, first.name);
    assert.equal(roundTripped.budget, first.budget);
    assert.equal(roundTripped.targetEndDate, first.targetEndDate);

    /* Children are the part most likely to be lost in translation. */
    const withRisks = parsed.projects.find((p) => p.risks.length > 0);
    if (withRisks) {
      assert.equal(store.get(withRisks.id).risks.length, withRisks.risks.length);
    }
  });

  await t.test("the section engine runs over SQL data unchanged", async () => {
    const store = new SqlStore({ projects: projectsRepo(ex), posture: postureRepo(ex) }, { logger: quiet });
    await store.refresh();

    const summary = buildSummary(store, "weekly", "2026-08-25");
    /* The six sections the CIO asked for, in order. Not an exact key list:
       annotateChanges also records historyAvailable here, and pinning the whole
       shape means every future addition breaks a test about section order. */
    const sectionKeys = Object.keys(summary.sections);
    assert.deepEqual(sectionKeys.filter((k) => k !== "historyAvailable"),
      ["successes", "qri", "priorities", "roadmap", "posture", "documents"]);
    assert.equal(typeof summary.sections.historyAvailable, "boolean",
      "the summary must always say whether history was available");
    assert.ok(summary.sections.priorities.items.length > 0, "no priorities came back from SQL");
    assert.equal(summary.sections.posture.available, true, "the Posture sheet did not survive the round trip");
    assert.ok(summary.sections.posture.domains.length > 0);

    /* historyStartedAt is produced by buildSummary itself now, not attached
       at the route -- this is the one place the section engine meets real
       SQL, so it is the one place that can catch the key going missing. Not
       pinning a value: this call passes no history option, so today it reads
       null, but asserting exactly that would break the moment this subtest
       is wired up to real history without telling anyone anything useful. */
    assert.ok("historyStartedAt" in summary, "buildSummary must always carry historyStartedAt");
    assert.ok(summary.historyStartedAt === null || typeof summary.historyStartedAt === "string",
      "historyStartedAt must be null or an ISO string");
  });

  await t.test("re-ingesting the same workbook does not duplicate anything", async () => {
    const parsed = fixtureParsed(FILE);
    const repos = { projects: projectsRepo(ex), posture: postureRepo(ex) };

    await repos.projects.replaceForFile(FILE, parsed.projects);
    const store = new SqlStore(repos, { logger: quiet });
    await store.refresh();
    const before = await countForFile(ex, FILE);

    await repos.projects.replaceForFile(FILE, parsed.projects);
    await store.refresh();

    assert.equal(await countForFile(ex, FILE), before);
    const { recordset } = await ex.query(
      "SELECT COUNT(*) AS n FROM dbo.ProjectChild WHERE SourceFile = @f",
      [{ name: "f", type: sql.NVarChar(260), value: FILE }]
    );
    const expectedChildren = parsed.projects.reduce(
      (acc, p) => acc + p.milestones.length + p.updates.length + p.risks.length + p.questions.length, 0);
    assert.equal(recordset[0].n, expectedChildren, "child rows were duplicated");
  });

  await t.test("removing a workbook removes its rows", async () => {
    const repos = { projects: projectsRepo(ex), posture: postureRepo(ex) };
    await repos.projects.removeFile(FILE);
    await repos.posture.removeFile(FILE);

    const store = new SqlStore(repos, { logger: quiet });
    await store.refresh();
    assert.equal(await countForFile(ex, FILE), 0,
      "removing the workbook left its own rows behind");
  });

  await t.test("history records a version once, and not again for an unchanged file", async () => {
    const repos = {
      projects: projectsRepo(ex),
      posture: postureRepo(ex),
      sourceFiles: sourceFilesRepo(ex),
      ingestRuns: ingestRunsRepo(ex),
      projectVersions: projectVersionsRepo(ex),
    };
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "gcio-live-vault-"));
    const store = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });

    const parsed = fixtureParsed(FILE);

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
    assert.equal(runs[1].outcome, "applied", "the first run should still read applied");

    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  await t.test("a changed project appends exactly one new version", async () => {
    const versions = projectVersionsRepo(ex);

    const parsed = ingestFile("sample-data/GCIO_Portfolio_Master.xlsx");
    const subject = { ...parsed.projects[0], id: HIST_ID };

    const before = await versions.historyFor(subject.id);
    await versions.appendChanged([{ project: subject, hash: hashProject(subject) }], { ingestRunId: null });
    await versions.appendChanged([{ project: subject, hash: hashProject(subject) }], { ingestRunId: null });

    const afterSame = await versions.historyFor(subject.id);
    assert.equal(afterSame.length, before.length + 1, "an unchanged project was versioned twice");

    const changed = { ...subject, health: subject.health === "Red" ? "Green" : "Red" };
    await versions.appendChanged([{ project: changed, hash: hashProject(changed) }], { ingestRunId: null });

    const afterChange = await versions.historyFor(subject.id);
    assert.equal(afterChange.length, before.length + 2,
      "expected the earlier no-op version plus exactly one more for the actual change");
    assert.equal(afterChange[0].health, changed.health, "history is not newest-first");

    await ex.query("DELETE FROM dbo.ProjectVersion WHERE ProjectId = @id",
      [{ name: "id", type: sql.NVarChar(60), value: HIST_ID }]);
  });

  /* --------------------------------------------------------------------
   * Task 8 (Phase 2): changedSince against real rows. Every marker here uses
   * a ProjectId prefixed ID_PREFIX, swept by cleanup()'s one ProjectId LIKE.
   * -------------------------------------------------------------------- */

  await t.test("changedSince reports the baseline and the current version of what moved", async () => {
    const { projectVersionsRepo } = await import("../../server/repos/projectVersions.js");
    const { hashProject } = await import("../../server/ingest/hash.js");
    const versions = projectVersionsRepo(ex);

    const moved = `${ID_PREFIX}P2-MOVED`;
    const still = `${ID_PREFIX}P2-STILL`;
    const base = { ...ingestFile("sample-data/GCIO_Portfolio_Master.xlsx").projects[0] };

    /* Two versions of one project a week apart, and one that never moves.
       ingestRunId stays null: FK_ProjectVersion_IngestRun permits it, and this
       exercises the query rather than the ingest path. */
    const v1 = { ...base, id: moved, health: "Green", percentComplete: 40 };
    const unmoved = { ...base, id: still, health: "Amber" };
    await versions.appendChanged([
      { project: v1, hash: hashProject(v1) },
      { project: unmoved, hash: hashProject(unmoved) },
    ], { ingestRunId: null });

    /* Backdate the first pair so "since" has something to sit between. */
    await ex.query(`UPDATE dbo.ProjectVersion SET RecordedAt = @at WHERE ProjectId IN (@a, @b)`, [
      { name: "at", type: sql.DateTime2, value: new Date("2026-08-10T09:00:00Z") },
      { name: "a", type: sql.NVarChar(60), value: moved },
      { name: "b", type: sql.NVarChar(60), value: still },
    ]);

    const v2 = { ...v1, health: "Red", percentComplete: 45 };
    await versions.appendChanged([{ project: v2, hash: hashProject(v2) }], { ingestRunId: null });

    const changes = await versions.changedSince("2026-08-18");

    assert.ok(changes.has(moved), "the project that moved was not reported");
    assert.equal(changes.get(moved).baseline.health, "Green", "the baseline is not the pre-period version");
    assert.equal(changes.get(moved).current.health, "Red", "the current version is not the newest");
    assert.equal(changes.get(moved).trackedSince, null, "a baseline exists, so trackedSince must be null");

    assert.ok(!changes.has(still), "a project that never moved was reported as changed");
  });

  await t.test("a project first recorded inside the period has no baseline and no invented comparison", async () => {
    const { projectVersionsRepo } = await import("../../server/repos/projectVersions.js");
    const { hashProject } = await import("../../server/ingest/hash.js");
    const versions = projectVersionsRepo(ex);

    const fresh = { ...ingestFile("sample-data/GCIO_Portfolio_Master.xlsx").projects[0], id: `${ID_PREFIX}P2-FRESH` };
    await versions.appendChanged([{ project: fresh, hash: hashProject(fresh) }], { ingestRunId: null });

    const entry = (await versions.changedSince("2026-08-01")).get(`${ID_PREFIX}P2-FRESH`);
    assert.ok(entry, "a newly tracked project was dropped entirely");
    assert.equal(entry.baseline, null, "a baseline was invented for a project we have only just met");
    assert.ok(entry.trackedSince, "trackedSince must say when we first saw it");
  });

  await t.test("a version recorded exactly at the cutoff is the baseline, not a change", async () => {
    /* Off by one here reports the entire portfolio as changed every week,
       which is both wrong and the kind of wrong nobody questions. */
    const { projectVersionsRepo } = await import("../../server/repos/projectVersions.js");
    const { hashProject } = await import("../../server/ingest/hash.js");
    const versions = projectVersionsRepo(ex);

    const edge = { ...ingestFile("sample-data/GCIO_Portfolio_Master.xlsx").projects[0], id: `${ID_PREFIX}P2-EDGE` };
    await versions.appendChanged([{ project: edge, hash: hashProject(edge) }], { ingestRunId: null });
    await ex.query("UPDATE dbo.ProjectVersion SET RecordedAt = @at WHERE ProjectId = @id", [
      { name: "at", type: sql.DateTime2, value: new Date("2026-08-18T00:00:00Z") },
      { name: "id", type: sql.NVarChar(60), value: `${ID_PREFIX}P2-EDGE` },
    ]);

    const changes = await versions.changedSince("2026-08-18");
    assert.ok(!changes.has(`${ID_PREFIX}P2-EDGE`),
      "a version recorded exactly at the cutoff was treated as a change within the period");
  });

  await t.test("changesSince through the SqlStore returns comparisons, not raw version pairs", async () => {
    /* The three subtests above prove projectVersionsRepo.changedSince() is
       correct against real rows. This proves the layer above it -- the one
       every route actually calls -- applies compareVersions to those rows
       rather than handing the raw {baseline, current} pairs upward, and that
       real DECIMAL(19,2)/DECIMAL(5,2)/DATE values read back through tedious
       feed compareField correctly rather than as strings or NaN. */
    const versions = projectVersionsRepo(ex);

    const moved = `${ID_PREFIX}P2-CHAIN-MOVED`;
    const untracked = `${ID_PREFIX}P2-CHAIN-UNTRACKED`;
    const base = { ...ingestFile("sample-data/GCIO_Portfolio_Master.xlsx").projects[0] };

    const baseline = {
      ...base, id: moved, health: "Green", percentComplete: 40,
      budget: 100000.5, spent: 50000.25, targetEndDate: "2026-09-01",
    };
    /* owner is hashed (server/ingest/hash.js) but not one of changes.js's
       TRACKED_FIELDS -- so this project's content hash changes (a version
       gets written) but the comparison the phase cares about must not. */
    const untrackedBaseline = { ...base, id: untracked, owner: "Original Owner" };

    await versions.appendChanged([
      { project: baseline, hash: hashProject(baseline) },
      { project: untrackedBaseline, hash: hashProject(untrackedBaseline) },
    ], { ingestRunId: null });

    await ex.query(`UPDATE dbo.ProjectVersion SET RecordedAt = @at WHERE ProjectId IN (@a, @b)`, [
      { name: "at", type: sql.DateTime2, value: new Date("2026-08-10T09:00:00Z") },
      { name: "a", type: sql.NVarChar(60), value: moved },
      { name: "b", type: sql.NVarChar(60), value: untracked },
    ]);

    const current = {
      ...baseline, health: "Red", percentComplete: 65.5,
      budget: 100000.5, spent: 120000.75, targetEndDate: "2026-10-15",
    };
    const untrackedCurrent = { ...untrackedBaseline, owner: "New Owner" };

    await versions.appendChanged([
      { project: current, hash: hashProject(current) },
      { project: untrackedCurrent, hash: hashProject(untrackedCurrent) },
    ], { ingestRunId: null });

    const store = new SqlStore({ projectVersions: versions }, { logger: quiet });
    const changes = await store.changesSince("2026-08-18");

    const entry = changes.get(moved);
    assert.ok(entry, "a project that moved through real SQL rows was not reported by the store");
    assert.equal(entry.baseline, undefined,
      "the store handed back a raw version pair instead of a comparison");
    assert.equal(entry.current, undefined,
      "the store handed back a raw version pair instead of a comparison");
    assert.ok(entry.fields, "compareVersions was not applied to rows read back from SQL");
    assert.equal(entry.fields.health.from, "Green");
    assert.equal(entry.fields.health.to, "Red");
    assert.equal(entry.fields.percentComplete.delta, 25.5,
      "a real DECIMAL(5,2) percentComplete did not round-trip through tedious correctly");
    assert.equal(entry.fields.spent.delta, 70000.5,
      "a real DECIMAL(19,2) spent did not round-trip through tedious correctly");
    assert.equal(entry.fields.targetEndDate.days, 44,
      "a real DATE targetEndDate did not round-trip through tedious correctly");
    assert.equal(entry.worst, "worse");
    assert.equal(new Date(entry.since).getTime(), new Date("2026-08-10T09:00:00Z").getTime());

    assert.ok(!changes.has(untracked),
      "a project whose only change was in a field the phase does not track (owner) was reported as changed");
  });

  await t.test("historyStartedAt reflects the oldest recorded version, and null when nothing is recorded", async () => {
    /* Every row written by the suite so far is already covered by patterns
       cleanup() knows about (livetest%-tied IngestRunId, or an ID_PREFIX
       ProjectId), so calling it here -- mid-suite, not only in t.after --
       leaves dbo.ProjectVersion genuinely empty rather than merely assumed
       to be. That is the only honest way to exercise the null branch: the
       hermetic tests only ever saw a scripted executor stand in for "empty". */
    await cleanup(ex);

    const versions = projectVersionsRepo(ex);
    const store = new SqlStore({ projectVersions: versions }, { logger: quiet });

    /* cleanup() empties what this suite wrote, not what anyone else did:
       historyStartedAt() is MIN() over the whole table, and the shared
       development database can hold real history. The null branch is only
       honest when the table is genuinely empty, so assert it then, and assert
       the same contract -- the oldest row that actually remains -- otherwise. */
    const { recordset: remaining } = await ex.query(
      "SELECT COUNT(*) AS n, MIN(RecordedAt) AS oldest FROM dbo.ProjectVersion");
    if (remaining[0].n === 0) {
      assert.equal(await store.historyStartedAt(), null,
        "historyStartedAt reported a start date with nothing recorded anywhere");
    } else {
      assert.equal(new Date(await store.historyStartedAt()).getTime(),
        new Date(remaining[0].oldest).getTime(),
        "historyStartedAt did not report the oldest version actually recorded");
    }

    const base = { ...ingestFile("sample-data/GCIO_Portfolio_Master.xlsx").projects[0] };
    const oldest = { ...base, id: `${ID_PREFIX}P2-OLDEST` };
    const newer = { ...base, id: `${ID_PREFIX}P2-NEWER`, health: "Amber" };

    await versions.appendChanged([
      { project: oldest, hash: hashProject(oldest) },
      { project: newer, hash: hashProject(newer) },
    ], { ingestRunId: null });

    /* An anchor early enough that nothing else in this suite could ever
       backdate past it, so the assertion below does not depend on this
       subtest running before or after any other scenario. */
    await ex.query("UPDATE dbo.ProjectVersion SET RecordedAt = @at WHERE ProjectId = @id", [
      { name: "at", type: sql.DateTime2, value: new Date("2020-01-01T00:00:00Z") },
      { name: "id", type: sql.NVarChar(60), value: `${ID_PREFIX}P2-OLDEST` },
    ]);
    await ex.query("UPDATE dbo.ProjectVersion SET RecordedAt = @at WHERE ProjectId = @id", [
      { name: "at", type: sql.DateTime2, value: new Date("2020-06-01T00:00:00Z") },
      { name: "id", type: sql.NVarChar(60), value: `${ID_PREFIX}P2-NEWER` },
    ]);

    const started = await store.historyStartedAt();
    assert.equal(new Date(started).getTime(), new Date("2020-01-01T00:00:00Z").getTime(),
      "historyStartedAt did not return the oldest recorded version's timestamp");
  });

  /* --------------------------------------------------------------------
   * The six scenarios the Task 6 review found the hermetic fakes could not
   * catch, because the fakes do not share a real database the way SourceFile
   * and Project do. Each scenario uses its own pretend filename (all under
   * the FILE_PREFIX so cleanup sweeps them), and namespaces its project ids
   * so it cannot collide with any other scenario's rows.
   * -------------------------------------------------------------------- */

  await t.test("scenario 1: a failed first ingest does not hide the file, even for identical bytes on retry", async () => {
    const scenarioFile = "livetest-firstfail.xlsx";
    const repos = scenarioRepos(ex);
    const { dir: vaultDir, vault } = scenarioVault();
    try {
      const parsed = scenarioParsed(scenarioFile, "S1");
      failOnce(repos.projects, "replaceForFile", "simulated first-ingest failure");

      const firstStore = new SqlStore(repos, { vault, logger: quiet });
      await assert.rejects(
        () => firstStore.applyFile(parsed, { trigger: "replay" }),
        /simulated first-ingest failure/
      );

      assert.equal(await projectCountFor(ex, scenarioFile), 0, "the failed ingest left rows behind");

      /* A restart is not an escape hatch: retry with a BRAND NEW store --
         but the SAME on-disk vault, since a real restart keeps that -- using
         the identical bytes, to prove liveHashFor (not sourceFiles.record)
         is what decides "unchanged". */
      const secondStore = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });
      await secondStore.applyFile(parsed, { trigger: "replay" });

      assert.equal(await projectCountFor(ex, scenarioFile), parsed.projects.length,
        "identical bytes after a failed first ingest were skipped as unchanged, hiding the file");

      const runs = await runsFor(ex, scenarioFile);
      assert.equal(runs.length, 2, "expected exactly one failed attempt and one successful retry");
      assert.equal(runs[0].Outcome, "applied", "the retry should have applied, not been skipped as unchanged");
      assert.equal(runs[1].Outcome, "failed", "the first attempt should be recorded as failed");
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  await t.test("scenario 2: removing a file and re-dropping identical bytes applies, not unchanged", async () => {
    const scenarioFile = "livetest-removethendrop.xlsx";
    const repos = scenarioRepos(ex);
    const { dir: vaultDir } = scenarioVault();
    try {
      const parsed = scenarioParsed(scenarioFile, "S2");

      const store1 = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });
      await store1.applyFile(parsed, { trigger: "replay" });

      const store2 = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });
      await store2.removeFile(scenarioFile);

      assert.equal(await projectCountFor(ex, scenarioFile), 0, "removeFile did not remove the rows");

      const store3 = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });
      await store3.applyFile(parsed, { trigger: "replay" });

      assert.equal(await projectCountFor(ex, scenarioFile), parsed.projects.length,
        "re-dropping after removal did not apply");

      const runs = await runsFor(ex, scenarioFile);
      assert.equal(runs.length, 3, "expected apply, remove, then re-apply -- three runs total");
      assert.equal(runs[0].Outcome, "applied", "re-dropping after a removal should apply, not read unchanged");
      assert.equal(runs[1].Outcome, "removed", "the middle run should be the removal");
      assert.equal(runs[2].Outcome, "applied", "the first drop should still read applied");
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  await t.test("scenario 3: a failed update does not freeze stale data, and the update can still land on retry", async () => {
    const scenarioFile = "livetest-update.xlsx";
    const repos = scenarioRepos(ex);
    const { dir: vaultDir } = scenarioVault();
    try {
      const v1 = scenarioParsed(scenarioFile, "S3");
      const store = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });
      await store.applyFile(v1, { trigger: "replay" });

      const { recordset: afterV1 } = await ex.query(
        "SELECT ProjectId, Health FROM dbo.Project WHERE SourceFile = @f ORDER BY ProjectId",
        [{ name: "f", type: sql.NVarChar(260), value: scenarioFile }]
      );
      assert.ok(afterV1.length > 0, "v1 did not persist");

      /* v2: same filename, a meaningfully different project (health flips),
         and different bytes -- an unmodified buffer would hash the same as
         v1's and be recognised as unchanged before replaceForFile is ever
         reached, which would prove nothing about a failed snapshot write. */
      const v2Projects = v1.projects.map((p, i) => i === 0
        ? { ...p, health: p.health === "Red" ? "Green" : "Red",
            percentComplete: Math.min(100, (Number(p.percentComplete) || 0) + 1) }
        : p);
      const v2 = { ok: true, file: scenarioFile, projects: v2Projects, posture: v1.posture,
                   bytes: Buffer.concat([v1.bytes, Buffer.from([0x00])]) };

      failOnce(repos.projects, "replaceForFile", "simulated snapshot write failure");

      await assert.rejects(
        () => store.applyFile(v2, { trigger: "replay" }),
        /simulated snapshot write failure/
      );

      const { recordset: stillV1 } = await ex.query(
        "SELECT ProjectId, Health FROM dbo.Project WHERE SourceFile = @f ORDER BY ProjectId",
        [{ name: "f", type: sql.NVarChar(260), value: scenarioFile }]
      );
      assert.deepEqual(stillV1, afterV1, "v1's rows did not survive the failed v2 write");

      /* Retry with a fresh store -- v2 must now be able to land, because the
         failed attempt's run closed "failed", not "applied" or "unchanged". */
      const retryStore = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });
      await retryStore.applyFile(v2, { trigger: "replay" });

      const { recordset: afterV2 } = await ex.query(
        "SELECT ProjectId, Health FROM dbo.Project WHERE SourceFile = @f ORDER BY ProjectId",
        [{ name: "f", type: sql.NVarChar(260), value: scenarioFile }]
      );
      const changedRow = afterV2.find((r) => r.ProjectId === v2Projects[0].id);
      assert.ok(changedRow, "the changed project was missing after the retry");
      assert.equal(changedRow.Health, v2Projects[0].health, "v2 was not applied on retry");

      const runs = await runsFor(ex, scenarioFile);
      assert.equal(runs.length, 3, "expected v1 applied, v2 failed, then v2 applied on retry -- three runs total");
      assert.equal(runs[0].Outcome, "applied", "the retry should have applied");
      assert.equal(runs[1].Outcome, "failed", "the first v2 attempt should be recorded as failed");
      assert.equal(runs[2].Outcome, "applied", "v1's original apply should still read applied");
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  await t.test("scenario 4: a refresh failure after a successful apply still records applied, correctly", async () => {
    const scenarioFile = "livetest-misleading.xlsx";
    const repos = scenarioRepos(ex);
    const { dir: vaultDir, vault } = scenarioVault();
    try {
      const parsed = scenarioParsed(scenarioFile, "S4");
      const store = new SqlStore(repos, { vault, logger: quiet });
      store.refresh = async () => { throw new Error("simulated read-model refresh failure"); };

      await assert.rejects(
        () => store.applyFile(parsed, { trigger: "replay" }),
        /simulated read-model refresh failure/
      );

      const runs = await runsFor(ex, scenarioFile);
      assert.equal(runs.length, 1, "expected exactly one run despite the later refresh failure");
      assert.equal(runs[0].Outcome, "applied",
        "a refresh failure after a real success was recorded as anything but applied");
      assert.equal(runs[0].ProjectsChanged, parsed.projects.length,
        "every project in this apply is new, so all of them should count as changed");

      const { recordset: projectRows } = await ex.query(
        "SELECT ProjectId, Health FROM dbo.Project WHERE SourceFile = @f",
        [{ name: "f", type: sql.NVarChar(260), value: scenarioFile }]
      );
      assert.equal(projectRows.length, parsed.projects.length, "dbo.Project did not hold the applied data");

      const { recordset: versionRows } = await ex.query(
        "SELECT COUNT(*) AS n FROM dbo.ProjectVersion WHERE ProjectId IN (SELECT value FROM STRING_SPLIT(@ids, ','))",
        [{ name: "ids", type: sql.NVarChar(sql.MAX), value: parsed.projects.map((p) => p.id).join(",") }]
      );
      assert.equal(versionRows[0].n, parsed.projects.length, "dbo.ProjectVersion did not hold the applied history");
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  await t.test("scenario 5: liveHashFor tracks the most recently settled run, not whichever SourceFile row was touched last", async () => {
    const scenarioFile = "livetest-livehash.xlsx";
    const repos = scenarioRepos(ex);
    const { dir: vaultDir } = scenarioVault();
    try {
      const v1 = scenarioParsed(scenarioFile, "S5");
      const v2 = { ...v1, bytes: Buffer.concat([v1.bytes, Buffer.from([0x02])]) };
      const v1Hash = hashBytes(v1.bytes);
      const v2Hash = hashBytes(v2.bytes);
      assert.notEqual(v1Hash, v2Hash);

      const store1 = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });
      await store1.applyFile(v1, { trigger: "replay" });

      const store2 = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });
      await store2.applyFile(v2, { trigger: "replay" });

      assert.equal(await repos.ingestRuns.liveHashFor(scenarioFile), v2Hash,
        "liveHashFor did not track the most recently settled (v2) run");

      /* Touch v1's SourceFile row again -- bumping LastSeenAt to be the
         newest in the table -- without a new, successfully-applied run
         behind it. If liveHashFor were keyed off SourceFile.LastSeenAt
         instead of IngestRun, this would flip the answer back to v1's hash. */
      await repos.sourceFiles.record({
        fileName: scenarioFile, sha256: v1Hash, bytes: v1.bytes.length,
        vaultPath: "irrelevant-for-this-assertion", uploadedBy: null,
      });

      assert.equal(await repos.ingestRuns.liveHashFor(scenarioFile), v2Hash,
        "liveHashFor followed the SourceFile row touched last instead of the run history");
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  await t.test("scenario 6: a freshly constructed store does not know what is already in SQL until it refreshes", async () => {
    const scenarioFile = "livetest-coldstart.xlsx";
    const repos = scenarioRepos(ex);
    const { dir: vaultDir, vault } = scenarioVault();
    try {
      const parsed = scenarioParsed(scenarioFile, "S6");

      const writer = new SqlStore(repos, { vault, logger: quiet });
      await writer.applyFile(parsed, { trigger: "replay" });
      assert.ok(writer.sourceFiles.has(scenarioFile));
      const expectedTotal = writer.projectCount;

      /* A brand new process, same database: nothing is known until refresh(). */
      const cold = new SqlStore(repos, { vault: createVault(vaultDir, { logger: quiet }), logger: quiet });
      assert.equal(cold.projectCount, 0, "a freshly constructed store already knew about SQL rows");
      assert.equal(cold.fileCount, 0);
      assert.ok(!cold.sourceFiles.has(scenarioFile), "sourceFiles was populated before refresh() ever ran");

      await cold.refresh();
      assert.equal(cold.projectCount, expectedTotal,
        "refresh() did not pick up rows written by a different store instance");
      assert.ok(cold.sourceFiles.has(scenarioFile));
      assert.ok(cold.all().some((p) => p.id === parsed.projects[0].id),
        "a freshly refreshed store did not see this scenario's own projects");
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  /* Two more live-only checks beyond the required six: the phase's central
     claim about rejected workbooks, and the vault's own dedup guarantee. */
  await t.test("a rejected workbook records a failed run", async () => {
    const scenarioFile = "livetest-rejected.xlsx";
    const repos = scenarioRepos(ex);
    const store = new SqlStore(repos, { logger: quiet });

    await store.recordRejectedFile(scenarioFile, "some parse reason");

    const runs = await runsFor(ex, scenarioFile);
    assert.equal(runs.length, 1, "recordRejectedFile did not leave exactly one run");
    assert.equal(runs[0].Outcome, "failed");
    assert.ok(runs[0].FinishedAt, "the run was left open");
    assert.match(runs[0].Error, /some parse reason/);
  });

  await t.test("the vault holds exactly one copy of a workbook ingested twice, byte-identical", async () => {
    const scenarioFile = "livetest-vaultonce.xlsx";
    const repos = scenarioRepos(ex);
    const { dir: vaultDir, vault } = scenarioVault();
    try {
      const parsed = scenarioParsed(scenarioFile, "SV");

      const store1 = new SqlStore(repos, { vault, logger: quiet });
      await store1.applyFile(parsed, { trigger: "replay" });

      const store2 = new SqlStore(repos, { vault, logger: quiet });
      await store2.applyFile(parsed, { trigger: "replay" }); // identical bytes -> unchanged

      const hash = hashBytes(parsed.bytes);
      const ext = path.extname(scenarioFile).toLowerCase();
      let found = 0;
      for (const year of fs.readdirSync(vaultDir)) {
        for (const month of fs.readdirSync(path.join(vaultDir, year))) {
          found += fs.readdirSync(path.join(vaultDir, year, month))
            .filter((f) => f === `${hash}${ext}`).length;
        }
      }
      assert.equal(found, 1, "the vault stored more than one copy of identical bytes");

      const onDisk = vault.read(hash, ext);
      assert.ok(onDisk, "the vaulted file could not be read back");
      assert.ok(onDisk.equals(parsed.bytes), "the vaulted bytes differ from what was ingested");
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  await t.test("sessions honour expiry and can be destroyed", async () => {
    const sessions = sessionsRepo(ex);
    const id = await sessions.create({
      principal: "livetest@example", displayName: "Live Test", role: "pm",
      groups: ["Some, Group With Commas"], expiresAt: computeExpiry("8"), ip: "127.0.0.1",
    });

    const liveSession = await sessions.getLive(id, 240);
    assert.ok(liveSession, "a fresh session was not readable");
    assert.equal(liveSession.role, "pm");
    assert.deepEqual(liveSession.groups, ["Some, Group With Commas"], "group names did not survive storage");

    const expiredId = await sessions.create({
      principal: "livetest@example", displayName: "Expired", role: "viewer",
      groups: [], expiresAt: new Date(Date.now() - 60_000).toISOString(), ip: "127.0.0.1",
    });
    assert.equal(await sessions.getLive(expiredId, 240), null, "an expired session was accepted");

    assert.equal(await sessions.destroy(id), 1);
    assert.equal(await sessions.getLive(id, 240), null, "a destroyed session was still usable");
  });

  await t.test("the audit trail writes and reads back", async () => {
    const audit = auditRepo(ex, { logger: quiet });
    assert.equal(await audit.append({
      actor: "livetest@example", action: "export", subject: "pptx weekly", ip: "127.0.0.1",
    }), true);

    const recent = await audit.recent({ limit: 50 });
    const mine = recent.find((e) => e.actor === "livetest@example");
    assert.ok(mine, "the audit event was not readable");
    assert.equal(mine.action, "export");
  });

  await t.test("role mapping seeds once and resolves", async () => {
    const roleMapping = roleMappingRepo(ex, { cacheMs: 0 });
    await roleMapping.set("livetest-group", "pm");

    const map = await roleMapping.getMap({ fresh: true });
    assert.equal(map["livetest-group"], "pm");

    /* The table is not empty now, so seeding must decline. */
    assert.equal(await roleMapping.seedIfEmpty("should-not-be-added"), null);
    const after = await roleMapping.getMap({ fresh: true });
    assert.equal(after["should-not-be-added"], undefined);
  });

  /* --------------------------------------------------------------------
   * Task 6 (Phase 3): the ingest timing surface. ParseMs/PersistMs on
   * dbo.IngestRun (migration 10), the recent()/timingSummary()/
   * countByOutcome() reads built on them, and the real ingest path that
   * writes them. Every run here uses a livetest-timing- or
   * livetest-outcome- prefixed filename, swept by cleanup()'s FileName
   * LIKE 'livetest%'; the one subtest that writes dbo.Project/
   * ProjectVersion rows tags its ids ID_PREFIX + TIMING-, swept by the same
   * single prefix LIKE as every other id this suite writes.
   * -------------------------------------------------------------------- */

  await t.test("dbo.IngestRun has ParseMs and PersistMs as nullable int columns (migration 10)", async () => {
    /* sys.columns, not a successful insert: inferring "nullable" from "an
       insert with NULL succeeded" would also pass if the column simply did
       not exist and a typo'd column list silently dropped the value. The
       schema itself is the only source that cannot be fooled that way. */
    const { recordset } = await ex.query(`
      SELECT c.name, ty.name AS typeName, c.is_nullable
      FROM sys.columns c
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE c.object_id = OBJECT_ID('dbo.IngestRun') AND c.name IN ('ParseMs', 'PersistMs')
    `);
    const byName = Object.fromEntries(recordset.map((r) => [r.name, r]));

    assert.ok(byName.ParseMs, "dbo.IngestRun.ParseMs is missing -- migration 10 did not apply");
    assert.equal(byName.ParseMs.typeName, "int", "ParseMs is not an int column");
    assert.equal(byName.ParseMs.is_nullable, true,
      "ParseMs must be nullable -- a run that never parsed has no honest number to report");

    assert.ok(byName.PersistMs, "dbo.IngestRun.PersistMs is missing -- migration 10 did not apply");
    assert.equal(byName.PersistMs.typeName, "int", "PersistMs is not an int column");
    assert.equal(byName.PersistMs.is_nullable, true,
      "PersistMs must be nullable -- a run that died before persisting has no honest number to report");
  });

  await t.test("a run finished with durations reads them back through recent()", async () => {
    const scenarioFile = "livetest-timing-recent.xlsx";
    const ingestRuns = ingestRunsRepo(ex, { logger: quiet });

    const runId = await ingestRuns.start({ fileName: scenarioFile, trigger: "replay" });
    await ingestRuns.finish(runId, {
      outcome: "applied", projectsSeen: 1, projectsChanged: 1,
      parseMs: 42, persistMs: 77, fileName: scenarioFile,
    });

    /* limit: 500, the repo's own ceiling, rather than the default 200 -- a
       run placed this late in the suite must not be pushed out of the
       result by every scenario written above it. */
    const runs = await ingestRuns.recent({ limit: 500 });
    const mine = runs.find((r) => r.id === runId);
    assert.ok(mine, "the finished run was not returned by recent()");
    assert.equal(mine.parseMs, 42, "recent() did not read ParseMs back correctly");
    assert.equal(mine.persistMs, 77, "recent() did not read PersistMs back correctly");
  });

  await t.test("timingSummary() is windowed to 7 days: real rows report true maxima, an empty window reports nulls, and a backdated row is excluded", async () => {
    /* Every IngestRun row this suite has written so far is livetest%-tagged,
       so this leaves the table genuinely empty -- the only honest way to
       exercise the "nothing in the window" branch, same reasoning as the
       historyStartedAt subtest above calling cleanup() mid-suite. */
    await cleanup(ex);
    const ingestRuns = ingestRunsRepo(ex, { logger: quiet });

    /* A baseline, not an absolute: dbo.IngestRun can hold in-window runs this
       suite did not write, and on the shared development instance it does.
       Every assertion below is a delta from this, so the subtest measures
       what this suite added rather than what the table happens to contain.
       When the table really is empty the null-maxima branch is still the
       thing being asserted. */
    const baseline = await ingestRuns.timingSummary();
    if (baseline.runs === 0) {
      assert.deepEqual(baseline, { runs: 0, slowestParseMs: null, slowestPersistMs: null, lastFinishedAt: null },
        "an empty window must report null maxima and a null finish time -- MAX() over no rows is NULL, " +
        "not 0, and a zero here would falsely claim a 0ms parse happened");
    }

    const scenarioFile = "livetest-timing-summary.xlsx";

    const lowId = await ingestRuns.start({ fileName: scenarioFile, trigger: "replay" });
    await ingestRuns.finish(lowId, { outcome: "applied", parseMs: 15, persistMs: 25, fileName: scenarioFile });

    const highId = await ingestRuns.start({ fileName: scenarioFile, trigger: "replay" });
    await ingestRuns.finish(highId, { outcome: "applied", parseMs: 30, persistMs: 50, fileName: scenarioFile });

    const { recordset: highRow } = await ex.query(
      "SELECT FinishedAt FROM dbo.IngestRun WHERE IngestRunId = @id",
      [{ name: "id", type: sql.BigInt, value: highId }]
    );
    const expectedLastFinishedAt = highRow[0].FinishedAt;

    /* Backdated a comfortable 10 days -- not 7-days-and-a-minute, which
       would make this flaky at the boundary -- with durations bigger than
       either in-window row above. If timingSummary() ever regressed to an
       unwindowed MAX() over the whole table, this row's 999s would win both
       maxima and the assertions below would catch it: a test that never
       backdates anything cannot tell a windowed query from an unwindowed
       one, and this is deliberately built so it can. */
    const oldId = await ingestRuns.start({ fileName: scenarioFile, trigger: "replay" });
    await ingestRuns.finish(oldId, { outcome: "applied", parseMs: 999, persistMs: 999, fileName: scenarioFile });
    await ex.query(
      "UPDATE dbo.IngestRun SET FinishedAt = DATEADD(day, -10, SYSUTCDATETIME()) WHERE IngestRunId = @id",
      [{ name: "id", type: sql.BigInt, value: oldId }]
    );

    const summary = await ingestRuns.timingSummary();
    assert.equal(summary.runs, baseline.runs + 2, "the backdated run must not count toward the windowed runs total");
    /* Still catches an unwindowed regression: the backdated row's 999s beat
       both this suite's rows and any baseline maximum, so a MAX() over the
       whole table would fail these two however much the table already held. */
    assert.equal(summary.slowestParseMs, Math.max(baseline.slowestParseMs ?? 0, 30),
      "the backdated row's larger ParseMs leaked into the windowed maximum");
    assert.equal(summary.slowestPersistMs, Math.max(baseline.slowestPersistMs ?? 0, 50),
      "the backdated row's larger PersistMs leaked into the windowed maximum");
    assert.equal(new Date(summary.lastFinishedAt).getTime(), new Date(expectedLastFinishedAt).getTime(),
      "lastFinishedAt did not match the latest in-window finish time");
  });

  await t.test("countByOutcome() reports all four keys and is not windowed -- a run backdated past 7 days still counts", async () => {
    await cleanup(ex);
    const ingestRuns = ingestRunsRepo(ex, { logger: quiet });

    /* Zero-fill is the property under test, and it holds whatever the table
       already contains: all four keys must be present even for outcomes that
       never occurred. The counts themselves are a baseline to measure from,
       because runs this suite did not write also land in this unwindowed
       total. */
    const baseline = await ingestRuns.countByOutcome();
    assert.deepEqual(Object.keys(baseline).sort(), ["applied", "failed", "removed", "unchanged"],
      "countByOutcome() must always report all four outcome keys, zero-filled");

    const scenarioFile = "livetest-outcome-count.xlsx";

    const recentId = await ingestRuns.start({ fileName: scenarioFile, trigger: "replay" });
    await ingestRuns.finish(recentId, { outcome: "applied", fileName: scenarioFile });

    /* Backdated past timingSummary()'s 7-day window on purpose: this feeds a
       Prometheus counter, and a counter that can go backwards is a
       contradiction a scraper cannot represent, so countByOutcome() has no
       window at all. If the two aggregates were ever accidentally unified
       onto one windowed query, this row would silently stop being counted
       here -- which is exactly the difference from timingSummary() above. */
    const oldId = await ingestRuns.start({ fileName: scenarioFile, trigger: "replay" });
    await ingestRuns.finish(oldId, { outcome: "applied", fileName: scenarioFile });
    await ex.query(
      "UPDATE dbo.IngestRun SET FinishedAt = DATEADD(day, -10, SYSUTCDATETIME()) WHERE IngestRunId = @id",
      [{ name: "id", type: sql.BigInt, value: oldId }]
    );

    const counts = await ingestRuns.countByOutcome();
    assert.deepEqual(counts, { ...baseline, applied: baseline.applied + 2 },
      "countByOutcome() must count a run backdated beyond 7 days, and must leave every other outcome " +
      "exactly as it found it -- only 'applied' happened here, and only 'applied' may move");
  });

  await t.test("a real ingest through SqlStore.applyFile records ParseMs and PersistMs -- read back from SQL, not the return value", async () => {
    const scenarioFile = "livetest-timing-real.xlsx";
    const repos = scenarioRepos(ex);
    const { dir: vaultDir, vault } = scenarioVault();
    try {
      const base = ingestFile("sample-data/GCIO_Portfolio_Master.xlsx");
      assert.equal(base.ok, true, base.error);
      assert.equal(typeof base.parseMs, "number",
        "ingestFile must report parseMs for applyFile to have anything to record");

      /* Namespaced ids, same reasoning as every scenario above: dbo.Project's
         primary key is ProjectId alone, so carrying the fixture's real ids
         into a new filename would silently re-parent rows an earlier
         subtest already wrote instead of proving anything about this
         ingest's timing. Built by hand rather than via scenarioParsed(),
         which does not carry parseMs through -- and parseMs is the one
         field this subtest exists to prove gets recorded. */
      const parsed = {
        ok: true, file: scenarioFile, parseMs: base.parseMs,
        projects: base.projects.slice(0, 5).map((p) => ({ ...p, id: `${ID_PREFIX}TIMING-${p.id}` })),
        posture: base.posture, bytes: base.bytes,
      };

      const store = new SqlStore(repos, { vault, logger: quiet });
      await store.applyFile(parsed, { trigger: "replay" });

      const { recordset } = await ex.query(
        "SELECT TOP (1) ParseMs, PersistMs FROM dbo.IngestRun WHERE FileName = @f ORDER BY StartedAt DESC, IngestRunId DESC",
        [{ name: "f", type: sql.NVarChar(260), value: scenarioFile }]
      );
      assert.equal(recordset.length, 1, "the ingest did not leave a run behind");
      const { ParseMs, PersistMs } = recordset[0];

      for (const [label, value] of [["ParseMs", ParseMs], ["PersistMs", PersistMs]]) {
        assert.equal(typeof value, "number", `${label} was not recorded as a number in dbo.IngestRun -- read ${value}`);
        assert.ok(value > 0, `${label} must be greater than zero for a real parse and persist, was ${value}`);
        assert.ok(value < 60_000, `${label} must be less than a minute for this fixture, was ${value}`);
      }
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  /* ---------------------------------------------------------- documents --
   *
   * Everything below this point is the only place dbo.DocumentExtract is
   * exercised by a database rather than a fake. The hermetic suite drives
   * documentExtracts.js through a scripted executor, which pins the parameter
   * types and the JSON round-trip in JavaScript and cannot tell whether SQL
   * Server would accept a single statement -- a syntax error, a wrong column
   * name or a broken JOIN all pass there.
   *
   * It also proves the property the design actually rests on. Re-importing an
   * unchanged document must keep the first extract rather than restamping it,
   * and in production that is enforced by UX_DocumentExtract_SourceFile, an
   * index the in-memory store does not have and cannot stand in for.
   */
  await t.test("documentExtracts: add reads the row back, and the extract survives SQL", async () => {
    const files = sourceFilesRepo(ex);
    const docs = documentExtractsRepo(ex);

    const file = await files.record({
      fileName: `${FILE_PREFIX}-doc-a.pdf`, sha256: "a".repeat(64), bytes: 1024,
      vaultPath: "2026/09/a.pdf", uploadedBy: "livetest@example",
    });

    const extract = {
      blocks: [{ type: "paragraph", text: "The milestone slipped.", page: 1, level: null }],
      facts: { dates: [{ iso: "2026-11-15", text: "15 November 2026", page: 1, context: "Go-live." }],
               money: [{ text: "SAR 4,250,000", currency: "SAR", amount: "4,250,000", page: 1 }],
               projectRefs: ["PRJ-1001"] },
      summary: [{ text: "The milestone slipped.", page: 1, heading: "Risks", score: 6 }],
      warnings: [],
    };

    const stored = await docs.add({
      sourceFileId: file.sourceFileId, kind: "pdf", title: "Live PDF",
      pageCount: 3, wordCount: 42, extract,
    });

    assert.equal(stored.title, "Live PDF");
    assert.equal(stored.pageCount, 3, "PageCount came back as a number");
    assert.equal(stored.wordCount, 42);
    assert.equal(stored.fileName, `${FILE_PREFIX}-doc-a.pdf`, "add() JOINs SourceFile for the name");
    assert.deepEqual(stored.extract, extract, "the whole extract survived NVARCHAR(MAX) unchanged");
    assert.match(stored.extractedAt, /^\d{4}-\d{2}-\d{2}T/, "ExtractedAt reads back as ISO");
  });

  await t.test("documentExtracts: a pageless document stores NULL, never 0", async () => {
    const files = sourceFilesRepo(ex);
    const docs = documentExtractsRepo(ex);

    const file = await files.record({
      fileName: `${FILE_PREFIX}-doc-b.docx`, sha256: "b".repeat(64), bytes: 512,
      vaultPath: null, uploadedBy: "livetest@example",
    });
    const stored = await docs.add({
      sourceFileId: file.sourceFileId, kind: "docx", title: "Live Word",
      pageCount: null, wordCount: 9,
      extract: { blocks: [], facts: { dates: [], money: [], projectRefs: [] }, summary: [], warnings: [] },
    });

    assert.strictEqual(stored.pageCount, null, "a .docx has no pages, and 0 would be a lie");

    /* Read the column directly: toStored() maps it, so asserting only the
       mapped value would pass against a column holding 0. */
    const { recordset } = await ex.query(
      "SELECT PageCount FROM dbo.DocumentExtract WHERE SourceFileId = @id",
      [{ name: "id", type: sql.BigInt, value: file.sourceFileId }]);
    assert.strictEqual(recordset[0].PageCount, null, "the column itself holds NULL");
  });

  await t.test("documentExtracts: re-importing keeps the first extract and does not restamp it", async () => {
    const files = sourceFilesRepo(ex);
    const docs = documentExtractsRepo(ex);

    const file = await files.record({
      fileName: `${FILE_PREFIX}-doc-c.pdf`, sha256: "c".repeat(64), bytes: 2048,
      vaultPath: null, uploadedBy: "livetest@example",
    });
    const empty = { blocks: [], facts: { dates: [], money: [], projectRefs: [] }, summary: [], warnings: [] };

    const first = await docs.add({
      sourceFileId: file.sourceFileId, kind: "pdf", title: "Original",
      pageCount: 2, wordCount: 100, extract: empty,
    });

    /* A real gap, so an unchanged ExtractedAt means first-write-wins rather
       than two writes landing in the same millisecond. */
    await new Promise((r) => setTimeout(r, 25));

    const again = await docs.add({
      sourceFileId: file.sourceFileId, kind: "pdf", title: "RENAMED",
      pageCount: 99, wordCount: 1, extract: empty,
    });

    assert.equal(again.title, "Original", "the second import must not overwrite the first");
    assert.equal(again.pageCount, 2);
    assert.equal(again.extractedAt, first.extractedAt, "ExtractedAt was restamped by a re-import");

    const { recordset } = await ex.query(
      "SELECT COUNT(*) AS n FROM dbo.DocumentExtract WHERE SourceFileId = @id",
      [{ name: "id", type: sql.BigInt, value: file.sourceFileId }]);
    assert.equal(recordset[0].n, 1, "UX_DocumentExtract_SourceFile did not hold it to one row");
  });

  await t.test("documentExtracts: list is newest first, and remove reports what it did", async () => {
    const docs = documentExtractsRepo(ex);

    const mine = (await docs.list()).filter((d) => d.fileName.startsWith(FILE_PREFIX));
    assert.equal(mine.length, 3, `expected the three documents this suite wrote, got ${mine.length}`);

    const times = mine.map((d) => d.extractedAt);
    assert.deepEqual(times, [...times].sort().reverse(), "list() is not newest-first");

    const target = mine[0];
    assert.equal(await docs.remove(target.sourceFileId), true,
      "remove() reported false for a row that exists");
    assert.equal(await docs.remove(target.sourceFileId), false,
      "remove() reported true for a row that had already gone");

    const left = (await docs.list()).filter((d) => d.fileName.startsWith(FILE_PREFIX));
    assert.equal(left.length, 2, "removing one document took others with it");
  });

  await t.test("the suite leaves nothing behind", async () => {
    /* Every scenario writes under a livetest% filename and is responsible for
       its own rows. A cold run was once seen to finish 21/21 green while
       leaving 34 dbo.Project, 313 dbo.ProjectChild and 10 dbo.PostureDomain
       rows behind -- traceable to the "history records a version once..."
       subtest, which uses the shared FILE constant, never calls removeFile,
       and relies entirely on t.after. Checking only the three history
       tables, as every review before this one did, would have missed it.
       Calling cleanup(ex) first and THEN asserting zero is deliberate: this
       tests cleanup's completeness rather than racing it. */
    await cleanup(ex);

    for (const [table, column] of [
      ["Project", "SourceFile"],
      ["ProjectChild", "SourceFile"],
      ["PostureDomain", "SourceFile"],
      ["SourceFile", "FileName"],
      ["IngestRun", "FileName"],
    ]) {
      const { recordset } = await ex.query(
        `SELECT COUNT(*) AS n FROM dbo.${table} WHERE ${column} LIKE 'livetest%'`
      );
      assert.equal(recordset[0].n, 0, `dbo.${table} still holds rows this suite created`);
    }

    /* ProjectVersion has neither column: it is identified by ID_PREFIX, which
       every ProjectId this suite writes carries, or -- for the given-block
       history that goes through a real ingest -- by the IngestRunId of
       whichever livetest% run wrote it. */
    const { recordset: versions } = await ex.query(`
      SELECT COUNT(*) AS n FROM dbo.ProjectVersion
      WHERE ProjectId LIKE '${ID_PREFIX}%'
         OR IngestRunId IN (SELECT IngestRunId FROM dbo.IngestRun WHERE FileName LIKE 'livetest%')
    `);
    assert.equal(versions[0].n, 0, "dbo.ProjectVersion still holds rows this suite created");

    /* DocumentExtract has neither column either, and it is reachable only
       through SourceFileId. Worth asserting rather than trusting the cascade:
       cleanup deletes it explicitly, and if that delete were ever reordered
       after the SourceFile one it would fail on the foreign key instead of
       leaving rows behind -- a different failure, but this is what catches
       the version where someone "fixes" that by dropping the constraint. */
    const { recordset: extracts } = await ex.query(`
      SELECT COUNT(*) AS n FROM dbo.DocumentExtract
       WHERE SourceFileId IN (SELECT SourceFileId FROM dbo.SourceFile WHERE FileName LIKE 'livetest%')
    `);
    assert.equal(extracts[0].n, 0, "dbo.DocumentExtract still holds rows this suite created");
  });
});
