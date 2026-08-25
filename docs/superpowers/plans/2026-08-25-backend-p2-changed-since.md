# Backend Phase 2 — What Changed Since Last Week

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the briefing say what moved. Every item the CIO reads should carry, where the history knows, what it looked like at the start of the period and what it looks like now — sourced from `ProjectVersion`, not from file dates.

**Architecture:** `buildSections` stays synchronous and pure. History arrives as data, exactly the way `postureRows` already does: one async call at the edge fetches a `Map` of project id → what changed, and a single `annotateChanges` pass decorates any item carrying an `id`. No section builder is rewritten, and with `STORE=memory` — or a database with no history yet — every builder produces precisely what it produces today.

**Tech Stack:** Node 24, `mssql` (tedious), `node:test` + `supertest`, React 18, SQL Server 2025.

**Spec:** `docs/superpowers/specs/2026-08-24-backend-production-design.md` (row P2)
**Builds on:** `docs/superpowers/plans/2026-08-25-backend-p1-history-foundation.md`, delivered as `v1.2.0-p1`

**Decisions taken before writing this plan:**

- **Scope is "changed since" only.** Trend lines and question ageing are the spec's other two P2 items and are deliberately NOT here. Both need months of accumulated history to say anything true; "what changed" works from two versions. This ships the thing the CIO actually asked for and proves the history is trustworthy before more is built on it.
- **Degrade honestly, never fabricate.** `dbo.ProjectVersion` holds zero rows today — history begins accumulating at the next ingest. So a project with no recorded baseline says so ("tracked since 25 Aug") rather than showing a fabricated "no change". Backfilling synthetic versions from `lastUpdated` was considered and rejected: a Red that has been Red for months would show as one day old, and nobody could ever separate invented rows from real ones. The feature is thin on day one and fills itself in. That is the correct behaviour, not a limitation to work around.

---

## The one thing most likely to go wrong

`buildSummary` and `buildSections` are synchronous, pure and heavily tested. Reading history is asynchronous. The tempting move is to make the engine async — and it would ripple through every builder, every exporter and roughly forty tests, for no gain.

Do not. The pattern already exists in the codebase: `store.posture()` returns an in-memory read model that the store refreshes, and `buildSections` receives it as a plain argument. History follows the same shape, with one difference — the baseline depends on the period the caller asked for, so it cannot be cached at ingest time. It is fetched once per request, at the route, and handed in.

If a task in this plan seems to require making a section builder async, stop and report it. Something has been misread.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/repos/projectVersions.js` | **modify** — add `changedSince(sinceISO)`: the baseline and current version of every project that moved |
| `server/db/migrations.js` | **modify** — migration 9 widens `IX_ProjectVersion_Project` to cover what `changedSince` selects |
| `server/store/sqlStore.js` | **modify** — `changesSince(sinceISO)` returning the annotation Map; `historyStartedAt()` |
| `server/store.js` | **modify** — the in-memory store answers "no history" honestly rather than not answering |
| `server/changes.js` | **create** — the comparison itself: which fields moved, and how to describe the move |
| `server/summarize.js` | **modify** — `loadChanges(store, period, dateISO)` at the edge; `buildSummary(..., { changes })` |
| `server/sections.js` | **modify** — `annotateChanges(sections, changes)`, one pass, no builder rewritten |
| `server/app.js` | **modify** — `/api/summary` and `/api/export/:format` load changes before building |
| `server/exporters/{pptx,word,excel,html}.js` | **modify** — render the change markers |
| `client/src/components/ChangeBadge.jsx` | **create** — the visual marker |
| `client/src/components/Section*.jsx` | **modify** — render the badge |
| `test/domain/changes.test.js` | **create** |
| `test/db/changedSince.test.js` | **create** |
| `test/domain/annotate.test.js` | **create** |
| `test/api/app.test.js` | **modify** |
| `test/db/live.test.js` | **modify** |

**Commands are bash.** Run them in Git Bash, not PowerShell, where `VAR=1 cmd` is a parse error. The PowerShell form is `$env:DB_LIVE = "1"; npm run test:db`.

---

### Task 1: What counts as a change, and how to say it

Before any SQL, decide the vocabulary. This is pure logic over two version rows and belongs in its own module so the SQL layer and the section layer both depend on it rather than on each other.

**Files:**
- Create: `server/changes.js`
- Test: `test/domain/changes.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, TRACKED_FIELDS } from "../../server/changes.js";

const version = (over = {}) => ({
  recordedAt: "2026-08-18T09:00:00.000Z",
  status: "In Progress", health: "Green", percentComplete: 40,
  budget: 1000, spent: 300, openRisks: 1, openQuestions: 0,
  targetEndDate: "2026-06-30",
  ...over,
});

test("two identical versions are not a change", () => {
  assert.equal(compareVersions(version(), version()), null);
});

test("a health move is reported with both ends and a direction", () => {
  const change = compareVersions(version({ health: "Green" }), version({ health: "Red" }));
  assert.equal(change.fields.health.from, "Green");
  assert.equal(change.fields.health.to, "Red");
  assert.equal(change.fields.health.direction, "worse");
  assert.equal(change.headline, "health Green to Red");
});

test("health improving is reported as better", () => {
  const change = compareVersions(version({ health: "Red" }), version({ health: "Amber" }));
  assert.equal(change.fields.health.direction, "better");
});

test("a slipped target date is worse; pulling it in is better", () => {
  const slipped = compareVersions(version(), version({ targetEndDate: "2026-09-30" }));
  assert.equal(slipped.fields.targetEndDate.direction, "worse");
  assert.equal(slipped.fields.targetEndDate.days, 92);

  const pulled = compareVersions(version(), version({ targetEndDate: "2026-05-31" }));
  assert.equal(pulled.fields.targetEndDate.direction, "better");
  assert.equal(pulled.fields.targetEndDate.days, -30);
});

test("progress going backwards is worse, which is the interesting case", () => {
  const backwards = compareVersions(version({ percentComplete: 60 }), version({ percentComplete: 45 }));
  assert.equal(backwards.fields.percentComplete.direction, "worse");
  assert.equal(backwards.fields.percentComplete.delta, -15);
});

test("the headline names the most consequential move, not the first one found", () => {
  /* Health outranks everything: it is the column the CIO reads first. */
  const many = compareVersions(
    version({ health: "Green", percentComplete: 40, openRisks: 1 }),
    version({ health: "Red", percentComplete: 55, openRisks: 4 })
  );
  assert.match(many.headline, /^health/);
  assert.equal(Object.keys(many.fields).length, 3);
});

