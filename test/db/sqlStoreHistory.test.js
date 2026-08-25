/**
 * SqlStore's history side. The repositories are faked: what matters here is
 * that a run is always opened and always closed, that the vault is written
 * before anything else, and that an unchanged file is recognised as such.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SqlStore } from "../../server/store/sqlStore.js";

const quiet = { error() {}, info() {} };

function harness({ newestHash = null, changed = 2 } = {}) {
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
      async newestHashFor() { return newestHash; },
    },
    ingestRuns: {
      async start(run) { calls.push(["runs.start", run.fileName, run.trigger]); return 99; },
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

test("a file whose hash has not changed is recorded as unchanged and not rewritten", async () => {
  const { calls, store } = harness({ newestHash: "deadbeef" });
  await store.applyFile(parsed(), { trigger: "watcher" });

  assert.ok(!calls.some((c) => c[0] === "projects.replace"), "an unchanged file was rewritten");
  const finish = calls.find((c) => c[0] === "runs.finish");
  assert.equal(finish[2], "unchanged");
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
