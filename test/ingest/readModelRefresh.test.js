/**
 * Keeping a follower's read model from going stale (server/readModelRefresh.js).
 *
 * Before this, a follower called store.refresh() exactly once, at boot, and
 * never again -- it does not ingest, and refresh() only ever ran inside
 * applyFile/removeFile. The leader could double a portfolio and a follower
 * reading /api/summary would show last week's numbers with nothing on the
 * page suggesting anything was wrong. This polls store.refresh() on an
 * interval so a follower is at most one interval behind, and reports failures
 * loudly instead of serving stale data in silence.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { startFollowerRefresh, FOLLOWER_REFRESH_INTERVAL_MS } from "../../server/readModelRefresh.js";

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a condition until it is true, rather than sleep-a-fixed-amount then
 *  assert -- a fixed short sleep is what makes this class of test flaky
 *  under a loaded `node --test` run (many files' timers and real chokidar
 *  watchers compete for one event loop, so a short interval can be delayed
 *  well past its nominal period). Polling tolerates that delay and still
 *  fails fast and loud if the condition is truly never met. */
async function waitUntil(conditionFn, { timeoutMs = 3000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (conditionFn()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

test("the interval has a sane, documented default", () => {
  assert.equal(FOLLOWER_REFRESH_INTERVAL_MS, 30_000);
});

test("a follower refreshes on the interval, with no ingest occurring at all", async () => {
  let calls = 0;
  const store = { refresh: async () => { calls += 1; } };

  const stop = startFollowerRefresh({ store, intervalMs: 15 });
  await waitUntil(() => calls >= 2);
  stop();

  assert.ok(calls >= 2, `expected at least 2 refreshes, got ${calls}`);
});

test("onRefreshed fires once per successful refresh", async () => {
  let refreshed = 0;
  const store = { refresh: async () => {} };

  const stop = startFollowerRefresh({ store, intervalMs: 15, onRefreshed: () => { refreshed += 1; } });
  await waitUntil(() => refreshed >= 2);
  stop();

  assert.ok(refreshed >= 2, `expected onRefreshed to fire at least twice, got ${refreshed}`);
});

test("a failed refresh is logged and does NOT stop later attempts", async () => {
  let calls = 0;
  let refreshed = 0;
  const logs = [];
  const store = { refresh: async () => { calls += 1; throw new Error("database is down"); } };

  const stop = startFollowerRefresh({
    store, intervalMs: 15,
    onRefreshed: () => { refreshed += 1; },
    log: (msg) => logs.push(msg),
  });
  await waitUntil(() => logs.length >= 2);
  stop();

  assert.ok(calls >= 2, "one failure must not end the timer -- later ticks must still run");
  assert.equal(refreshed, 0, "onRefreshed must not fire for a failed refresh");
  assert.ok(logs.length >= 2, "every failed poll should be logged, not just the first");
  assert.ok(logs.every((m) => /database is down/.test(m)), `expected the real error in the log, got: ${JSON.stringify(logs)}`);
});

test("stop() clears the timer -- no refreshes happen after stopping", async () => {
  let calls = 0;
  const store = { refresh: async () => { calls += 1; } };

  const stop = startFollowerRefresh({ store, intervalMs: 15 });
  await waitUntil(() => calls >= 1);
  stop();
  const callsAtStop = calls;
  await settle(200);

  assert.equal(calls, callsAtStop, "a refresh ran after stop() was called");
});

test("the poll timer is unref'd -- it must never be the reason the process stays alive", () => {
  let captured = null;
  const setIntervalFn = (fn, ms) => {
    captured = setInterval(fn, ms);
    return captured;
  };
  const clearIntervalFn = (t) => clearInterval(t);

  const stop = startFollowerRefresh({
    store: { refresh: async () => {} },
    intervalMs: 100_000,
    setIntervalFn,
    clearIntervalFn,
  });

  assert.ok(captured, "the real timer was not captured");
  assert.equal(captured.hasRef(), false, "the interval must be unref'd");
  stop();
});