test("a change with no tracked field moving is not a change at all", () => {
  /* recordedAt always differs between two rows; it must not count. */
  const change = compareVersions(version(), version({ recordedAt: "2026-08-25T09:00:00.000Z" }));
  assert.equal(change, null);
});

test("money moves are reported, and a spend crossing its budget is called out", () => {
  const overspent = compareVersions(version({ spent: 300 }), version({ spent: 1200 }));
  assert.equal(overspent.fields.spent.delta, 900);
  assert.equal(overspent.fields.spent.direction, "worse");
  assert.equal(overspent.crossedBudget, true);

  const under = compareVersions(version({ spent: 300 }), version({ spent: 400 }));
  assert.equal(under.crossedBudget, false);
});

test("every tracked field is actually compared", () => {
  /* A field added to TRACKED_FIELDS but not handled would silently never
     report a change. Drive the assertion off the list itself. */
  for (const field of TRACKED_FIELDS) {
    const before = version();
    const after = version({ [field]: bump(before[field]) });
    const change = compareVersions(before, after);
    assert.ok(change, `${field} moved but compareVersions saw nothing`);
    assert.ok(change.fields[field], `${field} moved but is missing from fields`);
  }
});

function bump(value) {
  if (typeof value === "number") return value + 7;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "2027-01-01";
  return `${value}-moved`;
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/domain/changes.test.js`
Expected: FAIL — cannot find `server/changes.js`.

- [ ] **Step 3: Implement `server/changes.js`**

```js
/**
 * What moved between two recorded versions of a project.
 *
 * Pure, synchronous, and deliberately ignorant of SQL: the repository decides
 * WHICH two versions to compare, this decides what the difference means and
 * how to say it in a sentence a CIO would accept.
 *
 * "Direction" is from the reader's point of view, not the number's. Progress
 * going up is better; spend going up is worse; a target date moving out is
 * worse. Getting that wrong makes the briefing say the opposite of the truth,
 * so each field states its own rule rather than inferring one from the sign.
 */
import dayjs from "dayjs";

const HEALTH_RANK = { Green: 0, Amber: 1, Red: 2 };

/**
 * Ordered by how much the CIO cares. The headline names the first of these
 * that moved, so the order is the editorial decision, not an implementation
 * detail — health before dates before money before counts.
 */
export const TRACKED_FIELDS = [
  "health", "status", "targetEndDate", "percentComplete",
  "spent", "budget", "openRisks", "openQuestions",
];

const LABEL = {
  health: "health", status: "status", targetEndDate: "target date",
  percentComplete: "progress", spent: "spend", budget: "budget",
  openRisks: "open risks", openQuestions: "open questions",
};

/** Rising is worse for these; for the rest, rising is better. */
const RISING_IS_WORSE = new Set(["spent", "openRisks", "openQuestions"]);

function compareField(field, from, to) {
  if (from === to) return null;
  if (from == null && to == null) return null;

  if (field === "health") {
    const worse = (HEALTH_RANK[to] ?? 1) > (HEALTH_RANK[from] ?? 1);
    return { from, to, direction: worse ? "worse" : "better" };
  }

  if (field === "targetEndDate") {
    const days = dayjs(to).diff(dayjs(from), "day");
    return { from, to, days, direction: days > 0 ? "worse" : "better" };
  }

  if (field === "status") {
    /* No ordering worth inventing: a move to Completed is good, a move to On
       Hold is not, and everything else is context the reader supplies. */
    const direction = to === "Completed" ? "better" : to === "On Hold" ? "worse" : "neutral";
    return { from, to, direction };
  }

  const delta = Number(to) - Number(from);
  const rising = delta > 0;
  const worse = RISING_IS_WORSE.has(field) ? rising : !rising;
  return { from, to, delta: round1(delta), direction: worse ? "worse" : "better" };
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * @param {object} baseline the version as it stood at the start of the period
 * @param {object} current the newest recorded version
 * @returns {null|{fields: object, headline: string, worst: string, crossedBudget: boolean}}
 *          null when nothing tracked moved
 */
export function compareVersions(baseline, current) {
  if (!baseline || !current) return null;

  const fields = {};
  for (const field of TRACKED_FIELDS) {
    const moved = compareField(field, baseline[field], current[field]);
    if (moved) fields[field] = moved;
  }
  if (Object.keys(fields).length === 0) return null;

  const headlineField = TRACKED_FIELDS.find((f) => fields[f]);
  const h = fields[headlineField];
  const headline = headlineField === "targetEndDate"
    ? `target date ${h.days > 0 ? "slipped" : "pulled in"} ${Math.abs(h.days)} days`
    : h.delta !== undefined
      ? `${LABEL[headlineField]} ${h.delta > 0 ? "up" : "down"} ${Math.abs(h.delta)}`
      : `${LABEL[headlineField]} ${h.from} to ${h.to}`;

  return {
    fields,
    headline,
    worst: Object.values(fields).some((f) => f.direction === "worse") ? "worse" : "better",
    /* Spend crossing the budget line is the one derived fact worth stating
       outright; everything else the reader can see from the numbers. */
    crossedBudget: Number(baseline.spent) <= Number(baseline.budget)
      && Number(current.spent) > Number(current.budget),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/domain/changes.test.js`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add server/changes.js test/domain/changes.test.js
git commit -m "feat(changes): decide what a change is and how to say it"
```

**Amended after review.** Six defects in the vocabulary above, all mine, all
found by reading it rather than running it:

1. `targetEndDate` null on ONE side fell through to `dayjs(null).diff(...)` and
   printed `target date pulled in NaN days`. The column is `DATE NULL` and
   ingest leaves it unset routinely, so this was guaranteed the first time a
   Proposed project acquired a date. Acquiring or losing a commitment is now its
   own neutral case with its own sentence.
2. `worst` had two values, so a project whose only move was a neutral status
   transition came back `better` and Task 7 would have painted a green
   improvement arrow on it. `worst` is now `worse | better | neutral`.
3. The headline's up/down word read the ROUNDED delta while `direction` read the
   unrounded one, so a four-fils spend rise printed `spend down 0` beside a red
   badge. Both now read the same number, and a sub-rounding move says "slightly".
4. Money and percentages went out unformatted — `budget up 250000`, where every
   other number in the product goes through `fmtMoney`/`fmtPct`. The local
   `round1` duplicate is deleted in favour of the shared one, which has the
   `Number.isFinite` guard the copy lacked.
5. `budget` rising was "better" purely by omission from `RISING_IS_WORSE`. A
   budget increase is either secured funding or an overrun being formalised, and
   this module cannot tell which — the same position `status` is in. Now neutral.
6. `crossedBudget` fired when the budget was CUT underneath flat spend, which
   Task 5 would have counted as overspending. It now also requires the budget
   not to have fallen.

---

### Task 2: Read the baseline and the current version in one query

**Files:**
- Modify: `server/repos/projectVersions.js`
- Test: `test/db/changedSince.test.js`

- [ ] **Step 1: Write the failing test**

Reuse the scripted executor already in `test/db/history.test.js` — copy it into
the new file rather than importing across test files, and note in a comment that
`repos.test.js` has a third variant with a different calling convention.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { projectVersionsRepo } from "../../server/repos/projectVersions.js";

/* Same shape as the helper in history.test.js. Note repos.test.js has a THIRD
   variant with a { recordsets } signature — do not copy that one. */
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

const row = (over = {}) => ({
  ProjectId: "PRJ-1", Bucket: "current",
  RecordedAt: new Date("2026-08-25T09:00:00Z"),
  ContentHash: "h2", Status: "In Progress", Health: "Red",
  PercentComplete: 45, Budget: 1000, Spent: 400,
  OpenRisks: 2, OpenQuestions: 1,
  TargetEndDate: new Date("2026-06-30T00:00:00Z"),
  ...over,
});

test("a project with a baseline and a newer version comes back as a pair", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.ProjectVersion": [
      row({ Bucket: "baseline", Health: "Green", RecordedAt: new Date("2026-08-18T09:00:00Z"), ContentHash: "h1" }),
      row({ Bucket: "current", Health: "Red" }),
    ],
  });

  const changes = await projectVersionsRepo(ex).changedSince("2026-08-18");
  assert.equal(changes.size, 1);
  const entry = changes.get("PRJ-1");
  assert.equal(entry.baseline.health, "Green");
  assert.equal(entry.current.health, "Red");
  assert.equal(entry.baseline.recordedAt, "2026-08-18T09:00:00.000Z");
});

