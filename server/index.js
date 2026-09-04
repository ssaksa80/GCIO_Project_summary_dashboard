/**
 * Process entry point.
 *
 * Resolves configuration, chooses a store, applies migrations, ingests what is
 * already on disk, starts the drop-folder watcher, and listens. All routing
 * lives in app.js so the tests can drive it without a socket.
 */
/* Load .env before anything reads process.env. In production the service
   wrapper injects the environment directly and there is no file, which is why
   this is `config` rather than a hard require: a missing .env is normal. */
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dayjs from "dayjs";

import { createApp } from "./app.js";
import { loadConfig, resolveStateDir } from "./config.js";
import { Store } from "./store.js";
import { SqlStore } from "./store/sqlStore.js";
import { ingestDirectory, ingestFile, applyResult, watchDataDir } from "./ingest.js";
import { getPool, resetPool } from "./db/pool.js";
import { makeExecutor } from "./db/executor.js";
import { migrate } from "./db/migrations.js";
import { electIngestLeader } from "./db/leaderElection.js";
import { startIngestRole } from "./ingestRole.js";
import { startFollowerRefresh } from "./readModelRefresh.js";
import { projectsRepo } from "./repos/projects.js";
import { postureRepo } from "./repos/posture.js";
import { auditRepo } from "./repos/audit.js";
import { sessionsRepo } from "./repos/sessions.js";
import { roleMappingRepo } from "./repos/roleMapping.js";
import { userRoleMappingRepo } from "./repos/userRoleMapping.js";
import { sourceFilesRepo } from "./repos/sourceFiles.js";
import { ingestRunsRepo } from "./repos/ingestRuns.js";
import { projectVersionsRepo } from "./repos/projectVersions.js";
import { createVault } from "./vault.js";
import { createFileAudit, memorySessions, memoryRoleMapping, memoryUserRoleMapping, devAuthenticate } from "./devBackends.js";
import { makeEntraJwks } from "./auth/entraJwks.js";
import { searchUsers } from "./auth/ldap.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
/* Ships INSIDE the app, so it is right for this to move with ROOT: a release
   bundle stages sample-data alongside the code it belongs to. The drop folder
   and vault below are the opposite case. */
const SAMPLE_DIR = path.join(ROOT, "sample-data");

const config = loadConfig(process.env);

/* Printed here rather than from config.js: that module is loaded by most of the
   test suite, and a module that logs during import makes every one of those
   runs noisier. Warnings are things an operator should fix but that must not
   stop the service -- a plaintext bind password is the current example. */
for (const w of config.warnings) console.warn(`[gcio] WARNING: ${w}`);

/* resolve, not join, and read from config rather than hardcoded: DATA_DIR may
   legitimately be absolute on a real deployment. A bundle installs code to
   <install>/app, which makes ROOT C:\gcio\app -- and if the drop folder moved
   there with it, the folder the operator actually copies workbooks into would
   be orphaned. Nothing would report that: the watcher would sit happily on an
   empty directory, /healthz would stay green, and the portfolio would simply
   stop changing. path.join would also mangle an absolute path into
   C:\gcio\app\C:\gcio\data -- the same bug fixed for the vault in 6bd993c. */
const DATA_DIR = resolveStateDir(ROOT, config.dataDir);
const log = (msg) => console.log(`[gcio ${dayjs().format("HH:mm:ss")}] ${msg}`);

/* ------------------------------------------------------------- backends */

let store;
let backends;

/* Seconds-since-last-refresh feeds gcio_read_model_age_seconds. Only ever
   meaningful for STORE=mssql: the leader bumps it after every ingest (that
   is when SqlStore.refresh() runs for it), a follower bumps it after every
   successful poll (server/readModelRefresh.js) -- both funnel through this
   one variable so the metric means the same thing on either role. Stays
   null for STORE=memory, which has no separate read model to date. */
let lastRefreshAt = null;

