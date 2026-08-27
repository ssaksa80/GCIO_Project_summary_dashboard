/**
 * The boot-time decision of whether THIS process ingests (server/ingestRole.js).
 *
 * Pulled out of index.js so the two branches that matter most for the
 * defects this project has fixed can be driven directly, with fakes standing
 * in for the real election, the real disk sweep, the real chokidar watcher,
 * and the real follower read-model poll:
 *
 *   - a follower must never touch the watcher (two-watchers-one-folder), and
 *   - a leader must never poll for changes it already refreshes itself on
 *     every ingest, while a follower -- which ingests nothing -- must, or
 *     its read model freezes at whatever it was at boot forever.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { startIngestRole } from "../../server/ingestRole.js";

const quiet = () => {};

/** A spy standing in for the real startFollowerRefresh (server/readModelRefresh.js). */
function spyFollowerRefresh(marker = "stopFollowerRefresh") {
  const calls = [];
  const fn = () => { calls.push(true); return marker; };
  fn.calls = calls;
  return fn;
}

test("STORE=memory never calls electLeader or startFollowerRefresh -- no election, no lock, watches as before", async () => {
  const calls = [];
  const electLeader = async () => { calls.push("electLeader"); return { isLeader: true }; };
  const sweep = async () => { calls.push("sweep"); };
  const startWatcher = () => { calls.push("startWatcher"); return { closed: false }; };
  const startFollowerRefresh = spyFollowerRefresh();

  const result = await startIngestRole({ storeType: "memory", electLeader, sweep, startWatcher, startFollowerRefresh, log: quiet });

  assert.deepEqual(calls, ["sweep", "startWatcher"], "memory mode must sweep and watch, and must never elect");
  assert.equal(startFollowerRefresh.calls.length, 0, "memory mode has no shared state to poll for");
  assert.equal(result.isLeader, true);
  assert.equal(result.election, null);
  assert.equal(result.stopFollowerRefresh, null);
});

test("STORE=mssql, granted the lock -> sweeps, starts the watcher, and does NOT start the follower poll", async () => {
  const calls = [];
  const electLeader = async () => ({ isLeader: true, resource: "gcio-ingest:c:/gcio/data" });
  const sweep = async () => { calls.push("sweep"); };
  const startWatcher = () => { calls.push("startWatcher"); return { id: "watcher" }; };
  const startFollowerRefresh = spyFollowerRefresh();

  const result = await startIngestRole({ storeType: "mssql", electLeader, sweep, startWatcher, startFollowerRefresh, log: quiet });

  assert.deepEqual(calls, ["sweep", "startWatcher"]);
  assert.equal(startFollowerRefresh.calls.length, 0,
    "the leader already refreshes on every ingest -- a poll here would be redundant work and a second code path");
  assert.equal(result.isLeader, true);
  assert.deepEqual(result.watcher, { id: "watcher" });
  assert.equal(result.stopFollowerRefresh, null);
});

test("STORE=mssql, refused the lock -> does not sweep, does not start the watcher, and DOES start the follower poll", async () => {
  const calls = [];
  const electLeader = async () => ({ isLeader: false, refusalReason: "timeout" });
  const sweep = async () => { calls.push("sweep"); };
  const startWatcher = () => { calls.push("startWatcher"); return { id: "watcher" }; };
  const startFollowerRefresh = spyFollowerRefresh("stop-handle");

  const result = await startIngestRole({ storeType: "mssql", electLeader, sweep, startWatcher, startFollowerRefresh, log: quiet });

  assert.deepEqual(calls, [], "a follower must neither sweep the disk nor start the watcher");
  assert.equal(startFollowerRefresh.calls.length, 1,
    "a follower ingests nothing, so without a poll its read model would freeze at boot forever");
  assert.equal(result.isLeader, false);
  assert.equal(result.watcher, null);
  assert.equal(result.stopFollowerRefresh, "stop-handle", "the poll's stop handle must be returned to the caller");
});

test("a refused instance with no startFollowerRefresh wired does not crash (defensive default)", async () => {
  const electLeader = async () => ({ isLeader: false, refusalReason: "timeout" });
  const result = await startIngestRole({
    storeType: "mssql", electLeader, sweep: async () => {}, startWatcher: () => ({}), log: quiet,
  });
  assert.equal(result.isLeader, false);
  assert.equal(result.stopFollowerRefresh, null);
});

test("a follower is logged plainly, including why it was refused", async () => {
  const logs = [];
  const electLeader = async () => ({ isLeader: false, refusalReason: "timeout" });
  await startIngestRole({
    storeType: "mssql",
    electLeader,
    sweep: async () => {},
    startWatcher: () => ({}),
    startFollowerRefresh: spyFollowerRefresh(),
    log: (msg) => logs.push(msg),
  });

  assert.ok(logs.some((m) => /follower/i.test(m) && /timeout/.test(m)),
    `expected a follower log mentioning the refusal reason, got: ${JSON.stringify(logs)}`);
});
