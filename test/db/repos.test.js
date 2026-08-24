/**
 * Repository behaviour against a scripted executor. These assert the things
 * that bite in production: values are bound rather than concatenated, a
 * workbook's rows are replaced atomically, and an audit failure never
 * propagates into the request that triggered it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { postureRepo } from "../../server/repos/posture.js";
import { auditRepo } from "../../server/repos/audit.js";
import { migrate } from "../../server/db/migrations.js";

/** An executor that records statements and replays canned recordsets. */
function scriptedExecutor({ recordsets = {}, failOn = null } = {}) {
  const statements = [];
  const ex = {
    statements,
    async query(text, params) {
      statements.push({ text: text.trim(), params: params || [] });
      if (failOn && text.includes(failOn)) throw new Error("boom");
      for (const [needle, rows] of Object.entries(recordsets)) {
        if (text.includes(needle)) return { recordset: rows, rowsAffected: [rows.length] };
      }
      return { recordset: [], rowsAffected: [0] };
    },
    async tx(fn) {
      statements.push({ text: "BEGIN TRAN", params: [] });
      const out = await fn(ex);
      statements.push({ text: "COMMIT", params: [] });
      return out;
    },
  };
  return ex;
}

const quiet = { error() {}, info() {} };

test("posture rows are read back in the shape the section engine expects", async () => {
  const ex = scriptedExecutor({
    recordsets: {
      "FROM dbo.PostureDomain": [{
        Domain: "Identity & Access Management", Control: "Privileged access review",
        Status: "Non-Compliant", Score: 52, Target: 95, Owner: "CISO",
        LastAssessed: new Date("2026-07-31T00:00:00Z"), NextReview: new Date("2026-08-15T00:00:00Z"),
        OpenFindings: 18, CriticalFindings: 4, ProjectId: "PRJ-3005",
        Notes: "overdue", SourceFile: "master.xlsx",
      }],
    },
  });

  const rows = await postureRepo(ex).list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, "Identity & Access Management");
  assert.equal(rows[0].score, 52);
  assert.equal(rows[0].lastAssessed, "2026-07-31");
  assert.equal(rows[0].nextReview, "2026-08-15");
  assert.equal(rows[0].projectId, "PRJ-3005");
});

test("replacing a file's posture deletes and inserts inside one transaction", async () => {
  const ex = scriptedExecutor();
  const written = await postureRepo(ex).replaceForFile("master.xlsx", [
    { domain: "A", status: "Compliant", score: 90, target: 90 },
    { domain: "B", status: "Partial", score: 60, target: 90 },
  ]);

  assert.equal(written, 2);
  const texts = ex.statements.map((s) => s.text);
  assert.equal(texts[0], "BEGIN TRAN");
  assert.equal(texts[texts.length - 1], "COMMIT");
  assert.ok(texts.some((t) => t.startsWith("DELETE FROM dbo.PostureDomain")));
  assert.equal(texts.filter((t) => t.includes("INSERT INTO dbo.PostureDomain")).length, 2);
});

test("no posture value is ever interpolated into the statement text", async () => {
  const ex = scriptedExecutor();
  await postureRepo(ex).replaceForFile("master.xlsx", [
    { domain: "Robert'); DROP TABLE PostureDomain;--", status: "Partial", score: 1, target: 2 },
  ]);

  for (const stmt of ex.statements) {
    assert.ok(!stmt.text.includes("DROP TABLE"), "hostile value reached the SQL text");
  }
  const insert = ex.statements.find((s) => s.text.includes("INSERT INTO dbo.PostureDomain"));
  assert.equal(insert.params.find((p) => p.name === "domain").value, "Robert'); DROP TABLE PostureDomain;--");
});

test("an audit write failure is swallowed, not propagated", async () => {
  const ex = scriptedExecutor({ failOn: "INSERT INTO dbo.AuditEvent" });
  const ok = await auditRepo(ex, { logger: quiet }).append({ actor: "a@x", action: "export" });
  assert.equal(ok, false);
});

test("audit reads are capped so a huge limit cannot be requested", async () => {
  const ex = scriptedExecutor({ recordsets: { "FROM dbo.AuditEvent": [] } });
  await auditRepo(ex, { logger: quiet }).recent({ limit: 999999 });
  const stmt = ex.statements.find((s) => s.text.includes("FROM dbo.AuditEvent"));
  assert.equal(stmt.params.find((p) => p.name === "limit").value, 1000);
});

test("migrations apply once and are a no-op on the next boot", async () => {
  const fresh = scriptedExecutor({ recordsets: { "SELECT Id FROM dbo.SchemaMigration": [] } });
  const first = await migrate(fresh, { logger: quiet });
  assert.deepEqual(first.applied, [1, 2]);

  const already = scriptedExecutor({
    recordsets: { "SELECT Id FROM dbo.SchemaMigration": [{ Id: 1 }, { Id: 2 }] },
  });
  const second = await migrate(already, { logger: quiet });
  assert.deepEqual(second.applied, []);
  assert.equal(second.alreadyCurrent, true);
});
