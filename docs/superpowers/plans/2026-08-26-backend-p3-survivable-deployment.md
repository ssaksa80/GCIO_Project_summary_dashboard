# Backend Phase 3 — A Survivable First Deployment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn "never deployed" into "deployed once, instrumented, and with a written way back". Everything an operator needs on the worst day: numbers that say what the system is doing, a restore that has actually been performed rather than assumed, and a runbook whose commands have been run.

**Architecture:** No new subsystems. One endpoint, one migration, one drill script, one preflight mode, one document. Nothing in the request path changes except the addition of `/metrics`.

**Tech Stack:** Node 24, `mssql` (tedious), SQL Server 2025 Express, NSSM, IIS with ARR, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-24-backend-production-design.md` (row P3)
**Builds on:** `v1.3.0-p2`

---

## What this phase can and cannot prove, stated up front

The build machine was checked before this plan was written:

| | |
| --- | --- |
| Elevated shell | **No** |
| NSSM on PATH | **Not installed** |
| IIS | Running |
| `sqlcmd` | Present |
| SQL Server | `APPSRV1\SQLEXPRESS`, database `GCIO`, reachable |

So the service install **cannot be executed from this session**, and not merely because of elevation — NSSM is not on the machine at all. The same is true of creating the IIS site. Any task that claimed to have "deployed it for real" would be lying.

What this phase does instead is make the parts that CAN be proven, proven, and make the parts that cannot be as short and as pre-validated as possible for whoever runs them:

- **Provable here, and proven:** `/metrics`, ingest timing, and a backup-and-restore drill that actually backs up the live database, actually restores it under a different name, actually compares the row counts, and actually cleans up.
- **Pre-validated here, executed by a human:** the service install gains a `-Preflight` mode that runs unelevated and checks everything checkable — Node, NSSM, the env file, the port, the build, the database — so the elevated step becomes one command with the surprises already removed.
- **Documented, honestly labelled:** the runbook marks every command as either *verified here* or *needs an elevated prompt, not executed*. Nothing is presented as tested when it is not.

**The rule for every task in this phase: if you cannot run it, say so in the report and mark it in the document. Do not write a runbook step you have not tried, without labelling it.**

---

## Two deliberate departures from the spec's P3 row

**Advisory-lock election and the ingest/web role split are deferred.** They prevent a failure that requires two running instances, and there is not yet one. Building an election that has never elected anything, cannot be meaningfully tested, and guards a configuration nobody has deployed is motion rather than progress. The moment a second instance is genuinely planned, this becomes the first thing to build — and the metrics added here (`gcio_ingest_runs_total`, last-ingest timestamp) are what will show a double-ingest if one ever happens.

**Worker-thread parsing is replaced by measurement.** The workbooks are 14–27 kB and parse in milliseconds; moving that to a worker pool adds real complexity to the ingest path for a load that does not exist. Instead, parse duration is recorded per ingest and exposed, with a warning past a threshold. The day a workbook is big enough to stall the event loop, that shows up as a number climbing rather than as a stalled dashboard — and it tells you when the worker pool stops being premature.

Both are recorded in the spec at Task 7, so the row closes with reasons rather than silence.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/metrics.js` | **create** — render the Prometheus text exposition from the store and repositories |
| `server/app.js` | **modify** — `GET /metrics` |
| `server/db/migrations.js` | **modify** — migration 10: ingest durations on `dbo.IngestRun` |
| `server/repos/ingestRuns.js` | **modify** — record durations; aggregate them for metrics |
| `server/store/sqlStore.js` | **modify** — time the parse and the persist |
| `server/ingest.js` | **modify** — return the parse duration it already knows |
| `scripts/backup-restore-drill.mjs` | **create** — back up, restore elsewhere, compare, clean up |
| `deploy/install-service.ps1` | **modify** — a `-Preflight` mode that runs unelevated |
| `deploy/iis-site.md` | **modify** — block `/metrics` at the proxy |
| `docs/runbook.md` | **create** — the operator's document |
| `test/api/metrics.test.js` | **create** |
| `test/db/ingestTiming.test.js` | **create** |
| `test/db/live.test.js` | **modify** |

**Commands are bash** unless marked PowerShell. Run them in Git Bash; `VAR=1 cmd` is a parse error in PowerShell, where the form is `$env:VAR = "1"; cmd`.

---

### Task 1: Record how long an ingest actually took

Measurement first, because the endpoint in Task 2 has nothing to report without it, and because this is what replaces worker-thread parsing.

**Files:**
- Modify: `server/db/migrations.js`, `server/repos/ingestRuns.js`, `server/store/sqlStore.js`, `server/ingest.js`
- Test: `test/db/ingestTiming.test.js`

- [ ] **Step 1: Write the failing test**

