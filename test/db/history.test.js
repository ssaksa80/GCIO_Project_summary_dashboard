import test from "node:test";
import assert from "node:assert/strict";
import { sourceFilesRepo } from "../../server/repos/sourceFiles.js";
import { ingestRunsRepo } from "../../server/repos/ingestRuns.js";
import { projectVersionsRepo } from "../../server/repos/projectVersions.js";

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

test("liveHashFor: an applied run's hash is the live one", async () => {
  const ex = scriptedExecutor({ "SELECT TOP (1) r.Outcome": [{ Outcome: "applied", Sha256: "a".repeat(64) }] });
  assert.equal(await ingestRunsRepo(ex).liveHashFor("master.xlsx"), "a".repeat(64));
});

test("liveHashFor: an unchanged run's hash is the live one too", async () => {
  const ex = scriptedExecutor({ "SELECT TOP (1) r.Outcome": [{ Outcome: "unchanged", Sha256: "b".repeat(64) }] });
  assert.equal(await ingestRunsRepo(ex).liveHashFor("master.xlsx"), "b".repeat(64));
});

test("liveHashFor: a failed run proves nothing landed, even though a SourceFile row joins in", async () => {
  // The failure defect this method exists to close: SourceFile remembers a
  // hash the instant it is vaulted, whether or not the ingest that vaulted it
  // ever reached dbo.Project. A failed run's outcome must win over a hash that
  // happens to be joinable, or the whole point of this method is lost.
  const ex = scriptedExecutor({ "SELECT TOP (1) r.Outcome": [{ Outcome: "failed", Sha256: "c".repeat(64) }] });
  assert.equal(await ingestRunsRepo(ex).liveHashFor("master.xlsx"), null);
});

test("liveHashFor: a removed run means nothing is live", async () => {
  const ex = scriptedExecutor({ "SELECT TOP (1) r.Outcome": [{ Outcome: "removed", Sha256: null }] });
  assert.equal(await ingestRunsRepo(ex).liveHashFor("master.xlsx"), null);
});

test("liveHashFor: no runs at all for this file is null, not an error", async () => {
  const ex = scriptedExecutor();
  assert.equal(await ingestRunsRepo(ex).liveHashFor("never-seen.xlsx"), null);
});

test("liveHashFor only considers runs that have already closed", async () => {
  // The scripted executor cannot itself filter by outcome, so what is pinned
  // here is that the query text excludes the still-open run rather than
  // relying on the caller never asking mid-ingest -- exactly the run this
  // method is invoked from is one that is not yet closed.
  const ex = scriptedExecutor({ "SELECT TOP (1) r.Outcome": [] });
  await ingestRunsRepo(ex).liveHashFor("master.xlsx");
  const select = ex.statements.find((s) => s.text.includes("SELECT TOP (1) r.Outcome"));
  assert.match(select.text, /Outcome IS NOT NULL/);
});

test("finish() truncation does not leave a lone surrogate when the cut lands mid-pair", async () => {
  /* The existing truncation test uses "x".repeat(5000), which never lands
     inside a surrogate pair. Here the emoji's surrogate pair straddles the
     1000th UTF-16 code unit exactly: 999 "x"s occupy indices 0..998, so the
     high surrogate sits at index 999 (the 1000th unit) and the low surrogate
     at index 1000 -- a naive slice(0, 1000) keeps the high half only. */
  const ex = scriptedExecutor({
    "INSERT INTO dbo.IngestRun": [{ IngestRunId: 70 }],
    "UPDATE dbo.IngestRun": [{}],
  });
  const runs = ingestRunsRepo(ex);
  const runId = await runs.start({ fileName: "x.xlsx", trigger: "watcher" });

  const error = "x".repeat(999) + "\u{1F600}" + "tail";
  await runs.finish(runId, { outcome: "applied", error });

  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  const stored = update.params.find((p) => p.name === "error").value;

  assert.ok(stored.length <= 1000, `expected at most 1000 UTF-16 code units, got ${stored.length}`);
  // Spreading a string iterates by code point, pairing valid surrogate
  // pairs into one two-char entry but leaving a lone surrogate half as its
  // own single-char entry -- exactly what must not survive truncation.
  const hasLoneSurrogate = [...stored].some((ch) => /^[\uD800-\uDFFF]$/.test(ch));
  assert.equal(hasLoneSurrogate, false, "stored error contains a lone (unpaired) surrogate");
});

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

