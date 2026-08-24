/**
 * Connectivity probe for the MSSQL path.
 *
 *   node scripts/db-check.mjs
 *
 * Prints who we connected as, the server version, and whether the target
 * database exists. Uses the same buildConfig the application uses, so a
 * success here means the app's configuration is right — not just that some
 * connection string somewhere works.
 */
import sql from "mssql";
import { buildConfig } from "../server/db/pool.js";

const config = buildConfig(process.env);
const target = config.database;

/* Probe against master first: the application database may not exist yet. */
const probe = { ...config, database: "master" };

console.log(`connecting to ${probe.server}${probe.options.instanceName ? `\\${probe.options.instanceName}` : ""} ` +
  `(${probe.options.trustedConnection ? "windows auth" : `sql auth as ${probe.user}`})`);

let pool;
try {
  pool = await new sql.ConnectionPool(probe).connect();
} catch (err) {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
}

const info = await pool.request().query("SELECT SUSER_SNAME() AS who, @@VERSION AS version");
console.log(`connected as: ${info.recordset[0].who}`);
console.log(info.recordset[0].version.split("\n")[0].trim());

const exists = await pool.request()
  .input("name", sql.NVarChar(128), target)
  .query("SELECT database_id FROM sys.databases WHERE name = @name");

if (exists.recordset.length) {
  console.log(`database ${target}: present`);
} else {
  console.log(`database ${target}: missing — create it with scripts/db-create.mjs`);
}

await pool.close();
