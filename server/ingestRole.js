/**
 * Decide, once per boot, whether THIS process ingests -- and if so, sweep
 * whatever is already on disk and start the watcher. If it does NOT ingest,
 * start the poll that keeps its read model from freezing at boot forever.
 *
 * Pulled out of index.js so the branches that matter most for the defects
 * this project has fixed can be driven directly with fakes standing in for
 * the real election (server/db/leaderElection.js), the real disk sweep, the
 * real chokidar watcher (server/ingest.js), and the real follower poll
 * (server/readModelRefresh.js) -- rather than only inferred from booting a
 * real server against a real database:
 *
 *   - a follower must never touch the watcher (two processes ingesting the
 *     same drop folder collide on dbo.Project's primary key), and
 *   - a follower MUST poll for changes, because it never calls
 *     applyFile/removeFile itself -- the only places SqlStore.refresh()
 *     otherwise runs -- so without this its read model is exactly what it
 *     was at boot, forever, no matter how much the leader ingests.
 *
 * The leader needs neither: it already refreshes after every ingest, so
 * starting a poll for it too would be redundant work and a second code path
 * to reason about for no benefit -- confirmed below by test, not assumed.
 *
 * STORE=memory never calls `electLeader` or `startFollowerRefresh` at all:
 * there is no database and no shared state to collide over or go stale, so
 * this is exactly the code path that ran before ingest election existed,
 * unchanged.
 */

/**
 * @param {{
 *   storeType: "memory"|"mssql",
 *   electLeader: () => Promise<{isLeader: boolean, refusalReason?: string, resource?: string}>,
 *   sweep: () => Promise<void>,
 *   startWatcher: () => object,
 *   startFollowerRefresh?: () => (() => void),
 *   log?: (msg: string) => void,
 * }} deps
 * @returns {Promise<{isLeader: boolean, watcher: object|null, election: object|null, stopFollowerRefresh: (() => void)|null}>}
 */
export async function startIngestRole({ storeType, electLeader, sweep, startWatcher, startFollowerRefresh, log = () => {} }) {
  if (storeType !== "mssql") {
    await sweep();
    return { isLeader: true, watcher: startWatcher(), election: null, stopFollowerRefresh: null };
  }

  const election = await electLeader();
  if (!election.isLeader) {
    log(`follower: another instance holds the ingest lock (refused: ${election.refusalReason}) ` +
        `-- serving from SQL, not watching or ingesting`);
    const stopFollowerRefresh = startFollowerRefresh ? startFollowerRefresh() : null;
    return { isLeader: false, watcher: null, election, stopFollowerRefresh };
  }

  log(`elected ingest leader (lock "${election.resource}") -- watching the drop folder`);
  await sweep();
  return { isLeader: true, watcher: startWatcher(), election, stopFollowerRefresh: null };
}