test("an Answered question is still open, matching the QRI panel in sections.js", async () => {
  // server/sections.js:212 lists a question as outstanding whenever its status
  // is not "Closed", so an Answered question still shows up there. History
  // must count it the same way, or OpenQuestions disagrees with what the
  // dashboard shows for the same project at the same moment.
  const ex = scriptedExecutor();
  await projectVersionsRepo(ex).appendChanged(
    [{ project: versionProject({
        questions: [
          { text: "a", status: "Open" },
          { text: "b", status: "Answered" },
          { text: "c", status: "Closed" },
        ],
      }), hash: "h" }],
    { ingestRunId: 1 }
  );

  const insert = ex.statements.find((s) => s.text.includes("INSERT INTO dbo.ProjectVersion"));
  assert.equal(insert.params.find((p) => p.name === "openQuestions").value, 2,
    "Answered is not Closed, so sections.js would still show it as outstanding");
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

test("historyFor({ limit: 0 }) falls through to the 50 default, not clamped to 1", async () => {
  // Mirrors the same Number(limit) || default idiom pinned for
  // recent({ limit: 0 }) above -- Number(0) || 50 treats 0 as falsy, and only
  // one of the two repositories sharing this idiom had that behaviour pinned.
  const ex = scriptedExecutor({ "FROM dbo.ProjectVersion": [] });
  await projectVersionsRepo(ex).historyFor("PRJ-1", { limit: 0 });
  const select = ex.statements.find((s) => s.text.includes("FROM dbo.ProjectVersion"));
  assert.equal(select.params.find((p) => p.name === "limit").value, 50);
});

test("nothing to write is not a database round trip", async () => {
  const ex = scriptedExecutor();
  assert.equal(await projectVersionsRepo(ex).appendChanged([], { ingestRunId: 1 }), 0);
  assert.equal(ex.statements.length, 0, "an empty ingest still queried the database");
});

test("appendChanged refuses a project id containing a comma", async () => {
  // The bulk lookup joins ids with commas for STRING_SPLIT. A comma in an id
  // would silently split it into two ids that match nothing, so this must be
  // a loud failure that names the offending id rather than a silent mis-split.
  const ex = scriptedExecutor();
  await assert.rejects(
    () => projectVersionsRepo(ex).appendChanged(
      [{ project: versionProject({ id: "PRJ,1" }), hash: "h" }],
      { ingestRunId: 1 }
    ),
    /PRJ,1/
  );
  assert.equal(ex.statements.length, 0, "a rejected batch must not have queried the database first");
});

test("a project id with surrounding whitespace and lowercase still matches the stored uppercase hash", async () => {
  // The database collation is case-insensitive and STRING_SPLIT does not
  // trim, but the newestByProject Map lookup is neither -- so this repo must
  // normalise before comparing, not rely on every caller having already done
  // so (server/ingest.js does, but a future replay/backfill caller might not).
  const ex = scriptedExecutor({
    "SELECT ProjectId, ContentHash": [{ ProjectId: "PRJ-1", ContentHash: "known-hash" }],
  });

  const written = await projectVersionsRepo(ex).appendChanged(
    [{ project: versionProject({ id: " prj-1 " }), hash: "known-hash" }],
    { ingestRunId: 1 }
  );

  assert.equal(written, 0, "an unchanged project (once normalised) was versioned again");
  const inserts = ex.statements.filter((s) => s.text.includes("INSERT INTO dbo.ProjectVersion"));
  assert.equal(inserts.length, 0);
});

test("appendChanged refuses a candidate with no usable id", async () => {
  const ex = scriptedExecutor();
  await assert.rejects(
    () => projectVersionsRepo(ex).appendChanged(
      [{ project: versionProject({ id: "   " }), hash: "h" }],
      { ingestRunId: 1 }
    ),
    /every project needs an id/
  );
  assert.equal(ex.statements.length, 0, "a rejected batch must not have queried the database first");
});

test("appendChanged refuses two candidates sharing one id in the same batch", async () => {
  // Both would be compared against the same pre-batch snapshot and both
  // inserted, producing two versions of one project from a single ingest.
  const ex = scriptedExecutor();
  await assert.rejects(
    () => projectVersionsRepo(ex).appendChanged(
      [
        { project: versionProject({ id: "PRJ-1" }), hash: "h1" },
        { project: versionProject({ id: "prj-1 " }), hash: "h2" },
      ],
      { ingestRunId: 1 }
    ),
    /duplicate project ids.*PRJ-1/
  );
  assert.equal(ex.statements.length, 0, "a rejected batch must not have queried the database first");
});

test("appendChanged does its work inside a transaction", async () => {
  /* This is the point of the Task 3 review amendment: reading the newest
     hash and inserting the new row must not straddle a gap where a second,
     concurrent ingest of the same project could interleave and also decide
     the project is new. Spying on ex.tx means a future refactor that quietly
     drops the transaction fails this test instead of failing silently in
     production. */
  const ex = scriptedExecutor();
  let txCalls = 0;
  const originalTx = ex.tx.bind(ex);
  ex.tx = async (fn) => {
    txCalls += 1;
    return originalTx(fn);
  };

  const written = await projectVersionsRepo(ex).appendChanged(
    [{ project: versionProject({ id: "PRJ-TX" }), hash: "h" }],
    { ingestRunId: 1 }
  );

  assert.equal(written, 1);
  assert.equal(txCalls, 1, "appendChanged must run its read and its inserts inside one ex.tx call");
});

test("a failure partway through a batch propagates rather than returning a partial count", async () => {
  /* The scripted executor's tx(fn) is just fn(ex), so it cannot prove a real
     rollback happened -- that guarantee comes from the real sql.Transaction in
     server/db/executor.js, and Task 8 exercises it against the live database.
     What this test does pin: an error from a later insert in the batch must
     propagate out of appendChanged, not be swallowed with an early return of
     however many rows had been written so far. */
  const ex = scriptedExecutor();
  let inserts = 0;
  const originalQuery = ex.query.bind(ex);
  ex.query = async (text, params) => {
    if (text.trim().startsWith("INSERT INTO dbo.ProjectVersion")) {
      inserts += 1;
      if (inserts === 3) throw new Error("boom");
    }
    return originalQuery(text, params);
  };

  const candidates = ["PRJ-1", "PRJ-2", "PRJ-3", "PRJ-4"].map((id) => ({
    project: versionProject({ id }), hash: `h-${id}`,
  }));

  await assert.rejects(
    () => projectVersionsRepo(ex).appendChanged(candidates, { ingestRunId: 1 }),
    /boom/
  );
  assert.equal(inserts, 3, "the third insert should have thrown before a fourth was attempted");
});

test("oldestRecordedAt returns null over a genuinely empty recordset", async () => {
  /* Belt and braces: recordset[0] is undefined here, so the optional chain in
     the implementation is what keeps this from throwing. A real MIN() never
     actually returns zero rows (see the next test) but nothing enforces that
     a fake or future driver behaves the same way. */
  const ex = scriptedExecutor({ "MIN(RecordedAt)": [] });
  assert.equal(await projectVersionsRepo(ex).oldestRecordedAt(), null);
});

test("oldestRecordedAt returns null when the table is empty, matching real MIN() semantics", async () => {
  /* MIN() over zero rows is not "no rows back" -- SQL Server returns exactly
     one row whose column holds NULL, which tedious surfaces as a JS null.
     This is the shape the real database sends on day one, before any ingest
     has ever run. */
  const ex = scriptedExecutor({ "MIN(RecordedAt)": [{ oldest: null }] });
  assert.equal(await projectVersionsRepo(ex).oldestRecordedAt(), null);
});

test("oldestRecordedAt renders a recorded Date as an ISO string", async () => {
  const ex = scriptedExecutor({ "MIN(RecordedAt)": [{ oldest: new Date("2026-08-18T09:00:00Z") }] });
  assert.equal(await projectVersionsRepo(ex).oldestRecordedAt(), "2026-08-18T09:00:00.000Z");
});