```js
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

  await runs.finish(runId, { outcome: "applied", fileName: "huge.xlsx", parseMs: 6000, persistMs: 100 });

  assert.equal(warnings.length, 1, "a six-second parse should have been noticed");
  assert.match(warnings[0], /huge\.xlsx/);
  assert.match(warnings[0], /6000/);
  /* The filename is passed in, not remembered: every finish() call site already
     has it in scope, and a Map keyed by run id would be state in what is
     otherwise a pure factory over an executor. */
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/db/ingestTiming.test.js`
Expected: FAIL — `parseMs` is not among the parameters, and `timingSummary` is not a function.

- [ ] **Step 3: Migration 10**

Append to `MIGRATIONS` in `server/db/migrations.js`:

```js
  {
    id: 10,
    name: "ingest_durations",
    sql: `
      /* Worker-thread parsing was deferred on the grounds that the workbooks
         are tiny. That is a measurement, and measurements expire — so record
         the measurement rather than the conclusion. When ParseMs starts
         climbing, the deferral stops being justified. */
      IF COL_LENGTH('dbo.IngestRun', 'ParseMs') IS NULL
        ALTER TABLE dbo.IngestRun ADD ParseMs INT NULL;
      IF COL_LENGTH('dbo.IngestRun', 'PersistMs') IS NULL
        ALTER TABLE dbo.IngestRun ADD PersistMs INT NULL;
    `,
  },
```

Two separate guarded `ALTER`s rather than one statement, so a half-applied
migration re-runs cleanly. Both columns are NULL-able because a run that failed
in the vault, or was rejected before parsing, never produced either number —
and a zero would be a lie.

- [ ] **Step 4: Record and read them in `server/repos/ingestRuns.js`**

Add a threshold constant beside `ERROR_MAX`:

```js
/* An event-loop stall becomes visible to a concurrent request at somewhere
   around 50-100ms, and this runs behind a proxy whose request timeout is
   shorter than a second's stall is comfortable with. 500ms is an order of
   magnitude above what today's 14-27 kB workbooks take, and well below the
   point where a request served during an ingest would fail rather than merely
   feel slow. If this starts firing, the decision to defer worker-thread
   parsing has stopped being justified. */
const SLOW_PARSE_MS = 500;
```

Extend `finish`'s options with `parseMs` and `persistMs`, add both to the
UPDATE with `sql.Int` and a null default, and warn after the write:

```js
      if (Number.isFinite(parseMs) && parseMs >= SLOW_PARSE_MS) {
        logger.warn?.(`[ingest] parsing took ${parseMs}ms — slow enough to block the event loop; ` +
          `if this becomes normal, revisit the deferred worker-thread parsing`);
      }
```

The warning must name the file. `finish` does not currently know it, so read it
back from the UPDATE's `OUTPUT INSERTED.FileName`, or pass the name through —
pick one and say which in your report; do not issue a second SELECT for it.

Add `ParseMs, PersistMs` to `recent()`'s select list and map them as
`parseMs`/`persistMs`.

Then the aggregate:

```js
    /**
     * What the metrics endpoint needs, in one query.
     * @returns {Promise<{runs: number, slowestParseMs: number|null,
     *                    slowestPersistMs: number|null, lastFinishedAt: string|null}>}
     */
    async timingSummary() {
      const { recordset } = await ex.query(`
        SELECT COUNT(*) AS runs, MAX(ParseMs) AS slowestParse,
               MAX(PersistMs) AS slowestPersist, MAX(FinishedAt) AS lastFinishedAt
        FROM dbo.IngestRun
      `);
      const r = recordset[0] || {};
      return {
        runs: Number(r.runs) || 0,
        slowestParseMs: r.slowestParse ?? null,
        slowestPersistMs: r.slowestPersist ?? null,
        lastFinishedAt: r.lastFinishedAt instanceof Date ? r.lastFinishedAt.toISOString() : null,
      };
    },
```

- [ ] **Step 5: Measure it where it happens**

`ingestBuffer` already knows how long it took to parse; it just does not say.
In `server/ingest.js`, time the parse and return it on the result:

```js
  const startedAt = performance.now();
  /* ... existing parse ... */
  return { ok: true, file, projects, posture, parseMs: Math.round(performance.now() - startedAt) };
```

Find the actual return statements — there is one for success and at least one
for failure — and add it only to the successful one. `ingestFile` spreads the
result, so it carries through.

In `server/store/sqlStore.js`'s `applyFile`, time the persistence and pass both
to `finish`. The persist clock starts after the vault write and stops before
`refresh()`, because refreshing the read model is not part of persisting:

```js
      const persistStartedAt = performance.now();
      /* ... replaceForFile, appendChanged ... */
      const persistMs = Math.round(performance.now() - persistStartedAt);
```

