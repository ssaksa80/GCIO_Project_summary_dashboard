/**
 * Process entry point.
 *
 * Resolves configuration, chooses a store, applies migrations, ingests what is
 * already on disk, starts the drop-folder watcher, and listens. All routing
 * lives in app.js so the tests can drive it without a socket.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dayjs from "dayjs";

import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { SqlStore } from "./store/sqlStore.js";
import { ingestDirectory, ingestFile, applyResult, watchDataDir } from "./ingest.js";
import { getPool, resetPool } from "./db/pool.js";
import { makeExecutor } from "./db/executor.js";
import { migrate } from "./db/migrations.js";
import { projectsRepo } from "./repos/projects.js";
import { postureRepo } from "./repos/posture.js";
import { auditRepo } from "./repos/audit.js";
import { sessionsRepo } from "./repos/sessions.js";
import { roleMappingRepo } from "./repos/roleMapping.js";
import { createFileAudit, memorySessions, memoryRoleMapping, devAuthenticate } from "./devBackends.js";
import { makeEntraJwks } from "./auth/entraJwks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SAMPLE_DIR = path.join(ROOT, "sample-data");

const config = loadConfig(process.env);
const log = (msg) => console.log(`[gcio ${dayjs().format("HH:mm:ss")}] ${msg}`);

/* ------------------------------------------------------------- backends */

let store;
let backends;

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
  };

  store = new SqlStore({ projects: repos.projects, posture: repos.posture });
  await store.refresh();
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

  backends = { audit: repos.audit, sessions: repos.sessions, roleMapping: repos.roleMapping };
} else {
  store = new Store();
  backends = {
    audit: createFileAudit(path.join(ROOT, config.auditDir)),
    sessions: memorySessions(),
    /* All three, so switching DEV_ROLE works without also editing a map:
       devAuthenticate returns the matching group for whichever role is set. */
    roleMapping: memoryRoleMapping({
      "gcio-dashboard-viewers": "viewer",
      "gcio-dashboard-pms": "pm",
      "gcio-dashboard-admins": "admin",
    }),
  };
  log("store: in-memory (set STORE=mssql for the database-backed store)");
}

/* -------------------------------------------------- ingest what is on disk */

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Persist one parse result through whichever store is in play. */
async function apply(result) {
  if (store instanceof SqlStore) {
    if (!result.ok) {
      store.log({ file: result.file, ok: false, error: result.error });
      return 0;
    }
    return store.applyFile(result);
  }
  return applyResult(store, result);
}

if (config.store === "mssql") {
  /* SQL already holds the portfolio; only ingest files whose contents are new
     to it. A restart must not rewrite every row for no reason. */
  const known = new Set([...store.sourceFiles]);
  const onDisk = fs.readdirSync(DATA_DIR).filter((f) => !f.startsWith("."));
  for (const file of onDisk) {
    if (known.has(file)) continue;
    const parsed = ingestFile(path.join(DATA_DIR, file));
    if (parsed.ok) await apply(parsed);
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

/* ------------------------------------------------------------- watcher */

watchDataDir(store, DATA_DIR, async (batch) => {
  if (store instanceof SqlStore) {
    for (const file of batch.files) {
      const full = path.join(DATA_DIR, file);
      if (fs.existsSync(full)) {
        const parsed = ingestFile(full);
        if (parsed.ok) await store.applyFile(parsed);
        else store.log({ file, ok: false, error: parsed.error });
      } else {
        await store.removeFile(file);
      }
    }
  } else {
    store.saveCache(DATA_DIR);
  }
  store.emit("ingest", { files: batch.files, projectCount: store.projectCount, at: store.lastIngestAt });
  log(`live ingest: ${batch.files.join(", ")} -> ${store.projectCount} projects`);
});

/* ---------------------------------------------------------------- serve */

const entraJwks = config.ssoEnabled
  ? makeEntraJwks({ tenantId: config.entra.tenantId, offlineKeys: config.entra.offlineKeys })
  : null;

const app = createApp({
  store,
  config,
  entraJwks,
  sessions: backends.sessions,
  roleMapping: backends.roleMapping,
  audit: backends.audit,
  ldapAuthenticate: config.authMode === "dev" ? devAuthenticate(config.devRole) : undefined,
  dataDir: DATA_DIR,
  clientDist: path.join(ROOT, "client", "dist"),
});

process.on("unhandledRejection", (err) => console.error(`[gcio] unhandled rejection: ${err && err.stack}`));
process.on("uncaughtException", (err) => console.error(`[gcio] uncaught exception: ${err && err.stack}`));

app.listen(config.port, config.host, () => {
  log(`GCIO Project Intelligence listening on http://${config.host}:${config.port}`);
  log(`store: ${config.store} · auth: ${config.authMode}${config.authMode === "dev" ? ` (role ${config.devRole})` : ""}`);
  log(`watching ${DATA_DIR} for workbooks (24x7 live ingestion)`);
});
