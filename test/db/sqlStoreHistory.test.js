/**
 * SqlStore's history side. The repositories are faked: what matters here is
 * that a run is always opened and always closed, that the vault is written
 * before anything else, and that an unchanged file is recognised as such.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SqlStore } from "../../server/store/sqlStore.js";

const quiet = { error() {}, info() {} };

function harness({ liveHash = null, changed = 2 } = {}) {
  const calls = [];
  const repos = {
    projects: {
      async all() { return []; },
      async replaceForFile(file, projects) { calls.push(["projects.replace", file, projects.length]); },
      async removeFile(file) { calls.push(["projects.remove", file]); return 3; },
    },
    posture: {
      async list() { return []; },
      async replaceForFile(file, rows) { calls.push(["posture.replace", file, rows.length]); },
      async removeFile(file) { calls.push(["posture.remove", file]); return 1; },
    },
    sourceFiles: {
      async record(file) { calls.push(["sourceFiles.record", file.fileName, file.sha256]); return { sourceFileId: 1, alreadySeen: false }; },
    },
    ingestRuns: {
      async start(run) { calls.push(["runs.start", run.fileName, run.trigger]); return 99; },
      /* The vault ledger (SourceFile) is not consulted for "unchanged" any more:
         it remembers bytes the instant they are vaulted, whether or not the
         ingest that vaulted them ever landed. Only the last CLOSED run can say
         whether a hash is what the dashboard is actually showing. */
      async liveHashFor() { return liveHash; },
      async finish(id, result) {
        /* The error text carries whether the snapshot had already moved, so the
           harness has to keep it rather than only the counts. */
        calls.push(["runs.finish", id, result.outcome, result.error ?? result.projectsChanged]);
      },
    },
    projectVersions: {
      async appendChanged() { calls.push(["versions.append"]); return changed; },
    },
  };
  const vault = {
    store(buffer, name) { calls.push(["vault.store", name, buffer.length]); return { hash: "deadbeef", vaultPath: "2026/08/x.xlsx", bytes: buffer.length }; },
  };
  return { calls, store: new SqlStore(repos, { vault, logger: quiet }) };
}

const parsed = (over = {}) => ({
  ok: true, file: "master.xlsx",
  projects: [{ id: "PRJ-1", name: "One", status: "In Progress", health: "Green", priority: "Low",
               milestones: [], updates: [], risks: [], questions: [] }],
  posture: [{ domain: "Identity", status: "Partial", score: 60, target: 90 }],
  bytes: Buffer.from("workbook bytes"),
  ...over,
});

test("an ingest vaults the bytes, records the file, and closes the run", async () => {
  const { calls, store } = harness();
  await store.applyFile(parsed(), { trigger: "watcher" });

  const order = calls.map((c) => c[0]);
  assert.equal(order[0], "runs.start", "the run must be open before anything that can fail");
  assert.ok(order.indexOf("vault.store") < order.indexOf("projects.replace"),
    "the bytes must be vaulted before they are parsed into the database");
  assert.ok(order.includes("sourceFiles.record"));
  assert.ok(order.includes("versions.append"));

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.deepEqual(finish, ["runs.finish", 99, "applied", 2]);   // no error, so the count
});

