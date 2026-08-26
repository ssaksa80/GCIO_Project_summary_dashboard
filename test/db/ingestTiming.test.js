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

test("a slow parse is warned about, because that is the signal worker threads were deferred on", async () => {
  const warnings = [];
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 3 }] });
  const runs = ingestRunsRepo(ex, { logger: { error() {}, warn: (m) => warnings.push(m) } });
  const runId = await runs.start({ fileName: "huge.xlsx", trigger: "watcher" });

  await runs.finish(runId, { outcome: "applied", parseMs: 6000, persistMs: 100 });

  assert.equal(warnings.length, 1, "a six-second parse should have been noticed");
  assert.match(warnings[0], /huge\.xlsx/);
  assert.match(warnings[0], /6000/);
});

test("a fast parse is not warned about", async () => {
  const warnings = [];
  const ex = scriptedExecutor({ "INSERT INTO dbo.IngestRun": [{ IngestRunId: 4 }] });
  const runs = ingestRunsRepo(ex, { logger: { error() {}, warn: (m) => warnings.push(m) } });
  const runId = await runs.start({ fileName: "small.xlsx", trigger: "watcher" });

  await runs.finish(runId, { outcome: "applied", parseMs: 40, persistMs: 900 });
  assert.deepEqual(warnings, []);
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
  const ex = scriptedExecutor({
    "MAX(ParseMs)": [{ runs: 12, slowestParse: 900, slowestPersist: 4200, lastFinishedAt: new Date("2026-08-26T09:00:02Z") }],
  });

  const summary = await ingestRunsRepo(ex, { logger: quiet }).timingSummary();
  assert.equal(summary.runs, 12);
  assert.equal(summary.slowestParseMs, 900);
  assert.equal(summary.slowestPersistMs, 4200);
  assert.equal(summary.lastFinishedAt, "2026-08-26T09:00:02.000Z");
});

test("timing summary over an empty table is zeroes and nulls, not a crash", async () => {
  const ex = scriptedExecutor({ "MAX(ParseMs)": [{ runs: 0, slowestParse: null, slowestPersist: null, lastFinishedAt: null }] });
  const summary = await ingestRunsRepo(ex, { logger: quiet }).timingSummary();
  assert.equal(summary.runs, 0);
  assert.equal(summary.slowestParseMs, null);
  assert.equal(summary.lastFinishedAt, null);
});