and add `parseMs: result.parseMs ?? null, persistMs` to the `applied` call to
`finish`. Leave the `unchanged` and `failed` calls without them — an unchanged
file did no persisting, and a failed one has no honest number to report.

- [ ] **Step 6: Run the tests**

Run: `node --test test/db/ingestTiming.test.js test/db/history.test.js test/db/sqlStoreHistory.test.js`
Expected: PASS.

Then `npm test`. The whole suite must stay green.

- [ ] **Step 7: Apply the migration live**

Run: `DB_LIVE=1 npm run test:db`
Expected: PASS, subtests visibly RUN rather than skipped. Confirm migration 10
applied and re-applying is a no-op by running it twice.

The live suite asserts the history tables keep the indexes and constraints they
were given. Check whether it also pins `dbo.IngestRun`'s column list; if it
does, extend it rather than loosening it.

- [ ] **Step 8: Commit**

```bash
git add server/db/migrations.js server/repos/ingestRuns.js server/store/sqlStore.js server/ingest.js test/db/ingestTiming.test.js
git commit -m "feat(ingest): record how long parsing and persisting took"
```

---

### Task 2: `/metrics`

**Files:**
- Create: `server/metrics.js`
- Modify: `server/app.js`, `deploy/iis-site.md`
- Test: `test/api/metrics.test.js`

- [ ] **Step 1: Decide the exposure posture, and write it down**

`/metrics` is **open**, like `/healthz` and `/readyz`, because a scraper cannot
easily authenticate and an operator will not add one. That is only acceptable
because of what it does and does not contain:

- **Contains:** counts, timings, timestamps, an up flag, build version.
- **Never contains:** a project name, a person, a filename, a department, an
  error message. No label may carry a value read from a workbook.

The endpoint is therefore blocked at the proxy so it is reachable from the
monitoring host and not from the organisation. `deploy/iis-site.md` gains a rule
in the same section as the other route rules:

```xml
<rule name="Block metrics from outside" stopProcessing="true">
  <match url="^metrics$" />
  <conditions>
    <add input="{REMOTE_ADDR}" pattern="^10\.|^127\.0\.0\.1$" negate="true" />
  </conditions>
  <action type="CustomResponse" statusCode="404" statusReason="Not Found" />
</rule>
```

Adapt the address pattern to the monitoring network; do not invent a range —
write it as a placeholder the operator must set, and say so in the prose.

- [ ] **Step 2: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { renderMetrics } from "../../server/metrics.js";

const store = (over = {}) => ({
  projectCount: 34, fileCount: 3, ready: true, demoMode: false,
  lastIngestAt: "2026-08-26T09:00:02.000Z",
  ...over,
});

