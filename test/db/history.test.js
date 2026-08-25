import test from "node:test";
import assert from "node:assert/strict";
import { sourceFilesRepo } from "../../server/repos/sourceFiles.js";
import { ingestRunsRepo } from "../../server/repos/ingestRuns.js";

/* Note: every call site below passes the needle -> rows map directly
   (scriptedExecutor({ "SELECT ...": [...] })), not wrapped as
   { recordsets: {...} } like test/db/repos.test.js does. This helper's
   signature matches that calling convention on purpose -- test/db/repos.test.js
   defines a DIFFERENT scriptedExecutor (wrapped { recordsets } signature,
   BEGIN TRAN/COMMIT markers, failOn support). Do not copy that one here. */
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

test("recording a known file returns alreadySeen true, in one atomic statement", async () => {
  const ex = scriptedExecutor({ "MERGE dbo.SourceFile": [{ Action: "UPDATE", SourceFileId: 7 }] });
  const result = await sourceFilesRepo(ex).record({
    fileName: "master.xlsx", sha256: "a".repeat(64), bytes: 1234,
    vaultPath: "2026/08/aaa.xlsx", uploadedBy: "pat@x",
  });

  assert.equal(result.sourceFileId, 7);
  assert.equal(result.alreadySeen, true);
  assert.equal(ex.statements.length, 1,
    "record() must be a single statement -- a SELECT-then-branch reopens the race");
  assert.ok(ex.statements[0].text.startsWith("MERGE dbo.SourceFile"),
    "the race fix depends on this being a MERGE, not SELECT-then-branch");
});

test("a file never seen before is inserted", async () => {
  const ex = scriptedExecutor({ "MERGE dbo.SourceFile": [{ Action: "INSERT", SourceFileId: 11 }] });
  const result = await sourceFilesRepo(ex).record({
    fileName: "new.xlsx", sha256: "b".repeat(64), bytes: 10, vaultPath: "2026/08/b.xlsx",
  });

  assert.equal(result.sourceFileId, 11);
  assert.equal(result.alreadySeen, false);
});

test("a file re-seen under a different uploader keeps its original vault path", async () => {
  // WHEN MATCHED deliberately touches only LastSeenAt. Pinned here so nobody
  // "helpfully" starts overwriting VaultPath/UploadedBy on a re-seen file.
  const ex = scriptedExecutor({ "MERGE dbo.SourceFile": [{ Action: "UPDATE", SourceFileId: 7 }] });
  await sourceFilesRepo(ex).record({
    fileName: "master.xlsx", sha256: "a".repeat(64), bytes: 1234,
    vaultPath: "2026/08/different-path.xlsx", uploadedBy: "someone-else@x",
  });

  const merge = ex.statements[0].text;
  const matchedClause = merge.slice(merge.indexOf("WHEN MATCHED"), merge.indexOf("WHEN NOT MATCHED"));
  assert.doesNotMatch(matchedClause, /VaultPath|UploadedBy/,
    "WHEN MATCHED must set only LastSeenAt");
});

test("the newest hash for a name is what decides whether to re-parse", async () => {
  const ex = scriptedExecutor({ "SELECT TOP (1) Sha256": [{ Sha256: "c".repeat(64) }] });
  assert.equal(await sourceFilesRepo(ex).newestHashFor("master.xlsx"), "c".repeat(64));

  const empty = scriptedExecutor();
  assert.equal(await sourceFilesRepo(empty).newestHashFor("unknown.xlsx"), null);
});

test("a run is started, then finished with its counts", async () => {
  const ex = scriptedExecutor({
    "INSERT INTO dbo.IngestRun": [{ IngestRunId: 42 }],
    "UPDATE dbo.IngestRun": [{}], // one row closed, so finish() must not log a false "not closed"
  });
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
  const ex = scriptedExecutor({
    "INSERT INTO dbo.IngestRun": [{ IngestRunId: 43 }],
    "UPDATE dbo.IngestRun": [{}],
  });
  const runs = ingestRunsRepo(ex);
  const runId = await runs.start({ fileName: "bad.xlsx", trigger: "upload" });

  await runs.finish(runId, { outcome: "failed", error: "x".repeat(5000) });
  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  assert.equal(update.params.find((p) => p.name === "error").value.length, 1000);
});

