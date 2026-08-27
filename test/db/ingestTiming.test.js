import test from "node:test";
import assert from "node:assert/strict";
import { ingestRunsRepo } from "../../server/repos/ingestRuns.js";

/* Same helper as test/db/history.test.js. Note test/db/repos.test.js has a
   different one with a { recordsets } signature — do not copy that one. */
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

const quiet = { error() {}, warn() {} };

test("a finished run records how long parsing and persisting took", async () => {
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 1 }] });
  const runs = ingestRunsRepo(ex, { logger: quiet });
  const runId = await runs.start({ fileName: "master.xlsx", trigger: "watcher" });

  await runs.finish(runId, { outcome: "applied", parseMs: 42, persistMs: 1300 });

  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  assert.equal(update.params.find((p) => p.name === "parseMs").value, 42);
  assert.equal(update.params.find((p) => p.name === "persistMs").value, 1300);
});

test("durations are optional, because a rejected file never got as far as persisting", async () => {
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 2 }] });
  const runs = ingestRunsRepo(ex, { logger: quiet });
  const runId = await runs.start({ fileName: "bad.xlsx", trigger: "watcher" });

  await runs.finish(runId, { outcome: "failed", error: "could not parse: bad zip" });

  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  assert.equal(update.params.find((p) => p.name === "parseMs").value, null);
  assert.equal(update.params.find((p) => p.name === "persistMs").value, null);
});

test("a slow parse is warned about, because that is the signal worker threads were deferred on -- regression: this must not change for warm parses", async () => {
  // fileName is passed straight to finish() -- every real caller (sqlStore.js)
  // already has it in local scope, so this is what the repo actually receives,
  // not something remembered from start() several statements ago.
  const warnings = [];
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 3 }] });
  const runs = ingestRunsRepo(ex, { logger: { error() {}, warn: (m) => warnings.push(m) } });
  const runId = await runs.start({ fileName: "huge.xlsx", trigger: "watcher" });

  // coldStart omitted -- exactly what every real warm re-ingest passes, since
  // the flag ingest.js sets is only ever true for the first parse in a process.
  await runs.finish(runId, { outcome: "applied", parseMs: 6000, persistMs: 100, fileName: "huge.xlsx" });

  assert.equal(warnings.length, 1, "a six-second parse should have been noticed");
  assert.match(warnings[0], /huge\.xlsx/);
  assert.match(warnings[0], /6000/);
  assert.doesNotMatch(warnings[0], /first parse/i,
    "a warm slow-parse warning must not read like a cold-start one -- that is the whole point of the distinct wording");
});

test("a fast parse is not warned about", async () => {
  const warnings = [];
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 4 }] });
  const runs = ingestRunsRepo(ex, { logger: { error() {}, warn: (m) => warnings.push(m) } });
  const runId = await runs.start({ fileName: "small.xlsx", trigger: "watcher" });

  await runs.finish(runId, { outcome: "applied", parseMs: 40, persistMs: 900 });
  assert.deepEqual(warnings, []);
});

test("a cold-start parse under the cold threshold is not warned about, even well above SLOW_PARSE_MS", async () => {
  // 1903ms is the measured cold start on a loaded machine (see ingest.js /
  // ingestRuns.js comments) -- 15x the 128ms warm figure for the identical
  // workbook, and comfortably above SLOW_PARSE_MS=500. It must not warn.
  const warnings = [];
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 5 }] });
  const runs = ingestRunsRepo(ex, { logger: { error() {}, warn: (m) => warnings.push(m) } });
  const runId = await runs.start({ fileName: "boot.xlsx", trigger: "boot" });

  await runs.finish(runId, { outcome: "applied", parseMs: 1903, persistMs: 8068, fileName: "boot.xlsx", coldStart: true });

  assert.deepEqual(warnings, [], "a cold-start parse at the measured baseline was warned about as if it were slow");
});

test("a cold-start parse over the cold threshold IS warned about, worded so a reader knows it was the first parse", async () => {
  const warnings = [];
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 6 }] });
  const runs = ingestRunsRepo(ex, { logger: { error() {}, warn: (m) => warnings.push(m) } });
  const runId = await runs.start({ fileName: "boot-slow.xlsx", trigger: "boot" });

  // Well above the measured 1903ms cold-start baseline -- a genuine problem,
  // not warm-up, and this must still be visible even though it is the first
  // parse in the process.
  await runs.finish(runId, { outcome: "applied", parseMs: 15000, persistMs: 200, fileName: "boot-slow.xlsx", coldStart: true });

  assert.equal(warnings.length, 1, "a 15-second first parse should have been noticed");
  assert.match(warnings[0], /boot-slow\.xlsx/);
  assert.match(warnings[0], /15000/);
  assert.match(warnings[0], /first parse/i,
    "the wording must distinguish a cold-start warning from an ordinary slow-parse one");
});

