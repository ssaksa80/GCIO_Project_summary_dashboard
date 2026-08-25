import test from "node:test";
import assert from "node:assert/strict";
import { sourceFilesRepo } from "../../server/repos/sourceFiles.js";
import { ingestRunsRepo } from "../../server/repos/ingestRuns.js";

/* Note: every call site below passes the needle -> rows map directly
   (scriptedExecutor({ "SELECT ...": [...] })), not wrapped as
   { recordsets: {...} } like test/db/repos.test.js does. This helper's
   signature matches that calling convention on purpose. */
function scriptedExecutor(recordsets = {}) {
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
  /* 500 matches the ceiling the admin route in Task 7 enforces; a lower cap
     here would silently return less than the caller asked for. */
  const ex = scriptedExecutor({ "FROM dbo.IngestRun": [] });
  await ingestRunsRepo(ex).recent({ limit: 999999 });
  const select = ex.statements.find((s) => s.text.includes("FROM dbo.IngestRun"));
  assert.equal(select.params.find((p) => p.name === "limit").value, 500);
});