test("start() refuses a trigger outside the vocabulary", async () => {
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 1 }] });
  const runs = ingestRunsRepo(ex);
  await assert.rejects(() => runs.start({ fileName: "x.xlsx", trigger: "cron" }), /unknown ingest trigger/);
});

test("finish() refuses an outcome outside the vocabulary", async () => {
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 60 }] });
  const runs = ingestRunsRepo(ex);
  const runId = await runs.start({ fileName: "x.xlsx", trigger: "watcher" });

  await assert.rejects(() => runs.finish(runId, { outcome: "sideways" }), /unknown ingest outcome/);
});

test("finish() logs rather than throws when it closes no row", async () => {
  const messages = [];
  const logger = { error: (msg) => messages.push(msg) };
  const ex = scriptedExecutor(); // no needles configured -> every query reports rowsAffected [0]
  const runs = ingestRunsRepo(ex, { logger });

  await assert.doesNotReject(runs.finish(999, { outcome: "applied" }));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /999/);
});

test("finish() can attach a source file discovered after the run started", async () => {
  const ex = scriptedExecutor({
    "INSERT INTO dbo.IngestRun": [{ IngestRunId: 50 }],
    "UPDATE dbo.IngestRun": [{}],
  });
  const runs = ingestRunsRepo(ex);
  const runId = await runs.start({ fileName: "master.xlsx", trigger: "watcher" });

  await runs.finish(runId, { outcome: "applied", sourceFileId: 9 });
  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  assert.equal(update.params.find((p) => p.name === "sourceFileId").value, 9);
});

test("finish() without a source file leaves COALESCE to preserve whatever is there", async () => {
  const ex = scriptedExecutor({
    "INSERT INTO dbo.IngestRun": [{ IngestRunId: 51 }],
    "UPDATE dbo.IngestRun": [{}],
  });
  const runs = ingestRunsRepo(ex);
  const runId = await runs.start({ fileName: "master.xlsx", trigger: "watcher" });

  await runs.finish(runId, { outcome: "applied" });
  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  assert.equal(update.params.find((p) => p.name === "sourceFileId").value, null);
  assert.match(update.text, /COALESCE\(@sourceFileId, SourceFileId\)/);
});

test("recent runs come back newest first and bounded", async () => {
  /* 500 matches the ceiling the admin route in Task 7 enforces; a lower cap
     here would silently return less than the caller asked for. */
  const ex = scriptedExecutor({ "FROM dbo.IngestRun": [] });
  await ingestRunsRepo(ex).recent({ limit: 999999 });
  const select = ex.statements.find((s) => s.text.includes("FROM dbo.IngestRun"));
  assert.equal(select.params.find((p) => p.name === "limit").value, 500);
});

test("recent({ limit: 0 }) falls through to the 200 default, not clamped to 1", async () => {
  // Number(0) || 200 treats 0 as falsy. Documented here so a future change to
  // this fallback is a deliberate decision, not an accidental regression.
  const ex = scriptedExecutor({ "FROM dbo.IngestRun": [] });
  await ingestRunsRepo(ex).recent({ limit: 0 });
  const select = ex.statements.find((s) => s.text.includes("FROM dbo.IngestRun"));
  assert.equal(select.params.find((p) => p.name === "limit").value, 200);
});

test("a negative or non-numeric limit still lands inside 1..500", async () => {
  const negative = scriptedExecutor({ "FROM dbo.IngestRun": [] });
  await ingestRunsRepo(negative).recent({ limit: -5 });
  const negativeLimit = negative.statements
    .find((s) => s.text.includes("FROM dbo.IngestRun")).params.find((p) => p.name === "limit").value;
  assert.ok(negativeLimit >= 1 && negativeLimit <= 500, `expected 1..500, got ${negativeLimit}`);

  const nonNumeric = scriptedExecutor({ "FROM dbo.IngestRun": [] });
  await ingestRunsRepo(nonNumeric).recent({ limit: "abc" });
  const nonNumericLimit = nonNumeric.statements
    .find((s) => s.text.includes("FROM dbo.IngestRun")).params.find((p) => p.name === "limit").value;
  assert.ok(nonNumericLimit >= 1 && nonNumericLimit <= 500, `expected 1..500, got ${nonNumericLimit}`);
});