if (config.store === "mssql") {
  let live = null;
  const ex = makeExecutor(() => live, { onConnectionError: () => { live = null; resetPool(); } });

  live = await getPool(process.env);
  const { applied } = await migrate(ex);
  log(applied.length ? `applied migrations ${applied.join(", ")}` : "schema is current");

  const repos = {
    projects: projectsRepo(ex),
    posture: postureRepo(ex),
    audit: auditRepo(ex),
    sessions: sessionsRepo(ex),
    roleMapping: roleMappingRepo(ex),
    userRoleMapping: userRoleMappingRepo(ex),
    sourceFiles: sourceFilesRepo(ex),
    ingestRuns: ingestRunsRepo(ex),
    projectVersions: projectVersionsRepo(ex),
  };

  store = new SqlStore({
    projects: repos.projects,
    posture: repos.posture,
    sourceFiles: repos.sourceFiles,
    ingestRuns: repos.ingestRuns,
    projectVersions: repos.projectVersions,
    /* resolve, not join: VAULT_DIR may legitimately be absolute on a real
       deployment, and path.join would then produce C:\gcio\C:\gcioault.
       Found by actually deploying, where the ingest failed with ENOENT on a
       doubled path while the preflight had happily validated the real one. */
  }, { vault: createVault(resolveStateDir(ROOT, config.vaultDir)) });
  await store.refresh();
  lastRefreshAt = Date.now();
  log(`loaded ${store.projectCount} projects from SQL`);

  /* A fresh database has no role mappings, and with none every sign-in folds
     to no role and is refused — including the administrator who would create
     the first mapping. Seed one, or say loudly that nobody can get in. */
  const seeded = await repos.roleMapping.seedIfEmpty(config.seedAdminGroup);
  if (seeded) {
    log(`seeded role mapping: ${seeded} -> admin (first run)`);
  } else if ((await repos.roleMapping.list()).length === 0) {
    log("WARNING: dbo.RoleMapping is empty, so no sign-in can succeed. " +
        "Set SEED_ADMIN_GROUP and restart, or insert a row into dbo.RoleMapping.");
  }

  backends = {
    audit: repos.audit,
    sessions: repos.sessions,
    roleMapping: repos.roleMapping,
    userRoleMapping: repos.userRoleMapping,
    /* The console's picker. Bound to the running config so a deployment
       with no service account fails with the reason rather than an empty
       list that reads as "no such person". */
    searchDirectory: (q) => searchUsers(q, config.ldap),
    ingestRuns: repos.ingestRuns,
  };
} else {
  store = new Store();
  backends = {
    audit: createFileAudit(path.resolve(ROOT, config.auditDir)),
    sessions: memorySessions(),
    /* All three, so switching DEV_ROLE works without also editing a map:
       devAuthenticate returns the matching group for whichever role is set. */
    roleMapping: memoryRoleMapping({
      "gcio-dashboard-viewers": "viewer",
      "gcio-dashboard-pms": "pm",
      "gcio-dashboard-admins": "admin",
    }),
    /* In memory, so grants last only as long as the process. Enough for the
       console to be developed and demonstrated without SQL Server. */
    userRoleMapping: memoryUserRoleMapping(),
    /* AUTH_MODE=dev has no directory to search. Left null so the route
       answers "not configured" rather than returning an empty list that
       reads as "nobody by that name". */
    searchDirectory: null,
    /* No database, so no run history to show. The route says so rather than
       pretending the list is empty. */
    ingestRuns: null,
  };
  log("store: in-memory (set STORE=mssql for the database-backed store)");
}

/* -------------------------------------------------- ingest what is on disk */

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Persist one parse result through whichever store is in play. */
async function apply(result) {
  if (store instanceof SqlStore) {
    if (!result.ok) {
      await store.recordRejectedFile(result.file, result.error, { trigger: "boot" });
      return 0;
    }
    const n = await store.applyFile(result, { trigger: "boot" });
    lastRefreshAt = Date.now(); // applyFile just called store.refresh() internally
    return n;
  }
  return applyResult(store, result);
}

