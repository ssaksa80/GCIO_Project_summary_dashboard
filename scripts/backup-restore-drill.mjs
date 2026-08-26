/**
 * Back up the live database, restore it under a different name, prove the
 * restored copy holds what the original held, and clean up.
 *
 * A restore procedure nobody has performed is a hope, not a plan. This exists
 * to be run — on a schedule, and before anything anyone is nervous about.
 *
 *   node scripts/backup-restore-drill.mjs [--to DIR] [--as NAME] [--keep] [--drop]
 *
 * ---- Why this looks different from a textbook backup/restore script -------
 *
 * `gcio_app` (the login this script runs as in every environment, because
 * Windows Integrated auth does not work through this project's driver — see
 * the caveat in server/db/pool.js, confirmed again here) is `db_owner` on
 * GCIO but is NOT a member of the `dbcreator` server role and holds no
 * `CREATE ANY DATABASE` permission. Verified on 2026-08-26 against
 * APPSRV1\SQLEXPRESS:
 *
 *   SELECT IS_ROLEMEMBER('db_owner'), IS_ROLEMEMBER('db_backupoperator'),
 *          IS_SRVROLEMEMBER('dbcreator')
 *   -- as gcio_app: 1, 0, 0
 *   -- as the interactive Windows login: 1, 1, 1
 *
 * Consequences, each checked by hand before being relied on here:
 *
 *   - BACKUP DATABASE works (db_owner is sufficient).
 *   - RESTORE FILELISTONLY does NOT work — it demands the same permission as
 *     creating a brand-new database, regardless of target, and fails with
 *     "CREATE DATABASE permission denied in database 'master'" even though
 *     it never creates anything. So this script reads the logical file names
 *     out of msdb's backup history (backupset/backupmediafamily/backupfile)
 *     instead, keyed off the exact backup file this run just wrote. Those
 *     tables are populated by BACKUP DATABASE itself and are readable with
 *     no permission beyond connecting to msdb, so this still satisfies the
 *     original intent — the names come from the backup, not from a guess —
 *     without needing a permission this login does not have.
 *   - RESTORE DATABASE onto a database that already exists AND is already
 *     owned by gcio_app works fine, no dbcreator needed — permission is
 *     checked against the existing target, not against "create a database."
 *     Restoring onto a brand-new name is what needs dbcreator, and that step
 *     is the one this login cannot do. So the target database must already
 *     exist, owned by this login, before the first run. That is a one-time,
 *     out-of-band setup step for whoever administers the SQL instance:
 *
 *       CREATE DATABASE [GCIO_DrillRestore];
 *       ALTER AUTHORIZATION ON DATABASE::[GCIO_DrillRestore] TO [gcio_app];
 *
 *     This script checks for that precondition and fails with that exact
 *     text, rather than a raw permission error, if it is missing.
 *   - DROP DATABASE on a database gcio_app owns works fine, but the default
 *     end-of-run behaviour does NOT call it. Dropping is fine for a single
 *     ad hoc run, but this login cannot re-create what it just dropped, so a
 *     default that drops every time means every successful run disables the
 *     next one until an administrator re-provisions — not something runnable
 *     unattended, on a schedule. So by default the restored copy is left in
 *     place for the next run's RESTORE … REPLACE to overwrite, and --drop
 *     opts into the one-shot teardown instead.
 *   - Deleting the backup file does not: BACKUP DATABASE writes it as the SQL
 *     Server service account, not as gcio_app or as whoever runs `node`. This
 *     login cannot run xp_delete_file (sysadmin-only) and the OS identity
 *     running `node` gets EPERM on a plain unlink against a file the service
 *     account owns in its own backup directory — confirmed by hand, not
 *     assumed. So cleanup deletes the file on a best-effort basis, and a
 *     failure to do so is reported as a warning, not folded into the pass/
 *     fail result: it does not indicate anything wrong with the backup or the
 *     restore, only that stale drill backups need a periodically-run
 *     sysadmin job (or a human) to purge them from the default backup
 *     directory. That is a runbook item, not a bug in this script.
 *
 * None of this is a workaround for a permission this login lacks — it is a
 * different, permission-appropriate way to reach the same evidence. The one
 * thing that is a genuine, disclosed gap is the one-time provisioning above,
 * which needs a more privileged login exactly once, by design: creating a
 * database from nothing is the one operation in this whole drill that
 * `gcio_app` was deliberately not granted.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import sql from "mssql";
import { buildConfig } from "../server/db/pool.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const TABLES = ["Project", "ProjectChild", "PostureDomain",
                "ProjectVersion", "SourceFile", "IngestRun", "AuditEvent"];

const config = buildConfig(process.env);
const source = config.database;
const target = flag("as", "GCIO_DrillRestore");
const explicitBackupDir = flag("to", null);
const keep = args.includes("--keep");

/* It restores and drops a database. A typo in --as must not be able to do
   that to production. */
if (process.env.NODE_ENV === "production" && !args.includes("--i-mean-it")) {
  console.error("refusing to run against NODE_ENV=production without --i-mean-it");
  process.exit(1);
}
if (target.toLowerCase() === source.toLowerCase()) {
  console.error(`refusing to restore over the source database (${source})`);
  process.exit(1);
}

