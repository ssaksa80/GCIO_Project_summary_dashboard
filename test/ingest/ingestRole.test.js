/**
 * The boot-time decision of whether THIS process ingests (server/ingestRole.js).
 *
 * Pulled out of index.js so the one branch that matters most for the
 * two-watchers-one-folder defect -- a follower must never touch the watcher
 * -- can be driven directly, with fakes standing in for the real election,
 * the real disk sweep, and the real chokidar watcher.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { startIngestRole } from "../../server/ingestRole.js";

const quiet = () => {};

test("STORE=memory never calls electLeader at all -- no election, no lock, watches as before", async () => {
  const calls = [];
  const electLeader = async () => { calls.push("electLeader"); return { isLeader: true }; };
  const sweep = async () => { calls.push("sweep"); };
  const startWatcher = () => { calls.push("startWatcher"); return { closed: false }; };

  const result = await startIngestRole({ storeType: "memory", electLeader, sweep, startWatcher, log: quiet });

  assert.deepEqual(calls, ["sweep", "startWatcher"], "memory mode must sweep and watch, and must never elect");
  assert.equal(result.isLeader, true);
  assert.equal(result.election, null);
});

test("STORE=mssql, granted the lock -> sweeps then starts the watcher", async () => {
  const calls = [];
  const electLeader = async () => ({ isLeader: true, resource: "gcio-ingest:c:/gcio/data" });
  const sweep = async () => { calls.push("sweep"); };
  const startWatcher = () => { calls.push("startWatcher"); return { id: "watcher" }; };

  const result = await startIngestRole({ storeType: "mssql", electLeader, sweep, startWatcher, log: quiet });

  assert.deepEqual(calls, ["sweep", "startWatcher"]);
  assert.equal(result.isLeader, true);
  assert.deepEqual(result.watcher, { id: "watcher" });
});

test("STORE=mssql, refused the lock -> does not sweep and does not start the watcher", async () => {
  const calls = [];
  const electLeader = async () => ({ isLeader: false, refusalReason: "timeout" });
  const sweep = async () => { calls.push("sweep"); };
  const startWatcher = () => { calls.push("startWatcher"); return { id: "watcher" }; };

  const result = await startIngestRole({ storeType: "mssql", electLeader, sweep, startWatcher, log: quiet });

  assert.deepEqual(calls, [], "a follower must neither sweep the disk nor start the watcher");
  assert.equal(result.isLeader, false);
  assert.equal(result.watcher, null);
});

test("a follower is logged plainly, including why it was refused", async () => {
  const logs = [];
  const electLeader = async () => ({ isLeader: false, refusalReason: "timeout" });
  await startIngestRole({
    storeType: "mssql",
    electLeader,
    sweep: async () => {},
    startWatcher: () => ({}),
    log: (msg) => logs.push(msg),
  });

  assert.ok(logs.some((m) => /follower/i.test(m) && /timeout/.test(m)),
    `expected a follower log mentioning the refusal reason, got: ${JSON.stringify(logs)}`);
});