test("a project first recorded inside the period has no baseline, and says so", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.ProjectVersion": [row({ Bucket: "current" })],
  });

  const changes = await projectVersionsRepo(ex).changedSince("2026-08-18");
  const entry = changes.get("PRJ-1");
  assert.equal(entry.baseline, null, "a baseline was invented");
  assert.equal(entry.current.health, "Red");
  assert.equal(entry.trackedSince, "2026-08-25T09:00:00.000Z");
});

test("a project whose hash never moved is left out entirely", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.ProjectVersion": [
      row({ Bucket: "baseline", ContentHash: "same" }),
      row({ Bucket: "current", ContentHash: "same" }),
    ],
  });

  const changes = await projectVersionsRepo(ex).changedSince("2026-08-18");
  assert.equal(changes.size, 0, "an unchanged project was reported as changed");
});

test("the date is bound as a parameter, never interpolated", async () => {
  const ex = scriptedExecutor();
  await projectVersionsRepo(ex).changedSince("2026-08-18");
  const select = ex.statements.find((s) => s.text.includes("FROM dbo.ProjectVersion"));
  assert.ok(select.params.some((p) => p.name === "since"), "the date was not bound");
  assert.ok(!select.text.includes("2026-08-18"), "the date was interpolated into the SQL");
});

test("dates come back as ISO strings the section engine can compare", async () => {
  const ex = scriptedExecutor({
    "FROM dbo.ProjectVersion": [
      row({ Bucket: "baseline", ContentHash: "h1" }),
      row({ Bucket: "current", ContentHash: "h2", TargetEndDate: new Date("2026-09-30T00:00:00Z") }),
    ],
  });

  const entry = (await projectVersionsRepo(ex).changedSince("2026-08-18")).get("PRJ-1");
  assert.equal(entry.current.targetEndDate, "2026-09-30");
  assert.equal(typeof entry.current.recordedAt, "string");
});