/** Sweep whatever is already on disk. Runs only for the ingest leader on
 *  STORE=mssql; runs unconditionally on STORE=memory, unchanged from before
 *  ingest election existed (see server/ingestRole.js). */
async function sweepDisk() {
  if (config.store === "mssql") {
    /* SQL already holds the portfolio; only ingest files whose contents are new
       to it. A restart must not rewrite every row for no reason. */
    const known = new Set([...store.sourceFiles]);
    const onDisk = fs.readdirSync(DATA_DIR).filter((f) => !f.startsWith("."));
    for (const file of onDisk) {
      if (known.has(file)) continue;
      const parsed = ingestFile(path.join(DATA_DIR, file));
      await apply(parsed);
    }
    if (store.projectCount === 0) log("no data yet — drop workbooks into data/ or upload them");
  } else {
    const fromData = ingestDirectory(store, DATA_DIR);
    if (fromData.files > 0) {
      log(`ingested ${store.projectCount} projects from ${fromData.files} workbook(s) in data/`);
    } else {
      const fromSample = ingestDirectory(store, SAMPLE_DIR);
      if (fromSample.files > 0) {
        store.demoMode = true;
        log(`demo mode: ingested ${store.projectCount} projects from ${fromSample.files} sample workbook(s)`);
      } else if (store.loadCache(DATA_DIR)) {
        log(`restored ${store.projectCount} projects from cache snapshot`);
      } else {
        log("no data yet — waiting for workbooks in data/ or an upload");
      }
    }
    if (store.projectCount > 0) store.lastIngestAt = store.lastIngestAt || new Date().toISOString();
  }
}

/* ------------------------------------------------------------- watcher */

/**
 * One place decides what an ingest means, for either store. The watcher only
 * reports that a file appeared, changed or went away. Only ever started for
 * the ingest leader on STORE=mssql; always started on STORE=memory.
 */
function startWatcher() {
  return watchDataDir(DATA_DIR, {
    onUpsert: async (filePath) => {
      const parsed = ingestFile(filePath);
      if (!parsed.ok) {
        const fileName = path.basename(filePath);
        if (store instanceof SqlStore) {
          await store.recordRejectedFile(fileName, parsed.error, { trigger: "watcher" });
        } else {
          store.log({ file: fileName, ok: false, error: parsed.error });
        }
        log(`rejected ${fileName}: ${parsed.error}`);
        return;
      }
      if (store instanceof SqlStore) {
        await store.applyFile(parsed, { trigger: "watcher" });
        lastRefreshAt = Date.now(); // applyFile just called store.refresh() internally
      } else {
        applyResult(store, parsed);
        if (store.demoMode) store.demoMode = false;
        store.saveCache(DATA_DIR);
      }
    },

    onRemove: async (fileName) => {
      /* SqlStore.removeFile already records the removal and refreshes the read
         model; the in-memory one only deletes, so it is logged here. */
      if (store instanceof SqlStore) {
        await store.removeFile(fileName);
        lastRefreshAt = Date.now(); // removeFile just called store.refresh() internally
        return;
      }
      const removed = store.removeFile(fileName);
      if (removed > 0) {
        store.lastIngestAt = new Date().toISOString();
        store.log({ file: fileName, ok: true, removed });
        store.saveCache(DATA_DIR);
      }
    },

    onBatch: ({ files }) => {
      store.emit("ingest", { files, projectCount: store.projectCount, at: store.lastIngestAt });
      log(`live ingest: ${files.join(", ")} -> ${store.projectCount} projects`);
    },

    logger: { error: (msg) => log(msg) },
  });
}

/* --------------------------------------------------- ingest leader election */

/**
 * Exactly one process may watch the drop folder and ingest against a given
 * database -- this is the sp_getapplock election the spec's P3 row deferred
 * ("it guards a configuration nobody has deployed"), built now because a
 * stray process left watching the same folder as a fresh one collided on
 * dbo.Project's primary key. See server/db/leaderElection.js for the "trap"
 * (a session-scoped lock needs its own dedicated connection) and
 * server/ingestRole.js for the boot-time decision this wires up.
 *
 * STORE=memory takes none of this: no database, no shared state to collide
 * over, so it sweeps and watches exactly as it did before this existed.
 */