const say = (step, message) => console.log(`[drill] ${step}  ${message}`);
const warn = (step, message) => console.warn(`[drill] ${step}  WARNING: ${message}`);
let failures = 0;
let warnings = 0;

/* master, because a database being restored cannot be the one in use. */
let pool;
try {
  pool = await new sql.ConnectionPool({ ...config, database: "master" }).connect();
} catch (err) {
  console.error(`[drill] could not connect as the configured login: ${err.message}`);
  process.exit(1);
}
const q = async (text) => (await pool.request().query(text)).recordset;

try {
  say("target", `backing up ${source}, restoring as ${target}, connected as ${(await q("SELECT SUSER_SNAME() AS who"))[0].who}`);

  /* ---- 0. where can this login actually write a backup? ------------------ */
  /* BACKUP DATABASE runs as the SQL Server service account, not as whoever
     is connected — a path writable by an interactive user (the profile temp
     directory, this repo) is routinely NOT writable by the service account,
     and the failure is a plain "operating system error 5 (Access is
     denied.)" that gives no hint why. The instance's own configured backup
     path is always writable by that same service account, so it is the safe
     default; --to overrides it for an operator who knows better. */
  const backupDir = explicitBackupDir ??
    (await q("SELECT SERVERPROPERTY('InstanceDefaultBackupPath') AS p"))[0].p;
  if (!backupDir) {
    console.error("[drill] could not determine a backup directory (SERVERPROPERTY('InstanceDefaultBackupPath') " +
      "returned nothing) — pass --to explicitly");
    process.exit(1);
  }

  /* ---- 1. what is in it now -------------------------------------------- */
  const before = {};
  for (const t of TABLES) {
    const [row] = await q(`SELECT COUNT(*) AS n FROM [${source}].dbo.[${t}]`);
    before[t] = row.n;
  }
  say("before", TABLES.map((t) => `${t}=${before[t]}`).join(" "));

  /* ---- 2. back up ------------------------------------------------------ */
  /* COPY_ONLY so the drill does not disturb the real backup chain: without it a
     differential taken afterwards would be relative to this one. */
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(backupDir, `${source}-drill-${stamp}.bak`);
  await q(`BACKUP DATABASE [${source}] TO DISK = N'${backupFile}' WITH INIT, COPY_ONLY, STATS = 10`);

  /* ---- 3. restore elsewhere -------------------------------------------- */
  /* The size check and the logical file names both come from msdb's backup
     history for the file this run just wrote, not from the filesystem and
     not from RESTORE FILELISTONLY. Two separate, hand-confirmed reasons:
       - fs.stat on the backup file itself gets EPERM: it was written by the
         SQL Server service account, and the OS identity running `node` (an
         ordinary interactive user, not that service account) cannot even
         stat it in the instance's own backup directory, let alone read it
         directly.
       - RESTORE FILELISTONLY needs a permission (effectively "can create a
         database") that gcio_app does not have, and fails with "CREATE
         DATABASE permission denied in database 'master'" even though
         FILELISTONLY creates nothing.
     msdb's own record of the backup it just took needs no more than ordinary
     read access to msdb, which this login has. This still reads the size and
     the names from the backup rather than assuming them, so it still works
     on a database this script did not create — it just gets there through
     msdb instead of through the file the backup produced. */
  const [meta] = await q(`
    SELECT bs.backup_size AS Bytes
    FROM msdb.dbo.backupset bs
    JOIN msdb.dbo.backupmediafamily bmf ON bmf.media_set_id = bs.media_set_id
    WHERE bmf.physical_device_name = N'${backupFile}'
      AND bs.database_name = N'${source}'
    ORDER BY bs.backup_finish_date DESC
  `);
  const files = await q(`
    SELECT bf.logical_name AS LogicalName, bf.file_type AS Type
    FROM msdb.dbo.backupset bs
    JOIN msdb.dbo.backupmediafamily bmf ON bmf.media_set_id = bs.media_set_id
    JOIN msdb.dbo.backupfile bf ON bf.backup_set_id = bs.backup_set_id
    WHERE bmf.physical_device_name = N'${backupFile}'
      AND bs.database_name = N'${source}'
    ORDER BY bs.backup_finish_date DESC
  `);
  if (!meta || !files.length) {
    console.error(`[drill] could not find ${backupFile} in msdb backup history — is msdb history being pruned ` +
      "more aggressively than this drill runs?");
    process.exit(1);
  }
  const bytes = meta.Bytes;
  say("backup", `${backupFile} — ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  if (bytes < 1024) { console.error("[drill] backup is implausibly small"); failures += 1; }
  const moves = files.map((f) => {
    const ext = f.Type === "L" ? "_log.ldf" : ".mdf";
    return `MOVE N'${f.LogicalName}' TO N'${path.join(backupDir, target + "-" + f.LogicalName + ext)}'`;
  }).join(", ");

  /* Restoring onto a database that already exists and is already owned by
     this login needs no more than db_owner on that database — dbcreator is
     only required to restore onto a name that does not exist yet, which is
     exactly the one thing gcio_app cannot do. So the target must already be
     provisioned; check plainly rather than let a missing database surface as
     an opaque permission error partway through RESTORE. */
  const targetExists = await q(`SELECT database_id FROM sys.databases WHERE name = N'${target}'`);
  if (!targetExists.length) {
    console.error(`[drill] ${target} does not exist, and this login cannot create it (no dbcreator / ` +
      "CREATE ANY DATABASE permission). One-time setup, run once by an administrator:\n" +
      `  CREATE DATABASE [${target}];\n` +
      `  ALTER AUTHORIZATION ON DATABASE::[${target}] TO [${config.user ?? "gcio_app"}];`);
    process.exit(1);
  }

  await q(`RESTORE DATABASE [${target}] FROM DISK = N'${backupFile}' WITH ${moves}, REPLACE, RECOVERY`);
  say("restore", `${target} online`);

  /* ---- 4. does it hold what the original held? ------------------------- */
  for (const t of TABLES) {
    const [row] = await q(`SELECT COUNT(*) AS n FROM [${target}].dbo.[${t}]`);
    if (row.n !== before[t]) {
      console.error(`[drill] MISMATCH ${t}: source ${before[t]}, restored ${row.n}`);
      failures += 1;
    }
  }
  say("compare", failures ? `${failures} table(s) did not match` : "every table matched");

  /* ---- 5. the vault, which the database cannot rebuild ----------------- */
  /* A restored database pointing at workbooks nobody kept is not a recovery.
     An empty vault is not itself a failure — dbo.SourceFile legitimately has
     no rows until a live ingest has run on this machine — so report the
     count cleanly rather than treating zero as suspicious. */
  const vaultDir = path.resolve(process.env.VAULT_DIR || "vault");
  const vaulted = await q(`SELECT VaultPath FROM [${target}].dbo.SourceFile WHERE VaultPath IS NOT NULL`);
  const missing = vaulted.filter((r) => !fs.existsSync(path.join(vaultDir, r.VaultPath)));
  if (missing.length) {
    console.error(`[drill] ${missing.length} vaulted workbook(s) recorded but absent from ${vaultDir}`);
    failures += 1;
  }
  say("vault", `${vaulted.length} recorded, ${missing.length} missing`);

  /* ---- 6. leave nothing behind (as far as this login is able) ----------- */
  /* Dropping the scratch database is NOT the default here, unlike the
     original design. Reason, found by running this drill for real rather
     than assumed: gcio_app cannot create a database from nothing (that is
     the one permission it was deliberately not given — see the file header),
     so DROP-by-default means every successful run disables the next one
     until an administrator re-runs the one-time provisioning. A drill that
     needs a human to reset it before it can run again is not runnable on a
     schedule, which is the whole point of it existing. So the default
     leaves the restored copy in place — it is exactly the "leftover scratch
     database from a previous run" the next invocation's own RESTORE …
     REPLACE is written to tolerate — and only --drop tears it down, for the
     rarer case of deliberately decommissioning the scratch database. --keep
     additionally skips deleting the backup file, e.g. to inspect the
     restored copy by hand or to induce a deliberate mismatch for testing. */
  const drop = args.includes("--drop");
  if (keep) {
    say("keep", `left ${target} and ${backupFile} in place`);
  } else {
    if (drop) {
      await q(`ALTER DATABASE [${target}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
      await q(`DROP DATABASE [${target}]`);
      const [still] = await q(`SELECT COUNT(*) AS n FROM sys.databases WHERE name = '${target}'`);
      if (still.n !== 0) { console.error(`[drill] ${target} still exists after DROP`); failures += 1; }
    } else {
      say("keep", `left ${target} in place for the next run (pass --drop to tear it down)`);
    }

    /* Best effort: the file was written by the SQL Server service account,
       not by this login or by whoever runs `node`, and neither can be relied
       on to have delete rights on it (checked by hand: gcio_app cannot
       execute xp_delete_file — sysadmin only — and a plain fs.unlink as an
       ordinary interactive user gets EPERM against the instance's own backup
       directory). Failing to delete it says nothing about whether the backup
       or restore worked, so it is a warning, not a drill failure. */
    try {
      fs.rmSync(backupFile, { force: true });
      say("cleanup", `backup file deleted${drop ? ", scratch database dropped" : ""}`);
    } catch (err) {
      warnings += 1;
      warn("cleanup", `could not delete ${backupFile} (${err.code ?? err.message}) — ` +
        "this login cannot remove files in the backup directory; an administrator should purge stale " +
        "drill backups periodically (e.g. sysadmin running xp_delete_file), or delete this one by hand.");
    }
  }

  await pool.close();
  if (warnings) say("warnings", `${warnings} warning(s) — see above`);
  console.log(failures ? `[drill] FAILED — ${failures} problem(s)` : "[drill] PASSED");
  process.exit(failures ? 1 : 0);
} catch (err) {
  console.error(`[drill] FAILED — unexpected error: ${err.message}`);
  await pool.close().catch(() => {});
  process.exit(1);
}