test("the cold-start flag is written to dbo.IngestRun -- the parameter is bound on the UPDATE", async () => {
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 7 }] });
  const runs = ingestRunsRepo(ex, { logger: quiet });
  const runId = await runs.start({ fileName: "boot.xlsx", trigger: "boot" });

  await runs.finish(runId, { outcome: "applied", parseMs: 1903, persistMs: 8068, fileName: "boot.xlsx", coldStart: true });

  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  const bound = update.params.find((p) => p.name === "coldStart");
  assert.ok(bound, "no coldStart parameter was bound on the UPDATE -- the flag never reaches the database");
  assert.equal(bound.value, true);
});

test("a run finished without a coldStart argument is recorded as not cold-start, not left NULL", async () => {
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 8 }] });
  const runs = ingestRunsRepo(ex, { logger: quiet });
  const runId = await runs.start({ fileName: "watcher.xlsx", trigger: "watcher" });

  await runs.finish(runId, { outcome: "applied", parseMs: 128, persistMs: 2016, fileName: "watcher.xlsx" });

  const update = ex.statements.find((s) => s.text.startsWith("UPDATE dbo.IngestRun"));
  const bound = update.params.find((p) => p.name === "coldStart");
  assert.ok(bound, "no coldStart parameter was bound on the UPDATE");
  assert.equal(bound.value, false);
});

test("timings come back with the recent runs, so an operator can see a trend", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.IngestRun": [{
      IngestRunId: 9, FileName: "master.xlsx", TriggerSource: "watcher",
      StartedAt: new Date("2026-08-26T09:00:00Z"), FinishedAt: new Date("2026-08-26T09:00:02Z"),
      Outcome: "applied", ProjectsSeen: 34, ProjectsChanged: 3, PostureRows: 10,
      Error: null, ParseMs: 42, PersistMs: 1300,
    }],
  });

  const [run] = await ingestRunsRepo(ex, { logger: quiet }).recent({ limit: 5 });
  assert.equal(run.parseMs, 42);
  assert.equal(run.persistMs, 1300);
});

test("timing summary reports what the metrics endpoint needs", async () => {
  // Needled on "COUNT(*) AS runs" rather than "MAX(ParseMs)": the real query
  // now wraps ParseMs/PersistMs in a CASE excluding cold-start rows (see the
  // exclusion test below), so the literal substring "MAX(ParseMs)" no longer
  // appears. This needle identifies "the timingSummary query" without being
  // coupled to how its maxima are computed.
  const ex = scriptedExecutor({
    "COUNT(*) AS runs": [{ runs: 12, slowestParse: 900, slowestPersist: 4200, lastFinishedAt: new Date("2026-08-26T09:00:02Z") }],
  });

  const summary = await ingestRunsRepo(ex, { logger: quiet }).timingSummary();
  assert.equal(summary.runs, 12);
  assert.equal(summary.slowestParseMs, 900);
  assert.equal(summary.slowestPersistMs, 4200);
  assert.equal(summary.lastFinishedAt, "2026-08-26T09:00:02.000Z");
});

test("timing summary over an empty table is zeroes and nulls, not a crash", async () => {
  const ex = scriptedExecutor({ "COUNT(*) AS runs": [{ runs: 0, slowestParse: null, slowestPersist: null, lastFinishedAt: null }] });
  const summary = await ingestRunsRepo(ex, { logger: quiet }).timingSummary();
  assert.equal(summary.runs, 0);
  assert.equal(summary.slowestParseMs, null);
  assert.equal(summary.lastFinishedAt, null);
});

test("timing summary's maxima query excludes cold-start rows, not just any row -- a boot warm-up artefact must not pin gcio_ingest_parse_slowest_ms", async () => {
  /* Needled on the literal exclusion clause rather than on "MAX(ParseMs)" in
     general: if timingSummary() ever regressed to an unconditional MAX() over
     ParseMs/PersistMs, this needle would stop matching, the scripted executor
     would fall through to its empty-recordset default, and every assertion
     below would fail loudly (null, not the real numbers) -- the same
     mutation-sensitivity the live-DB windowing test uses for the 7-day
     window, applied here to the cold-start exclusion instead. Real exclusion
     (a genuine SQL engine ignoring rows a WHERE/CASE filters out) is proven
     against a live database in the deployment verification, not here -- this
     unit test only proves the *query asks* SQL Server to exclude them. */
  const ex = scriptedExecutor({
    "IsColdStart = 0 THEN ParseMs": [
      { runs: 9, slowestParse: 128, slowestPersist: 2016, lastFinishedAt: new Date("2026-08-27T09:00:02Z") },
    ],
  });

  const summary = await ingestRunsRepo(ex, { logger: quiet }).timingSummary();
  assert.equal(summary.slowestParseMs, 128, "the parse maximum query does not exclude cold-start rows");
  assert.equal(summary.slowestPersistMs, 2016, "the persist maximum query does not exclude cold-start rows");
});
