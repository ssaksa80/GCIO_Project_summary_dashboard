/**
 * The executor's contract, exercised against a fake pool. No SQL Server needed:
 * what matters here is parameter binding, the 503 when the pool is gone, and
 * that a dead pool notifies the supervisor instead of surfacing a TypeError.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { makeExecutor } from "../../server/db/executor.js";
import { isConnectionError } from "../../server/db/errors.js";

/** Minimal stand-in for an mssql pool. Records what it was asked to do. */
function fakePool({ throws = null, recordset = [] } = {}) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = [];
      return {
        input(name, type, value) { inputs.push({ name, type, value }); return this; },
        async query(text) {
          calls.push({ text, inputs });
          if (throws) throw throws;
          return { recordset, rowsAffected: [recordset.length] };
        },
      };
    },
  };
}

const quiet = { error() {}, info() {} };

test("parameters are bound, never interpolated", async () => {
  const pool = fakePool({ recordset: [{ Id: 1 }] });
  const ex = makeExecutor(pool, { logger: quiet });

  await ex.query("SELECT * FROM T WHERE Name = @name", [{ name: "name", type: "nvarchar", value: "O'Brien" }]);

  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].text, "SELECT * FROM T WHERE Name = @name");
  assert.deepEqual(pool.calls[0].inputs, [{ name: "name", type: "nvarchar", value: "O'Brien" }]);
});

test("a null pool raises a 503 rather than a TypeError", async () => {
  const ex = makeExecutor(() => null, { logger: quiet });
  await assert.rejects(() => ex.query("SELECT 1"), (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.code, "db_unavailable");
    return true;
  });
});

test("a pool getter is resolved per call, so a reconnect is picked up", async () => {
  let live = null;
  const ex = makeExecutor(() => live, { logger: quiet });

  await assert.rejects(() => ex.query("SELECT 1"), (err) => err.code === "db_unavailable");

  live = fakePool({ recordset: [{ ok: 1 }] });
  const res = await ex.query("SELECT 1");
  assert.deepEqual(res.recordset, [{ ok: 1 }]);
});

test("a dead connection notifies the supervisor and surfaces as 503", async () => {
  const dead = Object.assign(new Error("Connection is closed."), { code: "ECONNCLOSED" });
  let notified = null;
  const ex = makeExecutor(fakePool({ throws: dead }), {
    logger: quiet,
    onConnectionError: (err) => { notified = err; },
  });

  await assert.rejects(() => ex.query("SELECT 1"), (err) => err.code === "db_unavailable");
  assert.equal(notified, dead);
});

test("a query error is not mistaken for a dead connection", async () => {
  const bad = Object.assign(new Error("Invalid column name 'Nope'."), { number: 207 });
  let notified = false;
  const ex = makeExecutor(fakePool({ throws: bad }), {
    logger: quiet,
    onConnectionError: () => { notified = true; },
  });

  await assert.rejects(() => ex.query("SELECT Nope FROM T"), (err) => err.number === 207);
  assert.equal(notified, false);
});

test("connection errors are recognised by code and by message", () => {
  assert.equal(isConnectionError({ code: "ESOCKET", message: "" }), true);
  assert.equal(isConnectionError({ message: "Connection is closed." }), true);
  assert.equal(isConnectionError({ number: 207, message: "Invalid column name" }), false);
  assert.equal(isConnectionError(null), false);
});
