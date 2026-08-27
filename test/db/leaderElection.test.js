/**
 * Ingest leader election (server/db/leaderElection.js).
 *
 * This is the sp_getapplock election the spec's P3 row deferred with "it
 * guards a configuration nobody has deployed" -- that stopped being true the
 * day two real processes watched the same drop folder and collided on
 * dbo.Project's primary key. These tests exercise the pieces without a real
 * SQL Server: the classification of sp_getapplock's return code, the
 * resource-name derivation, the acquire call's shape, connection-loss
 * detection, and the dedicated-connection lifecycle -- all against fakes.
 *
 * What these tests CANNOT prove: that two real processes against a real
 * database actually elect one leader. That is only demonstrated by running
 * two real instances against the live deployment (see the report).
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  lockResourceName,
  classifyLockResult,
  acquireApplock,
  watchForConnectionLoss,
  electIngestLeader,
} from "../../server/db/leaderElection.js";

const quiet = { error() {}, log() {} };

// ------------------------------------------------------------ resource name

test("the resource name identifies the database + drop folder, not the machine", () => {
  const a = lockResourceName("C:\\gcio\\data");
  const b = lockResourceName("c:/gcio/data"); // different case, different slashes
  assert.equal(a, b, "two instances guarding the same folder must collide by design");
  assert.match(a, /^gcio-ingest:/);
  assert.ok(!a.includes(String(process.pid)), "must not embed this process's pid");
});

test("different drop folders get different resource names", () => {
  const a = lockResourceName("C:\\gcio\\data");
  const b = lockResourceName("C:\\gcio-staging\\data");
  assert.notEqual(a, b);
});

// -------------------------------------------------------- classifying codes

test("0 and 1 are both granted -- this process leads", () => {
  assert.deepEqual(classifyLockResult(0), { leader: true });
  assert.deepEqual(classifyLockResult(1), { leader: true });
});

test("-1, -2, -3 are refusals -- this process follows", () => {
  assert.deepEqual(classifyLockResult(-1), { leader: false, reason: "timeout" });
  assert.deepEqual(classifyLockResult(-2), { leader: false, reason: "cancelled" });
  assert.deepEqual(classifyLockResult(-3), { leader: false, reason: "deadlock victim" });
});

test("-999 (bad parameter) is surfaced as an error, never silently read as follower", () => {
  assert.throws(() => classifyLockResult(-999), /not one of the documented outcomes/);
});

test("any other undocumented code is also an error, not a guess", () => {
  assert.throws(() => classifyLockResult(2));
  assert.throws(() => classifyLockResult(-4));
});

// ------------------------------------------------------------ acquireApplock

/** A scripted Executor (query/tx), the same shape repos.test.js fakes. */
function scriptedExecutor(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      const next = script[Math.min(i, script.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("acquireApplock sends Exclusive/Session/LockTimeout=0 and reads back the code", async () => {
  const ex = scriptedExecutor([{ recordset: [{ Result: 0 }] }]);
  const outcome = await acquireApplock(ex, "gcio-ingest:c:/gcio/data");

  assert.equal(outcome.leader, true);
  assert.equal(outcome.code, 0);
  const [{ params }] = ex.calls;
  assert.equal(params.find((p) => p.name === "resource").value, "gcio-ingest:c:/gcio/data");
  assert.equal(params.find((p) => p.name === "lockMode").value, "Exclusive");
  assert.equal(params.find((p) => p.name === "lockOwner").value, "Session");
  assert.equal(params.find((p) => p.name === "lockTimeout").value, 0);
});

test("acquireApplock reports a refusal without throwing", async () => {
  const ex = scriptedExecutor([{ recordset: [{ Result: -1 }] }]);
  const outcome = await acquireApplock(ex, "gcio-ingest:x");
  assert.equal(outcome.leader, false);
  assert.equal(outcome.reason, "timeout");
});

test("acquireApplock propagates the -999 error rather than returning a result", async () => {
  const ex = scriptedExecutor([{ recordset: [{ Result: -999 }] }]);
  await assert.rejects(() => acquireApplock(ex, "gcio-ingest:x"), /not one of the documented outcomes/);
});

// ------------------------------------------------------ connection-loss watch

test("watchForConnectionLoss calls onLost exactly once when a heartbeat fails", async () => {
  let ticks = 0;
  const ex = {
    async query() {
      ticks += 1;
      if (ticks >= 2) throw new Error("Connection is closed.");
      return { recordset: [{ ok: 1 }] };
    },
  };
  const lost = [];
  const stop = watchForConnectionLoss(ex, { intervalMs: 5, onLost: (err) => lost.push(err) });

  await new Promise((r) => setTimeout(r, 60));
  stop();
  const afterStop = ticks;
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(lost.length, 1, "onLost should fire exactly once");
  assert.match(lost[0].message, /closed/);
  assert.equal(ticks, afterStop, "the poll must stop once stopped");
});

test("watchForConnectionLoss never fires while every heartbeat succeeds", async () => {
  const ex = { query: async () => ({ recordset: [{ ok: 1 }] }) };
  const lost = [];
  const stop = watchForConnectionLoss(ex, { intervalMs: 5, onLost: (err) => lost.push(err) });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.equal(lost.length, 0);
});

// -------------------------------------------------------------- electIngestLeader

/** Mirrors test/db/executor.test.js's fakePool, plus a spyable close(). */
function fakeConnection(script) {
  let i = 0;
  const closeCalls = [];
  return {
    closeCalls,
    async close() { closeCalls.push(true); },
    request() {
      return {
        input() { return this; },
        async query(text) {
          const next = script[Math.min(i, script.length - 1)];
          i += 1;
          if (next instanceof Error) throw next;
          return next;
        },
      };
    },
  };
}

test("granted -> isLeader true, and the dedicated connection is kept open", async () => {
  const conn = fakeConnection([{ recordset: [{ Result: 0 }] }]);
  const election = await electIngestLeader({
    dataDir: "C:\\gcio\\data",
    logger: quiet,
    connect: async () => conn,
  });

  assert.equal(election.isLeader, true);
  assert.equal(conn.closeCalls.length, 0, "a leader's connection must not be closed");
  await election.close();
  assert.equal(conn.closeCalls.length, 1);
});

test("refused -> isLeader false, and the now-useless dedicated connection is closed", async () => {
  const conn = fakeConnection([{ recordset: [{ Result: -1 }] }]);
  const election = await electIngestLeader({
    dataDir: "C:\\gcio\\data",
    logger: quiet,
    connect: async () => conn,
  });

  assert.equal(election.isLeader, false);
  assert.equal(election.refusalReason, "timeout");
  assert.equal(conn.closeCalls.length, 1, "a follower has no use for the dedicated connection");
});

test("-999 -> electIngestLeader throws (not 'follower'), and still cleans up the connection", async () => {
  const conn = fakeConnection([{ recordset: [{ Result: -999 }] }]);
  await assert.rejects(
    () => electIngestLeader({ dataDir: "C:\\gcio\\data", logger: quiet, connect: async () => conn }),
    /not one of the documented outcomes/
  );
  assert.equal(conn.closeCalls.length, 1, "the connection must still be cleaned up on a malformed call");
});

test("losing the dedicated connection reports loss through watchForLoss", async () => {
  const conn = fakeConnection([
    { recordset: [{ Result: 0 }] }, // the initial applock acquisition
    { recordset: [{ ok: 1 }] },     // one healthy heartbeat
    new Error("Connection is closed."), // then the connection drops
  ]);
  const election = await electIngestLeader({
    dataDir: "C:\\gcio\\data",
    logger: quiet,
    connect: async () => conn,
  });
  assert.equal(election.isLeader, true);

  const lost = [];
  election.watchForLoss((err) => lost.push(err), { intervalMs: 5 });
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(lost.length, 1, "watchForLoss must report the drop exactly once");
  await election.close();
});