let isIngestLeader = true;

const ingestRole = await startIngestRole({
  storeType: config.store,
  electLeader: () => electIngestLeader({ env: process.env, dataDir: DATA_DIR, logger: console }),
  sweep: sweepDisk,
  startWatcher,
  /* Only ever called on the follower branch (see ingestRole.js): a follower
     ingests nothing, so without this its read model is exactly what
     store.refresh() returned at boot, forever, no matter how much the
     leader ingests later. */
  startFollowerRefresh: () => startFollowerRefresh({
    store,
    log,
    onRefreshed: () => { lastRefreshAt = Date.now(); },
  }),
  log,
});

isIngestLeader = ingestRole.isLeader;
let watcher = ingestRole.watcher;

if (config.store === "mssql" && ingestRole.election?.isLeader) {
  /* Losing the lock later matters as much as never getting it: the
     dedicated connection can drop out from under a leader that is otherwise
     healthy. Deliberately NOT automatic failover -- that is a bigger change
     than this fix, and honest degradation (stop ingesting, say so loudly)
     beats a half-built one. A restart is what re-enters the election. */
  ingestRole.election.watchForLoss((err) => {
    log(`LOST THE INGEST LOCK's connection (${err.message}) -- stopping the watcher. ` +
        `This process keeps serving reads from SQL but will NOT re-elect itself; ` +
        `no automatic failover is built. Restart this process to re-enter the election.`);
    isIngestLeader = false;
    const dying = watcher;
    watcher = null;
    Promise.resolve(dying?.close?.())
      .catch((closeErr) => log(`closing the watcher after losing the lock failed: ${closeErr.message}`));
    /* From this instant this process IS a follower -- one that will never
       re-elect itself -- and its read model would otherwise freeze at
       whatever it last held, for exactly the same reason an ordinary
       follower's would without server/readModelRefresh.js. */
    startFollowerRefresh({ store, log, onRefreshed: () => { lastRefreshAt = Date.now(); } });
  });
}

/* ---------------------------------------------------------------- serve */

const entraJwks = config.ssoEnabled
  ? makeEntraJwks({ tenantId: config.entra.tenantId, offlineKeys: config.entra.offlineKeys })
  : null;

const app = createApp({
  store,
  config,
  entraJwks,
  /* Spread, NOT enumerated. Every backend this file builds reaches createApp
     by construction, so adding one to `backends` cannot silently fail to be
     wired. Enumerating them cost a live 403: userRoleMapping was added to
     `backends` and not to this list, so resolveAccess saw no per-user grants,
     fell through to group roles, and refused a user whose grant was sitting in
     the table. Nothing failed loudly - the feature was simply absent, and the
     unit tests could not see it because they construct createApp directly. */
  ...backends,
  ldapAuthenticate: config.authMode === "dev" ? devAuthenticate(config.devRole) : undefined,
  dataDir: DATA_DIR,
  clientDist: path.join(ROOT, "client", "dist"),
  isIngestLeader: () => isIngestLeader,
  readModelAgeSeconds: () => (
    lastRefreshAt === null ? null : Math.round((Date.now() - lastRefreshAt) / 1000)
  ),
});

process.on("unhandledRejection", (err) => console.error(`[gcio] unhandled rejection: ${err && err.stack}`));
process.on("uncaughtException", (err) => console.error(`[gcio] uncaught exception: ${err && err.stack}`));

app.listen(config.port, config.host, () => {
  log(`GCIO Project Intelligence listening on http://${config.host}:${config.port}`);
  log(`store: ${config.store} · auth: ${config.authMode}${config.authMode === "dev" ? ` (role ${config.devRole})` : ""}`);
  log(isIngestLeader
    ? `watching ${DATA_DIR} for workbooks (24x7 live ingestion)`
    : `NOT watching ${DATA_DIR} -- another instance holds the ingest lock; serving reads from SQL only`);
});