test("a parse result's coldStart flag reaches ingestRuns.finish() -- the flag ingest.js sets must not get lost on the way to the database", async () => {
  // Not routed through harness()'s shared "runs.finish" push, which only
  // records outcome/error/projectsChanged: that shape is already asserted by
  // deepEqual elsewhere in this file, and adding a field to it would break
  // those exact-shape assertions. This test needs the full result object.
  let seenColdStart;
  const repos = {
    projects: { async all() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
    posture: { async list() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
    sourceFiles: { async record() { return { sourceFileId: 1 }; } },
    ingestRuns: {
      async start() { return 5; },
      async liveHashFor() { return null; },
      async finish(id, result) { seenColdStart = result.coldStart; },
    },
    projectVersions: { async appendChanged() { return 1; } },
  };
  const vault = { store: (buf) => ({ hash: "abc123", vaultPath: "2026/08/x.xlsx", bytes: buf.length }) };
  const store = new SqlStore(repos, { vault, logger: quiet });

  await store.applyFile(parsed({ coldStart: true }), { trigger: "boot" });
  assert.equal(seenColdStart, true, "a cold-start parse result did not reach ingestRuns.finish() as coldStart:true");
});

test("a file whose hash has not changed is recorded as unchanged and not rewritten", async () => {
  const { calls, store } = harness({ liveHash: "deadbeef" });
  await store.applyFile(parsed(), { trigger: "watcher" });

  assert.ok(!calls.some((c) => c[0] === "projects.replace"), "an unchanged file was rewritten");
  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.equal(finish[2], "unchanged");
});

test("a file whose bytes match a hash already vaulted, but whose last run failed, is re-applied — not skipped as unchanged", async () => {
  /* This is the regression test for the "seen != live" defect: SourceFile
     durably remembers a hash the moment it is vaulted, even when the ingest
     that vaulted it then failed before dbo.Project was written. If "unchanged"
     were still decided from that ledger, a failed ingest would look identical
     to a successful one on retry — and every re-drop of the exact same file
     would be swallowed as "unchanged" forever, even though nothing was ever
     applied. liveHashFor is null here because the file's only history is a
     failed run (or none at all), which is exactly what forces the retry to do
     the work rather than skip it. */
  const { calls, store } = harness({ liveHash: null });
  await store.applyFile(parsed(), { trigger: "watcher" });

  assert.ok(calls.some((c) => c[0] === "projects.replace"),
    "a retry whose only prior history was a failed run was wrongly skipped as unchanged");
  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.equal(finish[2], "applied");
});

test("a failure still closes the run, with the reason", async () => {
  const { calls, store } = harness();
  store.repos.projects.replaceForFile = async () => { throw new Error("database is down"); };

  await assert.rejects(() => store.applyFile(parsed(), { trigger: "upload" }), /database is down/);

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.ok(finish, "the run was left open");
  assert.equal(finish[2], "failed");
});

test("a history failure after the snapshot moved says so", async () => {
  /* appendChanged rolls itself back, but dbo.Project has already been updated.
     A bare "failed" would read as "nothing happened", which is the opposite of
     what an operator needs to know. */
  const { calls, store } = harness();
  store.repos.projectVersions.appendChanged = async () => { throw new Error("lock timeout"); };

  await assert.rejects(() => store.applyFile(parsed(), { trigger: "watcher" }), /lock timeout/);

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.equal(finish[2], "failed");
  assert.match(finish[3] ?? "", /snapshot applied but history not recorded/);
});

test("a finish() failure after history succeeded records that the run could not be closed", async () => {
  /* appendChanged already committed by the time the closing finish() call
     throws, so both the snapshot and the history are correct — only the run's
     own outcome failed to land. The retry that marks it "failed" must say so
     precisely, not repeat the "history not recorded" message from a stage that
     was never reached. */
  const { calls, store } = harness();
  let finishCalls = 0;
  store.repos.ingestRuns.finish = async (id, result) => {
    finishCalls += 1;
    calls.push(["runs.finish", id, result.outcome, result.error ?? result.projectsChanged]);
    if (finishCalls === 1) throw new Error("connection reset");
  };

  await assert.rejects(() => store.applyFile(parsed(), { trigger: "watcher" }), /connection reset/);

  const finishes = calls.filter((c) => c[0] === "runs.finish");
  assert.equal(finishes.length, 2, "the retry that marks the run failed must still happen");
  assert.equal(finishes[0][2], "applied", "the first attempt was the real close, not a failure");
  assert.equal(finishes[1][2], "failed");
  assert.match(finishes[1][3] ?? "", /snapshot and history applied but the run could not be closed/);
});

test("a refresh() failure after the run closed does not overwrite a correct outcome", async () => {
  /* By the time refresh() runs, ingestRuns.finish() has already recorded
     "applied" durably. A stale in-memory read model must not be reported by
     rewriting that true outcome to "failed" -- that would tell an operator the
     opposite of what actually happened. */
  const { calls, store } = harness();
  store.refresh = async () => { throw new Error("read model refresh exploded"); };

  await assert.rejects(() => store.applyFile(parsed(), { trigger: "watcher" }), /read model refresh exploded/);

  const finishes = calls.filter((c) => c[0] === "runs.finish");
  assert.equal(finishes.length, 1, "a stale read model must not trigger a second, overwriting finish() call");
  assert.equal(finishes[0][2], "applied", "the true outcome must not be overwritten with failed");
});

test("a vault failure is recorded as a failed run, not as no run at all", async () => {
  /* The vault write happens before any database write. If it throws and the
     run were opened later, there would be nothing anywhere saying why the
     workbook never appeared. */
  const { calls, store } = harness();
  store.vault = { store() { throw new Error("vault write failed for master.xlsx: EACCES"); } };

  await assert.rejects(() => store.applyFile(parsed(), { trigger: "watcher" }), /vault write failed/);

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.ok(finish, "a vault failure left no run behind");
  assert.equal(finish[2], "failed");
  assert.ok(!calls.some((c) => c[0] === "projects.replace"), "the database was written despite the vault failing");
});

test("removing a file records a run too", async () => {
  const { calls, store } = harness();
  await store.removeFile("master.xlsx");

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.equal(finish[2], "removed");
});

test("a removal that fails still closes the run, with a reason, and rethrows", async () => {
  /* An abandoned open run is invisible to liveHashFor, which only looks at
     closed runs -- so a removal that dies here without closing its run would
     leave the old hash looking live while the project rows are already gone,
     and re-dropping the same workbook would be wrongly skipped as unchanged. */
  const { calls, store } = harness();
  store.repos.projects.removeFile = async () => { throw new Error("database is down"); };

  await assert.rejects(() => store.removeFile("master.xlsx"), /database is down/);

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.ok(finish, "the run was left open");
  assert.equal(finish[2], "failed");
  assert.match(finish[3] ?? "", /removal failed/);
});

test("a removal whose refresh() fails still leaves the run closed as removed, not overwritten", async () => {
  const { calls, store } = harness();
  store.refresh = async () => { throw new Error("read model refresh exploded"); };

  await assert.rejects(() => store.removeFile("master.xlsx"), /read model refresh exploded/);

  const finishes = calls.filter((c) => c[0] === "runs.finish");
  assert.equal(finishes.length, 1, "a stale read model must not trigger a second, overwriting finish() call");
  assert.equal(finishes[0][2], "removed", "the true outcome must not be overwritten with failed");
});

/* ---------------------------------------------------------------------
 * Concurrency: chokidar fires `add` and `change` independently and does not
 * await one handler before the next, so a single file copy can put two
 * applyFile calls for the same workbook in flight together. Unserialised,
 * they interleave around projects.replaceForFile's delete-then-insert and
 * collide on dbo.Project's primary key — this is the PRJ-1001 defect from
 * the real deployment (IngestRun rows 931/932).
 * ------------------------------------------------------------------- */

test("two concurrent applyFile calls do not let replaceForFile interleave", async () => {
  const { store } = harness();
  const trace = [];
  const originalReplace = store.repos.projects.replaceForFile;
  store.repos.projects.replaceForFile = async (file, projects) => {
    trace.push("enter");
    await new Promise((resolve) => setTimeout(resolve, 15));
    trace.push("exit");
    return originalReplace(file, projects);
  };

  await Promise.all([
    store.applyFile(parsed(), { trigger: "watcher" }),
    store.applyFile(parsed(), { trigger: "watcher" }),
  ]);

  assert.deepEqual(trace, ["enter", "exit", "enter", "exit"],
    "a second applyFile entered replaceForFile before the first had exited — the two ingests interleaved");
});

test("the second of two concurrent identical ingests records unchanged, not a duplicate apply", async () => {
  /* liveHashFor is not a constant here, unlike the shared harness: it must
     reflect that the first ingest's run has actually closed before the
     second is allowed to see its hash as live, exactly as the real
     "last CLOSED run" query would. */
  const calls = [];
  let liveHash = null;
  const repos = {
    projects: {
      async all() { return []; },
      async replaceForFile(file, projects) { calls.push(["projects.replace", file, projects.length]); },
      async removeFile() { return 0; },
    },
    posture: {
      async list() { return []; },
      async replaceForFile() {},
      async removeFile() { return 0; },
    },
    sourceFiles: {
      async record(file) { calls.push(["sourceFiles.record", file.fileName, file.sha256]); return { sourceFileId: 1 }; },
    },
    ingestRuns: {
      async start(run) { calls.push(["runs.start", run.fileName]); return calls.filter((c) => c[0] === "runs.start").length; },
      async liveHashFor() { return liveHash; },
      async finish(id, result) {
        calls.push(["runs.finish", id, result.outcome]);
        if (result.outcome === "applied") liveHash = "deadbeef";
      },
    },
    projectVersions: {
      async appendChanged() { calls.push(["versions.append"]); return 1; },
    },
  };
  const vault = { store(buffer, name) { return { hash: "deadbeef", vaultPath: "2026/08/x.xlsx", bytes: buffer.length }; } };
  const store = new SqlStore(repos, { vault, logger: quiet });

  await Promise.all([
    store.applyFile(parsed(), { trigger: "watcher" }),
    store.applyFile(parsed(), { trigger: "watcher" }),
  ]);

  const finishes = calls.filter((c) => c[0] === "runs.finish");
  assert.equal(finishes.length, 2, "both runs must be opened and closed");
  assert.equal(finishes[0][2], "applied", "the first of the two concurrent ingests must actually apply");
  assert.equal(finishes[1][2], "unchanged",
    "the second, serialised after the first closed, must see the hash it just wrote and record unchanged rather than colliding on dbo.Project");

  const replaceCalls = calls.filter((c) => c[0] === "projects.replace");
  assert.equal(replaceCalls.length, 1, "only the first ingest should have written to dbo.Project — the collision must become a no-op, not a second write");
});

test("a rejection in one queued applyFile does not poison a later one", async () => {
  const { calls, store } = harness();
  let attempts = 0;
  const originalReplace = store.repos.projects.replaceForFile;
  store.repos.projects.replaceForFile = async (file, projects) => {
    attempts += 1;
    if (attempts === 1) throw new Error("database is down");
    return originalReplace(file, projects);
  };

  const first = store.applyFile(parsed(), { trigger: "watcher" });
  const second = store.applyFile(parsed(), { trigger: "watcher" });

  await assert.rejects(first, /database is down/);
  await assert.doesNotReject(second, "a failure in the first queued ingest broke the chain for the second");

  const finishes = calls.filter((c) => c[0] === "runs.finish");
  assert.equal(finishes.length, 2);
  assert.equal(finishes[0][2], "failed");
  assert.equal(finishes[1][2], "applied");
});

test("removeFile is serialised against applyFile, in call order", async () => {
  const { store } = harness();
  const trace = [];
  const originalReplace = store.repos.projects.replaceForFile;
  store.repos.projects.replaceForFile = async (file, projects) => {
    trace.push("apply-enter");
    await new Promise((resolve) => setTimeout(resolve, 15));
    trace.push("apply-exit");
    return originalReplace(file, projects);
  };
  const originalRemove = store.repos.projects.removeFile;
  store.repos.projects.removeFile = async (file) => {
    trace.push("remove-enter");
    await new Promise((resolve) => setTimeout(resolve, 0));
    trace.push("remove-exit");
    return originalRemove(file);
  };

  await Promise.all([
    store.applyFile(parsed(), { trigger: "watcher" }),
    store.removeFile("master.xlsx"),
  ]);

  assert.deepEqual(trace, ["apply-enter", "apply-exit", "remove-enter", "remove-exit"],
    "removeFile must wait for the in-flight applyFile to finish rather than interleaving with it");
});

test("a rejected file opens and closes a run with outcome failed and a specific reason", async () => {
  const { calls, store } = harness();
  await store.recordRejectedFile("bad.xlsx", "no recognisable Projects sheet", { trigger: "watcher" });

  const start = calls.find((c) => c[0] === "runs.start");
  assert.deepEqual(start, ["runs.start", "bad.xlsx", "watcher"]);

  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.ok(finish, "the rejection left no run behind");
  assert.equal(finish[2], "failed");
  assert.match(finish[3] ?? "", /no recognisable Projects sheet/,
    "the parse reason must reach the run, not just a generic failure marker");

  assert.equal(store.ingestLog[0].file, "bad.xlsx");
  assert.equal(store.ingestLog[0].ok, false);
});

test("a rejected file is still logged when the store keeps no history", async () => {
  /* STORE=mssql on a database migrated only to Phase 0: no ingestRuns repo at
     all, so recordRejectedFile must fall back to the plain ingest log rather
     than throwing on a repo that does not exist. */
  const repos = {
    projects: { async all() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
    posture: { async list() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
  };
  const store = new SqlStore(repos, { logger: quiet });

  await store.recordRejectedFile("bad.xlsx", "corrupt zip", { trigger: "boot" });

  assert.equal(store.ingestLog[0].file, "bad.xlsx");
  assert.equal(store.ingestLog[0].ok, false);
  assert.equal(store.ingestLog[0].error, "corrupt zip");
});

test("a rejection whose run cannot even be opened is swallowed, not thrown", async () => {
  const { calls, store } = harness();
  store.repos.ingestRuns.start = async () => { throw new Error("connection reset"); };

  await assert.doesNotReject(
    () => store.recordRejectedFile("bad.xlsx", "corrupt zip", { trigger: "watcher" }),
    "recording a rejection must never be what breaks the watcher"
  );
  assert.ok(!calls.some((c) => c[0] === "runs.finish"), "finish() was called on a run that never opened");
  assert.equal(store.ingestLog[0].file, "bad.xlsx", "the console-visible log must still happen");
});

test("history is optional, so the store still works without it", async () => {
  /* STORE=mssql on a database migrated only to Phase 0 must not crash. */
  const repos = {
    projects: { async all() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
    posture: { async list() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
  };
  const store = new SqlStore(repos, { logger: quiet });
  await store.applyFile(parsed(), { trigger: "boot" });
  assert.equal(store.projectCount, 0);
});

test("the store turns recorded versions into comparisons", async () => {
  const { store } = harness();
  let calledWith;
  store.repos.projectVersions.changedSince = async (sinceISO) => {
    calledWith = sinceISO;
    return new Map([
      ["PRJ-1", {
        baseline: { health: "Green", status: "In Progress", percentComplete: 40, budget: 1000, spent: 300,
                    openRisks: 1, openQuestions: 0, targetEndDate: "2026-06-30", recordedAt: "2026-08-18T09:00:00.000Z" },
        current: { health: "Red", status: "In Progress", percentComplete: 45, budget: 1000, spent: 300,
                   openRisks: 1, openQuestions: 0, targetEndDate: "2026-06-30", recordedAt: "2026-08-25T09:00:00.000Z" },
        trackedSince: null,
      }],
    ]);
  };

  const changes = await store.changesSince("2026-08-18");
  assert.equal(calledWith, "2026-08-18", "the date passed to changesSince must reach the repository unchanged");
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

test("a pair whose hash differs only in an untracked field is dropped, not reported as a change", async () => {
  /* changedSince finds this pair because ContentHash differs, but every
     TRACKED_FIELDS value is identical -- compareVersions correctly says
     "nothing tracked moved" and returns null. The project must not appear in
     the result at all; inventing an entry for it would tell the briefing
     something happened when it did not. */
  const { store } = harness();
  store.repos.projectVersions.changedSince = async () => new Map([
    ["PRJ-3", {
      baseline: { health: "Green", status: "In Progress", percentComplete: 40, budget: 1000, spent: 300,
                  openRisks: 1, openQuestions: 0, targetEndDate: "2026-06-30", recordedAt: "2026-08-18T09:00:00.000Z" },
      current: { health: "Green", status: "In Progress", percentComplete: 40, budget: 1000, spent: 300,
                 openRisks: 1, openQuestions: 0, targetEndDate: "2026-06-30", recordedAt: "2026-08-25T09:00:00.000Z" },
      trackedSince: null,
    }],
  ]);

  const changes = await store.changesSince("2026-08-18");
  assert.equal(changes.has("PRJ-3"), false);
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

/* The in-memory store has no dedicated unit-test file of its own — it is
   otherwise exercised only through test/api/app.test.js at the route level.
   Task 4's test/domain/annotate.test.js does not exist yet, and creating it
   is that task's job, not this one's, so this lives here: the only test file
   Task 3 owns, next to the SqlStore half of the same "null vs empty" contract. */
test("the in-memory store never claims to know what changed", async () => {
  const { Store } = await import("../../server/store.js");
  assert.equal(await new Store().changesSince("2026-08-18"), null);
});

test("historyStartedAt is null when the store keeps no history", async () => {
  const repos = {
    projects: { async all() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
    posture: { async list() { return []; }, async replaceForFile() {}, async removeFile() { return 0; } },
  };
  const store = new SqlStore(repos, { logger: quiet });
  assert.equal(await store.historyStartedAt(), null);
});

test("historyStartedAt delegates to the repository when history is tracked", async () => {
  const { store } = harness();
  store.repos.projectVersions.oldestRecordedAt = async () => "2026-08-18T09:00:00.000Z";
  assert.equal(await store.historyStartedAt(), "2026-08-18T09:00:00.000Z");
});

test("the in-memory store never claims to know when history began", async () => {
  const { Store } = await import("../../server/store.js");
  assert.equal(await new Store().historyStartedAt(), null);
});
