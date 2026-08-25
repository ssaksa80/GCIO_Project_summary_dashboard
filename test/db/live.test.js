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

  await ex.query(`
    IF OBJECT_ID('dbo.ProjectVersion','U') IS NOT NULL
      DELETE FROM dbo.ProjectVersion WHERE ProjectId = 'PRJ-HIST-TEST'
         OR IngestRunId IN (SELECT IngestRunId FROM dbo.IngestRun WHERE FileName LIKE @pattern)`,
    [pattern]);
  await ex.query(
    "IF OBJECT_ID('dbo.IngestRun','U') IS NOT NULL DELETE FROM dbo.IngestRun WHERE FileName LIKE @pattern",
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
    projects: base.projects.slice(0, count).map((p) => ({ ...p, id: `${tag}-${p.id}` })),
    posture: base.posture,
    bytes: base.bytes,
  };
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

  await t.test("a real workbook persists and reads back through the store", async () => {
    const parsed = ingestFile("sample-data/GCIO_Portfolio_Master.xlsx");
    assert.equal(parsed.ok, true, parsed.error);

    const repos = { projects: projectsRepo(ex), posture: postureRepo(ex) };
    await repos.projects.replaceForFile(FILE, parsed.projects);
    await repos.posture.replaceForFile(FILE, parsed.posture || []);

    const store = new SqlStore(repos, { logger: quiet });
    await store.refresh();

    assert.equal(store.projectCount, parsed.projects.length);
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
    assert.deepEqual(Object.keys(summary.sections), ["successes", "qri", "priorities", "roadmap", "posture"]);
    assert.ok(summary.sections.priorities.items.length > 0, "no priorities came back from SQL");
    assert.equal(summary.sections.posture.available, true, "the Posture sheet did not survive the round trip");
    assert.ok(summary.sections.posture.domains.length > 0);
  });

  await t.test("re-ingesting the same workbook does not duplicate anything", async () => {
    const parsed = ingestFile("sample-data/GCIO_Portfolio_Master.xlsx");
    const repos = { projects: projectsRepo(ex), posture: postureRepo(ex) };

    await repos.projects.replaceForFile(FILE, parsed.projects);
    const store = new SqlStore(repos, { logger: quiet });
    await store.refresh();
    const before = store.projectCount;

    await repos.projects.replaceForFile(FILE, parsed.projects);
    await store.refresh();

    assert.equal(store.projectCount, before);
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
    assert.equal(store.projectCount, 0);
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
    assert.equal(runs[1].outcome, "applied", "the first run should still read applied");

    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  await t.test("a changed project appends exactly one new version", async () => {
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
    assert.equal(afterChange.length, before.length + 2,
      "expected the earlier no-op version plus exactly one more for the actual change");
    assert.equal(afterChange[0].health, changed.health, "history is not newest-first");

    await ex.query("DELETE FROM dbo.ProjectVersion WHERE ProjectId = @id",
      [{ name: "id", type: sql.NVarChar(60), value: "PRJ-HIST-TEST" }]);
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

    /* ProjectVersion has neither column: it is identified by the ProjectId
       markers this suite's scenarios use (S1-.. through S6-.. and SV-.. tag
       prefixes, plus the literal PRJ-HIST-TEST) or, for the given-block
       history that goes through a real ingest, by the IngestRunId of
       whichever livetest% run wrote it. */
    const { recordset: versions } = await ex.query(`
      SELECT COUNT(*) AS n FROM dbo.ProjectVersion
      WHERE ProjectId = 'PRJ-HIST-TEST' OR ProjectId LIKE 'S[1-6V]-%'
         OR IngestRunId IN (SELECT IngestRunId FROM dbo.IngestRun WHERE FileName LIKE 'livetest%')
    `);
    assert.equal(versions[0].n, 0, "dbo.ProjectVersion still holds rows this suite created");
  });
});
