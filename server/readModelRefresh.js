/**
 * Keep a follower's read model from going stale.
 *
 * SqlStore.refresh() already runs inside applyFile/removeFile after every
 * ingest -- that is how the leader's read model stays current. A follower
 * calls neither of those (that is the entire point of not ingesting), so
 * without this, a follower's projectsById/postureRows are exactly whatever
 * refresh() returned at boot -- forever. The leader could double a
 * portfolio and a follower reading /api/summary would show last week's
 * numbers with nothing on the page suggesting anything was wrong.
 *
 * The leader needs none of this: see server/ingestRole.js, which only calls
 * startFollowerRefresh on the follower branch (confirmed by test, not
 * assumed -- see test/ingest/ingestRole.test.js).
 */

/**
 * 30s: a follower is at most this far behind the leader, at the cost of one
 * extra `projects.all()` + `posture.list()` query pair per follower per
 * interval. Cheap at this project's own sizing ceiling (<=5,000 projects,
 * <=300 users, one site) and not worth making configurable until someone can
 * name a real reason to change it -- another knob nobody tunes is not a
 * feature.
 */
export const FOLLOWER_REFRESH_INTERVAL_MS = 30_000;

/**
 * @param {{
 *   store: {refresh: () => Promise<number>},
 *   intervalMs?: number,
 *   log?: (msg: string) => void,
 *   onRefreshed?: () => void,
 *   setIntervalFn?: Function,
 *   clearIntervalFn?: Function,
 * }} options
 * @returns {() => void} stop the poll
 */
export function startFollowerRefresh({
  store,
  intervalMs = FOLLOWER_REFRESH_INTERVAL_MS,
  log = () => {},
  onRefreshed = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const tick = async () => {
    try {
      await store.refresh();
      onRefreshed();
    } catch (err) {
      /* One bad poll must not end the timer: the database may recover
         before the next tick, and a follower that gives up polling after a
         single blip is worse than one that keeps trying and says so. */
      log(`follower read-model refresh failed (will retry in ${Math.round(intervalMs / 1000)}s): ${err.message}`);
    }
  };

  const timer = setIntervalFn(tick, intervalMs);
  /* Must never be the reason this process -- or a test that starts one of
     these and forgets to stop it -- stays alive: a poll that is merely
     scheduled, not yet due, is not a reason to block shutdown. */
  timer.unref?.();

  return () => clearIntervalFn(timer);
}