test("nothing recorded yet is an empty map, not a failure", async () => {
  const ex = scriptedExecutor();
  const changes = await projectVersionsRepo(ex).changedSince("2026-08-18");
  assert.equal(changes.size, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/db/changedSince.test.js`
Expected: FAIL — `changedSince is not a function`.

- [ ] **Step 3: Add `changedSince` to `server/repos/projectVersions.js`**

Add this method beside `historyFor`, and add the shared row mapper above the
factory:

```js
/** One version row, in the shape server/changes.js compares. */
function toVersion(r) {
  return {
    recordedAt: r.RecordedAt instanceof Date ? r.RecordedAt.toISOString() : String(r.RecordedAt),
    contentHash: r.ContentHash,
    status: r.Status,
    health: r.Health,
    percentComplete: Number(r.PercentComplete),
    budget: Number(r.Budget),
    spent: Number(r.Spent),
    openRisks: r.OpenRisks,
    openQuestions: r.OpenQuestions,
    targetEndDate: iso(r.TargetEndDate),
  };
}
```

```js
    /**
     * Every project whose recorded content moved since a date.
     *
     * One query, two buckets: the newest version at or before `sinceISO` is the
     * baseline, the newest overall is current. A project first recorded inside
     * the period has no baseline — it is returned with `baseline: null` and a
     * `trackedSince`, because "we have only known about this since Tuesday" is
     * a different statement from "nothing changed", and the briefing must not
     * conflate them.
     *
     * @param {string} sinceISO YYYY-MM-DD, the start of the period
     * @returns {Promise<Map<string, {baseline: object|null, current: object, trackedSince: string|null}>>}
     */
    async changedSince(sinceISO) {
      const { recordset } = await ex.query(`
        WITH ranked AS (
          SELECT ProjectId, ContentHash, RecordedAt, Status, Health, PercentComplete,
                 Budget, Spent, OpenRisks, OpenQuestions, TargetEndDate,
                 CASE WHEN RecordedAt <= @since THEN 'baseline' ELSE 'current' END AS Bucket,
                 ROW_NUMBER() OVER (
                   PARTITION BY ProjectId, CASE WHEN RecordedAt <= @since THEN 1 ELSE 0 END
                   ORDER BY RecordedAt DESC, ProjectVersionId DESC) AS rn
          FROM dbo.ProjectVersion
        )
        SELECT * FROM ranked WHERE rn = 1
      `, [{ name: "since", type: sql.DateTime2, value: new Date(`${sinceISO}T00:00:00Z`) }]);

      /* Group first, decide second: a project can appear once or twice. */
      const byProject = new Map();
      for (const r of recordset) {
        const entry = byProject.get(r.ProjectId) || { baseline: null, current: null };
        entry[r.Bucket === "baseline" ? "baseline" : "current"] = toVersion(r);
        byProject.set(r.ProjectId, entry);
      }

      const changes = new Map();
      for (const [projectId, { baseline, current }] of byProject) {
        /* No row after the cutoff means the newest version IS the baseline, so
           nothing moved during the period. */
        if (!current) continue;
        if (baseline && baseline.contentHash === current.contentHash) continue;

        changes.set(projectId, {
          baseline,
          current,
          trackedSince: baseline ? null : current.recordedAt,
        });
      }
      return changes;
    },
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/db/changedSince.test.js test/db/history.test.js`
Expected: PASS — the new 6 plus the existing 28.

- [ ] **Step 5: Commit**

```bash
git add server/repos/projectVersions.js test/db/changedSince.test.js
git commit -m "feat(db): read the baseline and current version of everything that moved"
```

**Amended after review — migration 9, and one cost we are choosing to live with.**

A real execution plan showed this query doing a clustered-index scan, dragging
the in-row `Payload` (~1.8 kB a row) across every page on every call, and then
sorting. Migration 9 widens `IX_ProjectVersion_Project` to include the eight
columns the CTE selects beyond the key, which moves it to a narrow index scan —
`EstimateIO` fell from 0.046 to 0.003 on the empty table.

The explicit `Sort` remains, and reordering the index key does NOT remove it.
That was tested rather than assumed: a probe index keyed
`(ProjectId, RecordedAt DESC, ProjectVersionId DESC)` was built by hand and the
plan pulled twice — once empty, once with 300 rows across ten projects and fresh
statistics. Both kept the `Sort`, with `EstimateRows` rising to 300 so the
optimiser was demonstrably seeing real cardinality rather than taking a
trivial-cost shortcut. The likely reason is that the window partitions on a
computed `CASE WHEN RecordedAt <= @since` expression, and the optimiser does not
match that against the physical leaf order.

Removing it would mean redesigning the query — two separately ranked queries,
one per bucket, unioned, each with a plain non-computed partition key. That is a
larger change than the cost justifies today. Recorded here so the next person
does not repeat the experiment.

---

### Task 3: The store answers, or says it cannot

**Files:**
- Modify: `server/store/sqlStore.js`
- Modify: `server/store.js`
- Test: `test/db/sqlStoreHistory.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/db/sqlStoreHistory.test.js`:

```js
test("the store turns recorded versions into comparisons", async () => {
  const { store } = harness();
  store.repos.projectVersions.changedSince = async () => new Map([
    ["PRJ-1", {
      baseline: { health: "Green", status: "In Progress", percentComplete: 40, budget: 1000, spent: 300,
                  openRisks: 1, openQuestions: 0, targetEndDate: "2026-06-30", recordedAt: "2026-08-18T09:00:00.000Z" },
      current: { health: "Red", status: "In Progress", percentComplete: 45, budget: 1000, spent: 300,
                 openRisks: 1, openQuestions: 0, targetEndDate: "2026-06-30", recordedAt: "2026-08-25T09:00:00.000Z" },
      trackedSince: null,
    }],
  ]);

  const changes = await store.changesSince("2026-08-18");
  assert.equal(changes.get("PRJ-1").headline, "health Green to Red");
  assert.equal(changes.get("PRJ-1").worst, "worse");
});

test("a project with no baseline is reported as newly tracked, not as unchanged", async () => {
  const { store } = harness();
  store.repos.projectVersions.changedSince = async () => new Map([
    ["PRJ-2", { baseline: null, current: { health: "Amber" }, trackedSince: "2026-08-25T09:00:00.000Z" }],
  ]);

  const entry = (await store.changesSince("2026-08-18")).get("PRJ-2");
  assert.equal(entry.trackedSince, "2026-08-25T09:00:00.000Z");
  assert.equal(entry.fields, undefined, "a comparison was invented against a baseline that does not exist");
});

test("a store without history says so rather than returning an empty map", async () => {
  /* Empty means "nothing moved". Null means "we cannot know". The briefing
     renders those two very differently and must be able to tell them apart. */
  const repos = {
    projects: { async all() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
    posture: { async list() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
  };
  const store = new SqlStore(repos, { logger: quiet });
  assert.equal(await store.changesSince("2026-08-18"), null);
});
```

and a test for the in-memory store, in `test/domain/annotate.test.js` (created in Task 4) or wherever the in-memory store is already covered:

```js
test("the in-memory store never claims to know what changed", async () => {
  const { Store } = await import("../../server/store.js");
  assert.equal(await new Store().changesSince("2026-08-18"), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/db/sqlStoreHistory.test.js`
Expected: FAIL — `store.changesSince is not a function`.

- [ ] **Step 3: Add `changesSince` to `server/store/sqlStore.js`**

Import the comparator at the top:

```js
import { compareVersions } from "../changes.js";
```

and add beside `posture()`:

```js
  /**
   * What moved since a date, ready for the section engine.
   *
   * Returns null — NOT an empty Map — when this store keeps no history. Empty
   * means "nothing moved"; null means "we cannot know", and the briefing says
   * something different for each. Conflating them would have the dashboard
   * quietly assert that a portfolio was stable during a period it has no
   * record of.
   *
   * @param {string} sinceISO YYYY-MM-DD
   * @returns {Promise<Map<string, object>|null>}
   */
  async changesSince(sinceISO) {
    if (!this.repos.projectVersions) return null;

    const raw = await this.repos.projectVersions.changedSince(sinceISO);
    const changes = new Map();

    for (const [projectId, entry] of raw) {
      if (!entry.baseline) {
        /* Known only from inside the period. Say when, and say nothing else. */
        changes.set(projectId, { trackedSince: entry.trackedSince, current: entry.current });
        continue;
      }
      const compared = compareVersions(entry.baseline, entry.current);
      if (compared) changes.set(projectId, { ...compared, since: entry.baseline.recordedAt });
    }
    return changes;
  }

  /** The oldest recorded version, so the briefing can say how far back it knows. */
  async historyStartedAt() {
    if (!this.repos.projectVersions?.oldestRecordedAt) return null;
    return this.repos.projectVersions.oldestRecordedAt();
  }
```

`oldestRecordedAt` is a one-line addition to the repository:

```js
    /** When history begins, or null if nothing has been recorded. */
    async oldestRecordedAt() {
      const { recordset } = await ex.query("SELECT MIN(RecordedAt) AS oldest FROM dbo.ProjectVersion");
      const oldest = recordset[0]?.oldest;
      return oldest instanceof Date ? oldest.toISOString() : null;
    },
```

- [ ] **Step 4: Teach the in-memory store to say no**

In `server/store.js`, beside its other methods:

```js
  /** No database, so no history. Null, not empty — see SqlStore.changesSince. */
  async changesSince() { return null; }

  /** @returns {Promise<null>} */
  async historyStartedAt() { return null; }
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/db/sqlStoreHistory.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/store/sqlStore.js server/store.js server/repos/projectVersions.js test/db/sqlStoreHistory.test.js
git commit -m "feat(store): answer what changed, or say plainly that we cannot know"
```

---

### Task 4: One annotation pass over the built sections

**Files:**
- Modify: `server/sections.js`
- Modify: `server/summarize.js`
- Test: `test/domain/annotate.test.js`

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { annotateChanges } from "../../server/sections.js";

const sections = () => ({
  successes: { items: [{ id: "PRJ-1", name: "One" }] },
  qri: {
    questions: [{ id: "PRJ-2", text: "?" }],
    risks: [{ id: "PRJ-1", title: "r" }],
  },
  priorities: { items: [{ id: "PRJ-2", name: "Two" }], watchlist: [{ id: "PRJ-3", name: "Three" }] },
  roadmap: { inFlight: [{ id: "PRJ-1" }], planned: [] },
  posture: { domains: [{ domain: "Identity", projectId: "PRJ-1" }] },
});

const changes = () => new Map([
  ["PRJ-1", { headline: "health Green to Red", worst: "worse", fields: { health: { from: "Green", to: "Red" } }, since: "2026-08-18T00:00:00.000Z" }],
  ["PRJ-3", { trackedSince: "2026-08-24T00:00:00.000Z" }],
]);

test("every item carrying a changed project's id is annotated, wherever it sits", () => {
  const s = sections();
  annotateChanges(s, changes());

  assert.equal(s.successes.items[0].change.headline, "health Green to Red");
  assert.equal(s.qri.risks[0].change.worst, "worse");
  assert.equal(s.roadmap.inFlight[0].change.headline, "health Green to Red");
  assert.equal(s.priorities.watchlist[0].change.trackedSince, "2026-08-24T00:00:00.000Z");
});

test("an item whose project did not move is left exactly as it was", () => {
  const s = sections();
  annotateChanges(s, changes());
  assert.equal(s.priorities.items[0].change, undefined, "an unchanged project was annotated");
  assert.equal(s.qri.questions[0].change, undefined);
});

test("null changes means we cannot know, and nothing is annotated", () => {
  const s = sections();
  annotateChanges(s, null);
  for (const item of [s.successes.items[0], s.qri.risks[0], s.roadmap.inFlight[0]]) {
    assert.equal(item.change, undefined);
  }
  assert.equal(s.historyAvailable, false);
});

test("an empty map means nothing moved, which is a real answer", () => {
  const s = sections();
  annotateChanges(s, new Map());
  assert.equal(s.historyAvailable, true);
  assert.equal(s.successes.items[0].change, undefined);
});

test("posture rows are annotated by their project, not their domain name", () => {
  const s = sections();
  annotateChanges(s, changes());
  assert.equal(s.posture.domains[0].change.worst, "worse");
});

test("annotating is idempotent, because the summary is built more than once per request", () => {
  const s = sections();
  annotateChanges(s, changes());
  const first = JSON.stringify(s);
  annotateChanges(s, changes());
  assert.equal(JSON.stringify(s), first);
});

test("a section shape it has never seen does not throw", () => {
  /* A future section with a different internal shape must degrade, not crash
     the whole briefing. */
  const odd = { successes: { items: null }, somethingNew: { rows: [{ id: "PRJ-1" }] } };
  assert.doesNotThrow(() => annotateChanges(odd, changes()));
  assert.equal(odd.somethingNew.rows[0].change.worst, "worse");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/domain/annotate.test.js`
Expected: FAIL — `annotateChanges is not exported`.

- [ ] **Step 3: Add `annotateChanges` to `server/sections.js`**

```js
/**
 * Attach what changed to every item that names a project.
 *
 * Deliberately generic rather than per-section: every section item already
 * carries the project's `id` (posture carries `projectId`), so one walk over
 * the built sections annotates all of them and no builder has to be rewritten
 * or made aware that history exists. A section added later is covered for free.
 *
 * @param {object} sections the output of buildSections, MUTATED in place
 * @param {Map<string, object>|null} changes null when the store keeps no history
 */
export function annotateChanges(sections, changes) {
  sections.historyAvailable = changes !== null;
  if (!changes) return sections;

  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }

    const projectId = node.projectId || node.id;
    if (typeof projectId === "string" && changes.has(projectId)) {
      node.change = changes.get(projectId);
    }
    for (const value of Object.values(node)) walk(value);
  };

  walk(sections);
  return sections;
}
```

The `seen` set is not decoration: section items reference the same project
objects from more than one section, and a plain recursive walk over shared
references would revisit them. It also makes the pass idempotent.

- [ ] **Step 4: Load the changes at the edge, in `server/summarize.js`**

Add beside `buildSummary`:

```js
/**
 * Fetch what changed during a period. The one asynchronous step in an
 * otherwise synchronous pipeline, kept at the edge on purpose: making the
 * section engine async to reach a database would ripple through every builder
 * and every test for no benefit.
 *
 * @returns {Promise<Map<string, object>|null>} null when the store keeps no history
 */
export async function loadChanges(store, period, dateISO) {
  if (typeof store.changesSince !== "function") return null;
  const { start } = periodWindow(period, dateISO);
  try {
    return await store.changesSince(start.format("YYYY-MM-DD"));
  } catch (err) {
    /* A history query failing must not take down the briefing. The dashboard
       is still correct without it; it just cannot say what moved. */
    console.error(`[changes] could not load history: ${err.message}`);
    return null;
  }
}
```

and change `buildSummary`'s signature and its `sections` line:

```js
export function buildSummary(store, period, dateISO, { changes = null } = {}) {
```

```js
    sections: annotateChanges(
      buildSections(projects, { period, start, end, todayISO, postureRows: store.posture() }),
      changes
    ),
```

importing `annotateChanges` alongside `buildSections`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/domain/annotate.test.js test/domain/posture.test.js`
Expected: PASS. Every existing test that exercises the section engine must still pass
untouched — `test/domain/posture.test.js` and `test/db/history.test.js` both
import it, and they
call `buildSummary` with three arguments and get `changes: null`, so nothing is
annotated and `historyAvailable` is false.

- [ ] **Step 6: Commit**

```bash
git add server/sections.js server/summarize.js test/domain/annotate.test.js
git commit -m "feat(sections): annotate what moved without rewriting a single builder"
```

**Amended after review — two things this step does that the plan did not say.**

`annotateChanges` adds a `historyAvailable` key to the `sections` object, so
`summary.sections` is no longer exactly the five sections. That broke a pinned
`deepEqual` on `Object.keys(sections)` in `test/api/app.test.js`. Nothing in
production iterates those keys — checked across `server/` and `client/src/` —
so the key stays where it is, and the assertion was rewritten to check the five
sections are present rather than pinning the whole shape, which would break
again the next time anything is added. Task 6 inherits a green suite; do not be
surprised to find `test/api/app.test.js` already touched.

The plan's idempotency test could not fail. Its fixture built a fresh object
literal for each mention of a project, so there was no structural sharing for
the `seen` set to deduplicate, and removing the guard entirely left the test
green. Replaced by two that exercise the real hazards: one project object
genuinely referenced from two sections, and a parent/child cycle that recurses
until the stack dies without the guard.

---

### Task 5: A portfolio-level digest the narrative can use

Individual markers tell the CIO what moved on a row they are already looking at.
The digest tells them where to look.

**Files:**
- Modify: `server/summarize.js`
- Test: `test/domain/changes.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/domain/changes.test.js`:

```js
import { summariseChanges } from "../../server/changes.js";

test("the digest counts what a CIO would ask about first", () => {
  const changes = new Map([
    ["A", { worst: "worse", fields: { health: { from: "Green", to: "Red", direction: "worse" } } }],
    ["B", { worst: "worse", fields: { targetEndDate: { days: 30, direction: "worse" } } }],
    ["C", { worst: "better", fields: { health: { from: "Red", to: "Amber", direction: "better" } } }],
    ["D", { trackedSince: "2026-08-24T00:00:00.000Z" }],
  ]);

  const digest = summariseChanges(changes);
  assert.equal(digest.changed, 3, "newly tracked projects are not changes");
  assert.equal(digest.wentRed, 1);
  assert.equal(digest.recovered, 1);
  assert.equal(digest.slipped, 1);
  assert.equal(digest.newlyTracked, 1);
});

test("a project that no longer exists is not counted", () => {
  /* ProjectVersion has no foreign key to dbo.Project, so a removed workbook's
     history survives. It must not keep inflating this week's numbers. */
  const changes = new Map([
    ["GONE", { worst: "worse", fields: { health: { from: "Green", to: "Red", direction: "worse" } } }],
    ["HERE", { worst: "worse", fields: { health: { from: "Green", to: "Red", direction: "worse" } } }],
  ]);

  const digest = summariseChanges(changes, new Set(["HERE"]));
  assert.equal(digest.changed, 1);
  assert.equal(digest.wentRed, 1);
});

test("the digest is null when history is unavailable, not a row of zeroes", () => {
  /* Zeroes would read as "nothing changed this week", which is a claim we
     cannot make without history. */
  assert.equal(summariseChanges(null), null);
});

test("an empty map is a real answer: nothing moved", () => {
  const digest = summariseChanges(new Map());
  assert.deepEqual(digest, { changed: 0, wentRed: 0, recovered: 0, slipped: 0, overspent: 0, newlyTracked: 0 });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/domain/changes.test.js`
Expected: FAIL — `summariseChanges is not exported`.

- [ ] **Step 3: Implement it in `server/changes.js`**

```js
/**
 * Portfolio-level counts, for the narrative and the KPI strip.
 *
 * @param {Map<string, object>|null} changes
 * @param {Set<string>|null} liveProjectIds when given, only these are counted
 * @returns {null|{changed: number, wentRed: number, recovered: number,
 *                 slipped: number, overspent: number, newlyTracked: number}}
 *          null when there is no history to count
 */
export function summariseChanges(changes, liveProjectIds = null) {
  if (!changes) return null;

  const digest = { changed: 0, wentRed: 0, recovered: 0, slipped: 0, overspent: 0, newlyTracked: 0 };

  for (const [projectId, entry] of changes) {
    /* History outlives the portfolio on purpose: ProjectVersion has no foreign
       key to dbo.Project, so a workbook removed last month still has rows here.
       That is right for an audit view and wrong for a digest — "3 projects went
       Red" must mean three projects that still exist. Nothing ever revisits a
       removed project, so without this the number never self-corrects. */
    if (liveProjectIds && !liveProjectIds.has(projectId)) continue;
    if (entry.trackedSince) { digest.newlyTracked += 1; continue; }
    digest.changed += 1;

    const health = entry.fields?.health;
    if (health?.to === "Red" && health.from !== "Red") digest.wentRed += 1;
    if (health?.from === "Red" && health.to !== "Red") digest.recovered += 1;
    if (entry.fields?.targetEndDate?.days > 0) digest.slipped += 1;
    /* crossedBudget already refuses to fire when the budget was cut underneath
       flat spend, so this counts overspending rather than re-baselining. */
    if (entry.crossedBudget) digest.overspent += 1;
  }
  return digest;
}
```

- [ ] **Step 4: Put it on the summary**

In `server/summarize.js`, import `summariseChanges` and add to the returned
object, beside `kpis`:

```js
    changes: summariseChanges(changes, new Set(projects.map((p) => p.id))),
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/domain/changes.test.js test/domain/posture.test.js`
Expected: PASS — 12 in the changes suite.

- [ ] **Step 6: Commit**

```bash
git add server/changes.js server/summarize.js test/domain/changes.test.js
git commit -m "feat(changes): a portfolio digest of what moved"
```

---

### Task 6: Wire it through the routes

**Files:**
- Modify: `server/app.js`
- Test: `test/api/app.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("the summary reports whether history is available", async () => {
  const app = makeApp({ role: "viewer" });
  const agent = await signedIn(app);
  const res = await agent.get("/api/summary?period=weekly&date=2026-08-25");

  assert.equal(res.status, 200);
  /* The in-memory store keeps no history, and must say so rather than
     implying a stable week. */
  assert.equal(res.body.sections.historyAvailable, false);
  assert.equal(res.body.changes, null);
});

test("a store that knows what changed puts it on the summary", async () => {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  const first = store.all()[0];
  store.changesSince = async () => new Map([
    [first.id, { headline: "health Green to Red", worst: "worse",
                 fields: { health: { from: "Green", to: "Red", direction: "worse" } },
                 since: "2026-08-18T00:00:00.000Z" }],
  ]);

  const app = createApp({
    store, config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-viewers": "viewer" }),
    audit: { append: async () => {} },
    ldapAuthenticate: devAuthenticate("viewer"),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
  const agent = await signedIn(app);
  const res = await agent.get("/api/summary?period=weekly&date=2026-08-25");

  assert.equal(res.body.sections.historyAvailable, true);
  assert.equal(res.body.changes.wentRed, 1);

  const annotated = [
    ...res.body.sections.priorities.items,
    ...res.body.sections.priorities.watchlist,
    ...res.body.sections.successes.items,
  ].find((item) => item.id === first.id);
  if (annotated) assert.equal(annotated.change.worst, "worse");
});

test("a history query that fails does not take down the briefing", async () => {
  const store = new Store();
  ingestDirectory(store, "sample-data");
  store.changesSince = async () => { throw new Error("database is down"); };

  const app = createApp({
    store, config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-viewers": "viewer" }),
    audit: { append: async () => {} },
    ldapAuthenticate: devAuthenticate("viewer"),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
  const agent = await signedIn(app);
  const res = await agent.get("/api/summary?period=weekly&date=2026-08-25");

  assert.equal(res.status, 200, "a history failure blanked the dashboard");
  assert.equal(res.body.sections.historyAvailable, false);
  assert.ok(res.body.sections.priorities.items.length > 0, "the portfolio itself did not survive");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/api/app.test.js`
Expected: FAIL — `historyAvailable` is undefined.

- [ ] **Step 3: Load changes in both routes**

Find every `buildSummary(` call in `server/app.js` — there is one for
`/api/summary` and at least one in the export route — and give each the changes.
The handlers are already `async` and wrapped in `wrap()`:

```js
    const changes = await loadChanges(store, period, date);
    const summary = buildSummary(store, period, date, { changes });
```

importing `loadChanges` alongside `buildSummary`.

Do NOT add a second `loadChanges` call inside a loop or per section — one per
request. If the export route builds more than one summary, hoist the call.

- [ ] **Step 4: Run the tests**

Run: `node --test test/api/app.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/app.js test/api/app.test.js
git commit -m "feat(api): the summary carries what changed, or says it cannot know"
```

---

### Task 7: Show it — client and exports

**Two rules for this task, both from the Task 4 review.**

**Never write to `item.change`.** `annotateChanges` stores the SAME object
reference on every item sharing a project id — the same change object is on the
Successes row, the Priorities row and the Roadmap row. Nothing mutates it today,
and the first temptation to do so is right here: this task says the slide can
say `▲ Red` where the web says `▲ health Green to Red`, and `pptx.js` measures
text, so memoising a shortened label onto `change` would look sensible. It would
leak that label into every other section and every other exporter. Build display
strings locally and pass them down; treat `item.change` as read-only.

**While you are in `server/sections.js`, add one line to `annotateChanges`'s
docblock** recording the convention it depends on: an `id` or `projectId` on a
section item always means the project's id. That is true of every builder today
— checked against all five — but nothing enforces it, so a future builder that
surfaced a milestone's or risk's own id under the same field name would be
silently misannotated with its parent project's change.


**Files:**
- Create: `client/src/components/ChangeBadge.jsx`
- Modify: `client/src/components/Section{Successes,QRI,Priorities,Roadmap,Posture}.jsx`
- Modify: `client/src/styles.css` (or wherever the section styles live — find it, do not assume)
- Modify: `server/exporters/{pptx,word,excel}.js`

- [ ] **Step 1: Build the badge**

```jsx
/**
 * What moved, in as few characters as a slide can carry.
 *
 * Three states, and they mean different things: a change (say what and which
 * way), newly tracked (say since when — NOT "no change", which we cannot
 * claim), and nothing at all when the item did not move.
 */
export default function ChangeBadge({ change }) {
  if (!change) return null;

  if (change.trackedSince) {
    const since = new Date(change.trackedSince).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return <span className="change change-new" title={`First recorded ${since}`}>new since {since}</span>;
  }

  /* Three states, not two. A neutral move — an ordinary status transition, a
     budget that changed for reasons we cannot read — is neither an improvement
     nor a regression, and painting it green would tell the CIO something the
     data does not support. */
  const mark = change.worst === "worse" ? "▲" : change.worst === "better" ? "▼" : "•";

  return (
    <span className={`change change-${change.worst}`} title={describe(change)}>
      {mark} {change.headline}
    </span>
  );
}

function describe(change) {
  return Object.entries(change.fields)
    .map(([field, f]) => `${field}: ${f.from} → ${f.to}`)
    .join("\n");
}
```

Colours come from the brand palette already in the stylesheet — `worse` uses
Pantone 192 C (`#E40046`), `better` uses Pantone 354 C (`#00B140`), and both
`change-neutral` and `change-new` use the grey (`#414141`). Four states, not
three: neutral must not borrow the green. Read the existing `.rag` rules and match
how they are scoped; note the earlier defect where `.rag` styles scoped under
`.kpi` silently failed elsewhere.

- [ ] **Step 2: Render it in each section**

One line per component, beside the item's title. Do not restructure a component
to fit it. In `SectionPriorities.jsx` the shape is:

```jsx
import ChangeBadge from "./ChangeBadge.jsx";
```

```jsx
        <h4 className="item-title">
          {item.name}
          <ChangeBadge change={item.change} />
        </h4>
```

Read each of the five components first — `SectionQRI.jsx` renders two lists
(questions and risks) and needs the badge in both, and `SectionPosture.jsx`
renders domains whose change comes from `projectId`, not `id`. Match whatever
element each component already uses for its title rather than introducing
`item-title` where it does not exist.

- [ ] **Step 3: Say when history is thin, and since when**

Where the period is shown, when `sections.historyAvailable` is false, add a
quiet line. This is the honest-cold-start decision made visible — do not hide
the feature, and do not imply stability.

Say *since when* rather than just "not yet", because those answer different
questions. `store.historyStartedAt()` returns the oldest recorded version, or
null if nothing has been recorded at all:

- history has never been recorded → `No change history yet — it begins with the next upload.`
- history exists but starts after the period being viewed →
  `No change history before 25 Aug.`

That means `/api/summary` must also carry `historyStartedAt`. Add it beside
`changes` in `server/summarize.js`'s returned object, loaded in the same place
`loadChanges` is called in Task 6 — one await, not one per section:

```js
    historyStartedAt: await store.historyStartedAt(),
```

Note this makes `buildSummary` itself unable to fetch it, since it is
synchronous. Load it at the route alongside the changes and pass it in the same
options object — `buildSummary(store, period, date, { changes, historyStartedAt })`
— rather than making the summary builder async. The rule from the plan header
still holds: the engine stays synchronous and history arrives as data.

- [ ] **Step 4: The exporters**

Each exporter walks the same section data. Add the change text after the item's
name — `pptx.js` is the one to be careful with: it measures text to lay out
slides, so an appended string changes the measured width. Re-run the collision
audit afterwards:

```bash
node scripts/pptx-audit.mjs
```

Expected: 0 collisions. If the badge text pushes a row into a collision, shorten
the exported form (the slide can say `▲ Red` where the web says
`▲ health Green to Red`) rather than loosening the audit.

- [ ] **Step 5: Verify by eye**

```bash
STORE=memory AUTH_MODE=dev DEV_ROLE=admin npm start
```

With `STORE=memory` there is no history, so the correct result is the quiet
"no change history yet" line and no badges anywhere. That IS the test — confirm
the feature is invisible rather than broken.

- [ ] **Step 6: Commit**

```bash
git add client server/exporters
git commit -m "feat(ui): show what moved, and say so when we cannot know"
```

---

### Task 8: Prove it against real SQL

**Files:**
- Modify: `test/db/live.test.js`

The hermetic tests fake the repository. Only this proves the windowed query is
correct against real data and real dates.

- [ ] **Step 1: Add the subtests**

Inside the existing live block, after the history subtests. Use the suite's
`livetest%` naming and let the existing `cleanup()` sweep them:

```js
  await t.test("changedSince reports the baseline and the current version of what moved", async () => {
    const { projectVersionsRepo } = await import("../../server/repos/projectVersions.js");
    const { hashProject } = await import("../../server/ingest/hash.js");
    const versions = projectVersionsRepo(ex);

    const moved = "P2-MOVED";
    const still = "P2-STILL";
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

    const fresh = { ...ingestFile("sample-data/GCIO_Portfolio_Master.xlsx").projects[0], id: "P2-FRESH" };
    await versions.appendChanged([{ project: fresh, hash: hashProject(fresh) }], { ingestRunId: null });

    const entry = (await versions.changedSince("2026-08-01")).get("P2-FRESH");
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

    const edge = { ...ingestFile("sample-data/GCIO_Portfolio_Master.xlsx").projects[0], id: "P2-EDGE" };
    await versions.appendChanged([{ project: edge, hash: hashProject(edge) }], { ingestRunId: null });
    await ex.query("UPDATE dbo.ProjectVersion SET RecordedAt = @at WHERE ProjectId = @id", [
      { name: "at", type: sql.DateTime2, value: new Date("2026-08-18T00:00:00Z") },
      { name: "id", type: sql.NVarChar(60), value: "P2-EDGE" },
    ]);

    const changes = await versions.changedSince("2026-08-18");
    assert.ok(!changes.has("P2-EDGE"),
      "a version recorded exactly at the cutoff was treated as a change within the period");
  });
```

Extend `cleanup()` to sweep `ProjectId LIKE 'P2-%'` alongside the existing
markers, and add the same pattern to the "leaves nothing behind" subtest so a
leak here fails loudly too.

- [ ] **Step 2: Run it, twice**

```bash
DB_LIVE=1 npm run test:db
```

Expected: all pass, both runs, and the final "the suite leaves nothing behind"
subtest still passes.

- [ ] **Step 3: Commit**

```bash
git add test/db/live.test.js
git commit -m "test(db): live proof of the changed-since window"
```

---

### Task 9: Close out

- [ ] **Step 1: Run everything**

```bash
npm test
DB_LIVE=1 npm run test:db
npm run build
node scripts/pptx-audit.mjs
```

- [ ] **Step 2: Document it**

In `README.md`, under what the CIO sees, state plainly what the markers mean and
that history begins when the database does — a project shows "new since" until
it has been ingested twice.

- [ ] **Step 3: Mark the spec**

Update the P2 row to what was built, and note that trend lines and question
ageing remain outstanding, deferred because they need accumulated history rather
than because they were forgotten.

- [ ] **Step 4: Commit and tag**

```bash
git add README.md docs/superpowers/specs/2026-08-24-backend-production-design.md
git commit -m "docs: Phase 2 — the briefing says what moved"
git tag -a v1.3.0-p2 -m "Phase 2: changed since last week"
```

---

## Self-review against the spec

| Spec P2 requirement | Where |
| --- | --- |
| "changed since last week" in sections | Tasks 1-4, shown in Task 7 |
| "changed since last week" in exports | Task 7 |
| sourced from versions rather than file dates | Task 2 — the query reads `ProjectVersion` only |
| Real trends | **Deferred.** Needs months of history; nothing true can be drawn from two versions |
| Question ageing | **Deferred.** Same reason |

**The honest-degradation rule, restated because it is the decision most likely
to be quietly undone:** `null` means "we cannot know", an empty Map means
"nothing moved". Every layer preserves the distinction — the repository, the
store, `annotateChanges`, `summariseChanges`, the API response and the UI. Any
change that collapses them into one is a regression, however tidy it looks.

**Not in this phase:** trends, question ageing, `/metrics`, the ingest/web role
split, worker-thread parsing, backup drills, and any backfill of synthetic
history.
