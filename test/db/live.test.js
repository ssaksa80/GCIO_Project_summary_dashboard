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

import { buildConfig } from "../../server/db/pool.js";
import { makeExecutor } from "../../server/db/executor.js";
import { migrate, MIGRATIONS } from "../../server/db/migrations.js";
import { projectsRepo } from "../../server/repos/projects.js";
import { postureRepo } from "../../server/repos/posture.js";
import { auditRepo } from "../../server/repos/audit.js";
import { sessionsRepo, computeExpiry } from "../../server/repos/sessions.js";
import { roleMappingRepo } from "../../server/repos/roleMapping.js";
import { SqlStore } from "../../server/store/sqlStore.js";
import { buildSummary } from "../../server/summarize.js";
import { ingestFile } from "../../server/ingest.js";

const live = process.env.DB_LIVE === "1";
const FILE = "livetest.xlsx";
const quiet = { info() {}, error() {}, warn() {} };

/** Everything this suite writes is tagged so cleanup cannot touch real rows. */
async function cleanup(ex) {
  for (const table of ["ProjectChild", "Project", "PostureDomain"]) {
    await ex.query(
      `IF OBJECT_ID('dbo.${table}','U') IS NOT NULL DELETE FROM dbo.${table} WHERE SourceFile = @f`,
      [{ name: "f", type: sql.NVarChar(260), value: FILE }]
    );
  }
  await ex.query("IF OBJECT_ID('dbo.AuditEvent','U') IS NOT NULL DELETE FROM dbo.AuditEvent WHERE Actor = @a",
    [{ name: "a", type: sql.NVarChar(320), value: "livetest@example" }]);
  await ex.query("IF OBJECT_ID('dbo.Sessions','U') IS NOT NULL DELETE FROM dbo.Sessions WHERE Principal = @p",
    [{ name: "p", type: sql.NVarChar(200), value: "livetest@example" }]);
  await ex.query("IF OBJECT_ID('dbo.RoleMapping','U') IS NOT NULL DELETE FROM dbo.RoleMapping WHERE GroupName = @g",
    [{ name: "g", type: sql.NVarChar(300), value: "livetest-group" }]);
}

test("the SQL path works end to end against a real instance", { skip: !live }, async (t) => {
  const pool = await new sql.ConnectionPool(buildConfig(process.env)).connect();
  const ex = makeExecutor(pool, { logger: quiet });
  t.after(async () => {
    await cleanup(ex);
    await pool.close();
  });
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
      WHERE name IN ('Project','ProjectChild','PostureDomain','Sessions','RoleMapping','AuditEvent','SchemaMigration')
    `);
    /* Sort both sides: hand-ordering the expectation is how this failed the
       first time, on SchemaMigration vs Sessions rather than on anything real. */
    const expected = [
      "AuditEvent", "PostureDomain", "Project", "ProjectChild", "RoleMapping", "SchemaMigration", "Sessions",
    ].sort();
    assert.deepEqual(recordset.map((r) => r.name).sort(), expected);
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
});
