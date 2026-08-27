/**
 * Decide, once per boot, whether THIS process ingests -- and if so, sweep
 * whatever is already on disk and start the watcher.
 *
 * Pulled out of index.js so the one branch that matters most for the defect
 * this closes -- two processes watching one drop folder, both ingesting,
 * colliding on dbo.Project's primary key -- can be driven directly with
 * fakes standing in for the real election (server/db/leaderElection.js), the
 * real disk sweep, and the real chokidar watcher (server/ingest.js), rather
 * than only inferred from booting a real server against a real database.
 *
 * STORE=memory never calls `electLeader` at all: there is no database and no
 * shared state to collide over, so this is exactly the code path that ran
 * before ingest election existed, unchanged.
 */

/**
 * @param {{
 *   storeType: "memory"|"mssql",
 *   electLeader: () => Promise<{isLeader: boolean, refusalReason?: string, resource?: string}>,
 *   sweep: () => Promise<void>,
 *   startWatcher: () => object,
 *   log?: (msg: string) => void,
 * }} deps
 * @returns {Promise<{isLeader: boolean, watcher: object|null, election: object|null}>}
 */
export async function startIngestRole({ storeType, electLeader, sweep, startWatcher, log = () => {} }) {
  if (storeType !== "mssql") {
    await sweep();
    return { isLeader: true, watcher: startWatcher(), election: null };
  }

  const election = await electLeader();
  if (!election.isLeader) {
    log(`follower: another instance holds the ingest lock (refused: ${election.refusalReason}) ` +
        `-- serving from SQL, not watching or ingesting`);
    return { isLeader: false, watcher: null, election };
  }

  log(`elected ingest leader (lock "${election.resource}") -- watching the drop folder`);
  await sweep();
  return { isLeader: true, watcher: startWatcher(), election };
}