test("the exposition parses as Prometheus text", async () => {
  const body = await renderMetrics({ store: store(), startedAt: Date.now() - 60_000 });

  for (const line of body.trim().split("\n")) {
    assert.match(line, /^(#\s|[a-z_]+(\{[^}]*\})?\s-?[0-9.e+]+$)/,
      `not a valid exposition line: ${line}`);
  }
  assert.match(body, /^# HELP gcio_up /m);
  assert.match(body, /^# TYPE gcio_up gauge$/m);
  assert.match(body, /^gcio_up 1$/m);
});

test("it reports the portfolio the dashboard is actually serving", async () => {
  const body = await renderMetrics({ store: store(), startedAt: Date.now() });
  assert.match(body, /^gcio_projects 34$/m);
  assert.match(body, /^gcio_source_files 3$/m);
});

test("no series and no label carries anything read from a workbook", async () => {
  /* The endpoint is open at the app and blocked at the proxy. That is only
     safe while it holds nothing but numbers. */
  const body = await renderMetrics({
    store: store(),
    startedAt: Date.now(),
    ingestTiming: { runs: 5, slowestParseMs: 60, slowestPersistMs: 1200, lastFinishedAt: "2026-08-26T09:00:02.000Z" },
    runOutcomes: { applied: 4, unchanged: 1, failed: 0, removed: 0 },
  });

  for (const forbidden of ["master.xlsx", "PRJ-", "Cybersecurity", "@"]) {
    assert.ok(!body.includes(forbidden), `the exposition leaked ${forbidden}`);
  }
  /* Only the outcome vocabulary may appear as a label value. */
  const labels = [...body.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
  for (const label of labels) {
    assert.match(label, /^(outcome="(applied|unchanged|failed|removed)"|version="[0-9a-zA-Z.\-+]+")$/,
      `unexpected label: ${label}`);
  }
});

test("run outcomes are one series per outcome, including the zeroes", async () => {
  /* A missing series and a zero read very differently on a graph: one is a
     gap, the other is "nothing failed". Always emit all four. */
  const body = await renderMetrics({
    store: store(), startedAt: Date.now(),
    runOutcomes: { applied: 4, unchanged: 1, failed: 0, removed: 0 },
  });

  for (const outcome of ["applied", "unchanged", "failed", "removed"]) {
    assert.match(body, new RegExp(`^gcio_ingest_runs\\{outcome="${outcome}"\\} \\d+$`, "m"));
  }
});

test("timings appear when history is available and are simply absent when it is not", async () => {
  const withHistory = await renderMetrics({
    store: store(), startedAt: Date.now(),
    ingestTiming: { runs: 5, slowestParseMs: 60, slowestPersistMs: 1200, lastFinishedAt: "2026-08-26T09:00:02.000Z" },
  });
  assert.match(withHistory, /^gcio_ingest_parse_slowest_ms 60$/m);

  const without = await renderMetrics({ store: store(), startedAt: Date.now() });
  assert.ok(!without.includes("gcio_ingest_parse_slowest_ms"),
    "a series was emitted with no data behind it");
  /* But the endpoint still works and still says the app is up. */
  assert.match(without, /^gcio_up 1$/m);
});

test("a store that is not ready says so rather than omitting the series", async () => {
  const body = await renderMetrics({ store: store({ ready: false }), startedAt: Date.now() });
  assert.match(body, /^gcio_ready 0$/m);
});

test("demo mode is visible, because a demo dashboard in production is worth an alert", async () => {
  const body = await renderMetrics({ store: store({ demoMode: true }), startedAt: Date.now() });
  assert.match(body, /^gcio_demo_mode 1$/m);
});

test("uptime is seconds, not milliseconds", async () => {
  const body = await renderMetrics({ store: store(), startedAt: Date.now() - 90_000 });
  const uptime = Number(body.match(/^gcio_uptime_seconds ([0-9.]+)$/m)[1]);
  assert.ok(uptime >= 89 && uptime <= 92, `uptime looks wrong: ${uptime}`);
});
```

- [ ] **Step 3: Implement `server/metrics.js`**

```js
/**
 * Prometheus text exposition.
 *
 * Open at the application and blocked at the proxy, which is only defensible
 * while this holds nothing but numbers: no project name, no person, no
 * filename, no error text, and no label value read from a workbook. A test
 * enforces that; do not add a series that would break it.
 *
 * Everything here is read from what the app already knows. Nothing is computed
 * that the dashboard does not already compute, and a failure to read the
 * optional parts degrades to omitting them rather than failing the scrape —
 * monitoring that goes dark when the database does is worse than useless.
 */

const OUTCOMES = ["applied", "unchanged", "failed", "removed"];

const line = (name, value, labels = "") =>
  `${name}${labels ? `{${labels}}` : ""} ${value}`;

function series(out, name, help, type, rows) {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows);
}

/**
 * @param {{store: object, startedAt: number, version?: string,
 *          ingestTiming?: object|null, runOutcomes?: object|null}} input
 * @returns {Promise<string>} the exposition body
 */
export async function renderMetrics({ store, startedAt, version = "unknown", ingestTiming = null, runOutcomes = null }) {
  const out = [];

  series(out, "gcio_up", "1 when the process is serving.", "gauge", [line("gcio_up", 1)]);
  series(out, "gcio_build_info", "Build version, as a label on a constant 1.", "gauge",
    [line("gcio_build_info", 1, `version="${version}"`)]);
  series(out, "gcio_uptime_seconds", "Seconds since the process started.", "gauge",
    [line("gcio_uptime_seconds", Math.round((Date.now() - startedAt) / 1000))]);

  series(out, "gcio_ready", "1 when there is a portfolio to serve.", "gauge",
    [line("gcio_ready", store.ready ? 1 : 0)]);
  series(out, "gcio_demo_mode", "1 when serving bundled sample data rather than real workbooks.", "gauge",
    [line("gcio_demo_mode", store.demoMode ? 1 : 0)]);

  series(out, "gcio_projects", "Projects currently served.", "gauge",
    [line("gcio_projects", store.projectCount ?? 0)]);
  series(out, "gcio_source_files", "Workbooks currently contributing to the portfolio.", "gauge",
    [line("gcio_source_files", store.fileCount ?? 0)]);

  if (store.lastIngestAt) {
    series(out, "gcio_last_ingest_timestamp_seconds", "When the portfolio last changed.", "gauge",
      [line("gcio_last_ingest_timestamp_seconds", Math.round(Date.parse(store.lastIngestAt) / 1000))]);
  }

  if (runOutcomes) {
    /* All four, always — a missing series is a gap on a graph, a zero is
       "nothing failed", and those must not look the same. */
    series(out, "gcio_ingest_runs", "Ingest attempts by outcome.", "counter",
      OUTCOMES.map((o) => line("gcio_ingest_runs", runOutcomes[o] ?? 0, `outcome="${o}"`)));
  }

  if (ingestTiming) {
    if (ingestTiming.slowestParseMs !== null) {
      series(out, "gcio_ingest_parse_slowest_ms", "Slowest recorded workbook parse.", "gauge",
        [line("gcio_ingest_parse_slowest_ms", ingestTiming.slowestParseMs)]);
    }
    if (ingestTiming.slowestPersistMs !== null) {
      series(out, "gcio_ingest_persist_slowest_ms", "Slowest recorded persist.", "gauge",
        [line("gcio_ingest_persist_slowest_ms", ingestTiming.slowestPersistMs)]);
    }
  }

  return `${out.join("\n")}\n`;
}
```

- [ ] **Step 4: Serve it in `server/app.js`**

Beside `/healthz` and `/readyz`, which are already open:

```js
  /**
   * Operational numbers for a scraper. Open like the health endpoints, because
   * a scraper cannot authenticate — and safe to be open only because it holds
   * nothing read from a workbook. Block it at the proxy; see deploy/iis-site.md.
   */
  app.get("/metrics", wrap(async (req, res) => {
    /* Optional parts degrade rather than fail: monitoring that goes dark when
       the database does is worse than no monitoring. */
    let ingestTiming = null;
    let runOutcomes = null;
    if (ingestRuns) {
      try {
        [ingestTiming, runOutcomes] = await Promise.all([
          ingestRuns.timingSummary(),
          ingestRuns.countByOutcome(),
        ]);
      } catch (err) {
        console.error(`[metrics] history unavailable: ${err.message}`);
      }
    }

    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(await renderMetrics({ store, startedAt, version: config.version, ingestTiming, runOutcomes }));
  }));
```

`startedAt` does not exist yet — capture `Date.now()` once at the top of
`createApp`. `config.version` does not exist either; read it from
`package.json` in `server/config.js` and default to `"unknown"`. `countByOutcome`
is a small addition to `ingestRuns`: `SELECT Outcome, COUNT(*) ... GROUP BY
Outcome`, returned as a plain object, with the four keys always present.

Add tests to `test/api/metrics.test.js` for the route as well as the renderer:
an anonymous request succeeds (it is open), the content type is the exposition
type, and a store whose `ingestRuns.timingSummary` throws still returns 200 with
the base series.

- [ ] **Step 5: Run the tests**

Run: `node --test test/api/metrics.test.js` then `npm test`.

- [ ] **Step 6: Look at it**

```bash
STORE=memory AUTH_MODE=dev DEV_ROLE=admin PORT=8199 node server/index.js
```

```bash
curl -s localhost:8199/metrics
```

Read the output. Confirm every line is either a comment or `name value`, that
nothing in it names a project, and that it is reachable without signing in.
Kill the server.

- [ ] **Step 7: Commit**

```bash
git add server/metrics.js server/app.js server/config.js server/repos/ingestRuns.js deploy/iis-site.md test/api/metrics.test.js
git commit -m "feat(ops): expose operational metrics, and block them at the proxy"
```

---

### Task 3: A restore that has actually been performed

The most valuable task in the phase, and the one most often written as a
document and never executed. This one executes.

**Files:**
- Create: `scripts/backup-restore-drill.mjs`
- Test: exercised by running it; a hermetic test covers its argument handling only

- [ ] **Step 1: Establish that it is even permitted**

Before writing the script, find out whether the application's SQL login can
back up and restore at all. `gcio_app` was granted `dbcreator`; `BACKUP
DATABASE` additionally needs `db_backupoperator` or ownership, and `RESTORE`
needs `dbcreator` plus permission on the target.

Run this and paste the result:

```bash
sqlcmd -S "APPSRV1\SQLEXPRESS" -d GCIO -E -C -W -Q "SELECT IS_ROLEMEMBER('db_owner') AS db_owner, IS_ROLEMEMBER('db_backupoperator') AS backup_op, IS_SRVROLEMEMBER('dbcreator') AS dbcreator, SUSER_SNAME() AS who"
```

Note `-E` uses Windows authentication for your interactive shell, which is not
how the app connects. Run it a second time as the application login using the
credentials in `.env` (`-U`/`-P`) and compare — **the drill must be runnable as
whoever will actually run it in production**, and if the app login cannot back
up, that is a finding for the runbook, not something to work around by using
your own account.

If neither can, stop and report. A drill that only works as a domain admin
sitting at the console is not a drill.

- [ ] **Step 2: Write the drill**

`scripts/backup-restore-drill.mjs`. Written to be read by an operator at three
in the morning: one line per step, saying what it is about to do and what
happened.

The skeleton below is the shape and the SQL. Fill in the connection handling
from `server/db/pool.js`'s `buildConfig` so the drill runs as whoever the
application runs as, and adapt anything step 1 showed to be different.

```js
/**
 * Back up the live database, restore it under a different name, prove the
 * restored copy holds what the original held, and clean up.
 *
 * A restore procedure nobody has performed is a hope, not a plan. This exists
 * to be run — on a schedule, and before anything anyone is nervous about.
 *
 *   node scripts/backup-restore-drill.mjs [--to DIR] [--as NAME] [--keep]
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sql from "mssql";
import { buildConfig } from "../server/db/pool.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const TABLES = ["Project", "ProjectChild", "PostureDomain",
                "ProjectVersion", "SourceFile", "IngestRun", "AuditEvent"];

const config = buildConfig(process.env);
const source = config.database;
const target = flag("as", "GCIO_DrillRestore");
const backupDir = flag("to", os.tmpdir());
const keep = args.includes("--keep");

/* It restores and drops a database. A typo in --as must not be able to do
   that to production. */
if (process.env.NODE_ENV === "production" && !args.includes("--i-mean-it")) {
  console.error("refusing to run against NODE_ENV=production without --i-mean-it");
  process.exit(1);
}
if (target.toLowerCase() === source.toLowerCase()) {
  console.error(`refusing to restore over the source database (${source})`);
  process.exit(1);
}

const say = (step, message) => console.log(`[drill] ${step}  ${message}`);
let failures = 0;

/* master, because a database being restored cannot be the one in use. */
const pool = await new sql.ConnectionPool({ ...config, database: "master" }).connect();
const q = async (text) => (await pool.request().query(text)).recordset;

say("target", `backing up ${source}, restoring as ${target}`);

/* ---- 1. what is in it now -------------------------------------------- */
const before = {};
for (const t of TABLES) {
  const [row] = await q(`SELECT COUNT(*) AS n FROM [${source}].dbo.[${t}]`);
  before[t] = row.n;
}
say("before", TABLES.map((t) => `${t}=${before[t]}`).join(" "));

/* ---- 2. back up ------------------------------------------------------ */
/* COPY_ONLY so the drill does not disturb the real backup chain: without it a
   differential taken afterwards would be relative to this one. */
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(backupDir, `${source}-drill-${stamp}.bak`);
await q(`BACKUP DATABASE [${source}] TO DISK = N'${backupFile}' WITH INIT, COPY_ONLY, STATS = 10`);
const bytes = fs.statSync(backupFile).size;
say("backup", `${backupFile} — ${(bytes / 1024 / 1024).toFixed(1)} MB`);
if (bytes < 1024) { console.error("[drill] backup is implausibly small"); failures += 1; }

/* ---- 3. restore elsewhere -------------------------------------------- */
/* WITH MOVE, because the copy cannot occupy the source's files. The logical
   names are read out of the backup rather than assumed, so this works on a
   database the script did not create. */
const files = await q(`RESTORE FILELISTONLY FROM DISK = N'${backupFile}'`);
const moves = files.map((f) => {
  const ext = f.Type === "L" ? "_log.ldf" : ".mdf";
  return `MOVE N'${f.LogicalName}' TO N'${path.join(backupDir, target + "-" + f.LogicalName + ext)}'`;
}).join(", ");

await q(`RESTORE DATABASE [${target}] FROM DISK = N'${backupFile}' WITH ${moves}, REPLACE, RECOVERY`);
say("restore", `${target} online`);

/* ---- 4. does it hold what the original held? ------------------------- */
for (const t of TABLES) {
  const [row] = await q(`SELECT COUNT(*) AS n FROM [${target}].dbo.[${t}]`);
  if (row.n !== before[t]) {
    console.error(`[drill] MISMATCH ${t}: source ${before[t]}, restored ${row.n}`);
    failures += 1;
  }
}
say("compare", failures ? `${failures} table(s) did not match` : "every table matched");

/* ---- 5. the vault, which the database cannot rebuild ----------------- */
/* A restored database pointing at workbooks nobody kept is not a recovery. */
const vaultDir = path.resolve(process.env.VAULT_DIR || "vault");
const vaulted = await q(`SELECT VaultPath FROM [${target}].dbo.SourceFile WHERE VaultPath IS NOT NULL`);
const missing = vaulted.filter((r) => !fs.existsSync(path.join(vaultDir, r.VaultPath)));
if (missing.length) {
  console.error(`[drill] ${missing.length} vaulted workbook(s) recorded but absent from ${vaultDir}`);
  failures += 1;
}
say("vault", `${vaulted.length} recorded, ${missing.length} missing`);

/* ---- 6. leave nothing behind ----------------------------------------- */
if (keep) {
  say("keep", `left ${target} and ${backupFile} in place`);
} else {
  await q(`ALTER DATABASE [${target}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
  await q(`DROP DATABASE [${target}]`);
  fs.rmSync(backupFile, { force: true });
  const [still] = await q(`SELECT COUNT(*) AS n FROM sys.databases WHERE name = '${target}'`);
  if (still.n !== 0) { console.error(`[drill] ${target} still exists after DROP`); failures += 1; }
  say("cleanup", "scratch database dropped, backup file deleted");
}

await pool.close();
console.log(failures ? `[drill] FAILED — ${failures} problem(s)` : "[drill] PASSED");
process.exit(failures ? 1 : 0);
```

- [ ] **Step 3: Run it, for real, against the live database**

```bash
node scripts/backup-restore-drill.mjs
```

Paste the entire output into your report. This is the deliverable — not the
script, the successful run.

Then run it a second time, to prove the scratch database being left over from a
previous run is handled rather than fatal.

- [ ] **Step 4: Prove it fails when it should**

A drill that cannot fail proves nothing. Verify at least one failure path:
point `--as` at the source database name and confirm it refuses; or restore,
delete a row from the scratch copy, and confirm the comparison reports the
mismatch and exits non-zero. Say which you did and paste the output.

- [ ] **Step 5: Leave the database as you found it**

Confirm `GCIO_DrillRestore` does not exist, no backup file remains, and the
source row counts are unchanged.

- [ ] **Step 6: Commit**

```bash
git add scripts/backup-restore-drill.mjs
git commit -m "feat(ops): a backup and restore drill that has actually been run"
```

---

### Task 4: Make the service install checkable without elevation

**Files:**
- Modify: `deploy/install-service.ps1`

- [ ] **Step 1: Read it first**

`deploy/install-service.ps1` is 162 lines and already refuses `AUTH_MODE=dev`.
Read all of it. The goal is NOT to restructure it — it is to add a mode that
performs every check it already performs, plus the ones below, and then stops
before changing anything.

- [ ] **Step 2: Add `-Preflight`**

A switch parameter. When present:

- Skip the administrator check — the whole point is that this runs unelevated.
- Report, as a checklist with a clear pass or fail per line:
  - Node is on PATH, and its version is 20 or newer
  - NSSM is on PATH (**expected to FAIL on this machine — it is not installed**)
  - The env file exists, is readable, and every line parses as `NAME=VALUE`
  - `STORE`, `AUTH_MODE` and, when `STORE=mssql`, the database variables are present
  - `AUTH_MODE` is not `dev`
  - The configured `PORT` is free
  - `client/dist/index.html` exists — the service will serve a 503 page without it
  - `VAULT_DIR` and `AUDIT_DIR` are writable
  - The database is reachable with the credentials in the env file
- Exit 0 when everything passes, 1 when anything fails, and print a one-line
  summary saying how many checks failed.
- Change nothing. No service is created, stopped, or removed.

The database check should reuse the application's own configuration rather than
a hand-written connection string, so a preflight pass means the app's own
`buildConfig` agrees. Invoking `node scripts/db-check.mjs` and reading its exit
code is the honest way to do that; do not reimplement the connection logic in
PowerShell.

- [ ] **Step 3: Run it**

```
powershell -NoProfile -File .\deploy\install-service.ps1 -Preflight
```

It will fail on NSSM. **That is the correct result** and it is the point: the
preflight tells an operator exactly what to install before they open an elevated
prompt, instead of finding out halfway through a privileged script.

Paste the full output. Confirm the exit code is 1, that NSSM is the reason, and
that every other check either passed or failed for a stated reason.

- [ ] **Step 4: Confirm it changed nothing**

```
powershell -NoProfile -Command "Get-Service GCIOProjectIntelligence -ErrorAction SilentlyContinue"
```

Expected: nothing. The service must not exist.

- [ ] **Step 5: Parse-check the whole script**

```
powershell -NoProfile -Command "[System.Management.Automation.Language.Parser]::ParseFile('deploy/install-service.ps1', [ref]$null, [ref]$null) | Out-Null; 'parses'"
```

The install path is not executable here, so a syntax error in it would go
unnoticed until the worst possible moment.

- [ ] **Step 6: Commit**

```bash
git add deploy/install-service.ps1
git commit -m "feat(deploy): a preflight that runs before anyone opens an elevated prompt"
```

---

### Task 5: The runbook

**Files:**
- Create: `docs/runbook.md`
- Modify: `README.md` — one line pointing at it

- [ ] **Step 1: Write it**

`docs/runbook.md`, for someone who did not build this and is reading it because
something is wrong. Sections:

1. **What this is and where it runs** — the process, the database, the drop
   folder, the vault, and which machine.
2. **First deployment** — in order, with every command. Mark each step
   **[verified]** or **[needs an elevated prompt — not executed]**. The preflight
   from Task 4 is step one, and installing NSSM is step zero.
3. **Upgrading** — the install script is re-runnable; say so and say what it
   preserves.
4. **The dashboard is stale** — the diagnosis path, in the order an operator
   should actually try things: `/readyz`, then `GET /api/ingest/runs` (what it
   means when a file is absent entirely versus present with an outcome), then
   the server log's `rejected <file>` line, then the watcher, then the drop
   folder's permissions.
5. **The dashboard is down** — `/healthz`, the service state, the log location,
   the database.
6. **Backup and restore** — the drill script, what it proves, how often to run
   it, and the manual restore procedure for a real recovery, which is not the
   same thing as the drill: a real restore goes over the top of the source
   database and needs the vault restored alongside it.
7. **What the metrics mean** — each series, and the two or three that are worth
   alerting on. Say plainly which alert would have caught each failure this
   project has actually had: a stale portfolio, a failed ingest, a demo-mode
   dashboard left running in production.
8. **Known limitations** — one instance only and why (the election is deferred);
   parsing is on the event loop and the number to watch; the endpoint comparison
   limit from Phase 2.

- [ ] **Step 2: Verify every command in it**

Go through the document and run every command marked **[verified]**. If one does
not work as written, fix the document rather than the label. Anything you cannot
run gets **[needs an elevated prompt — not executed]** and a note saying what it
is expected to output, so the operator knows whether it worked.

Paste, in your report, the list of commands you ran and their results.

- [ ] **Step 3: Commit**

```bash
git add docs/runbook.md README.md
git commit -m "docs: a runbook whose verified commands have been run"
```

---

### Task 6: Prove the new surface against real SQL

**Files:**
- Modify: `test/db/live.test.js`

- [ ] **Step 1: Add the subtests**

Inside the existing live block, before "the suite leaves nothing behind". Follow
the file's conventions: `livetest%` naming, per-subtest id namespacing, and
extend `cleanup()` and the leaves-nothing-behind assertions for anything new.

- Migration 10 applied, and `dbo.IngestRun` has `ParseMs` and `PersistMs` as
  nullable `int`.
- A run finished with durations reads them back through `recent()`.
- `timingSummary()` over real rows returns the largest of each and the latest
  finish time, and over an empty table returns zeroes and nulls rather than
  throwing.
- `countByOutcome()` returns all four keys even when only one outcome has
  occurred.
- A real ingest through `SqlStore.applyFile` records a `ParseMs` and a
  `PersistMs` that are both numbers and both plausible — greater than zero and
  less than a minute. This is the one that proves the instrumentation is wired
  rather than merely present.

- [ ] **Step 2: Run it twice**

```bash
DB_LIVE=1 npm run test:db
```

Confirm the subtests RAN rather than skipped, both times, and that the tables
are back to zero afterwards.

- [ ] **Step 3: Commit**

```bash
git add test/db/live.test.js
git commit -m "test(db): live proof of the ingest timing surface"
```

---

### Task 7: Close out

- [ ] **Step 1: Run everything**

```bash
npm test
DB_LIVE=1 npm run test:db
npm run build
node scripts/backup-restore-drill.mjs
powershell -NoProfile -File .\deploy\install-service.ps1 -Preflight
```

The last is expected to exit 1 on NSSM. Everything else must pass.

- [ ] **Step 2: Mark the spec**

Update the P3 row to what was built. State the two deferrals as decisions with
reasons — the election because it guards a failure that needs two instances and
there are not two instances, and worker-thread parsing because the workbooks are
14–27 kB and the measurement is now recorded so the decision can be revisited on
evidence. Add a line to the Risks section: **the service has still never been
installed**, and until it is, "deployed" means a process someone started by
hand.

- [ ] **Step 3: Commit and tag**

```bash
git add docs/superpowers/specs/2026-08-24-backend-production-design.md
git commit -m "docs: Phase 3 — instrumented, drilled, and documented"
git tag -a v1.4.0-p3 -m "Phase 3: a survivable first deployment"
```

---

## Self-review against the spec

| Spec P3 requirement | Where |
| --- | --- |
| Metrics | Task 2 |
| Backup/restore drill | Task 3 — executed, not just written |
| Runbook | Task 5 |
| Role split | **Deferred.** Guards a failure requiring two instances; there is one |
| Advisory-lock election | **Deferred**, same reason. Task 2's metrics would reveal a double ingest if one ever occurred |
| Worker-thread parsing | **Replaced by measurement**, Task 1. The workbooks are 14–27 kB; the number to watch is now recorded and warned on |

**The honesty rule, restated because it is the one this phase can most easily
break:** a runbook step that has not been run is labelled as such, and a drill
that has not been executed is not a drill. If a task cannot be completed on this
machine, the report says so and the document says so. Nothing in this phase is
allowed to read as tested when it is not.

**Not in this phase:** the election, the role split, worker threads, trends,
question ageing, and the actual elevated installation — which needs NSSM on the
machine and a human at an administrator prompt.
