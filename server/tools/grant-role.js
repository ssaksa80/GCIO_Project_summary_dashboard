/**
 * Break-glass: grant, list or revoke a role from the HOST, without the admin
 * console.
 *
 * Ports DEDB's tools/grant-role.js. It covers the case the console cannot:
 * nobody holds a role, so nobody can sign in, so nobody can open the screen
 * that grants one. That is the state of every fresh database, and it is where
 * a directory outage leaves an otherwise working deployment - sign-in resolves
 * no groups, every role folds to nothing, and everyone is refused.
 *
 * It reuses the application's OWN configuration and connection, so there are
 * no separate credentials to manage, and it writes dbo.UserRoleMapping through
 * the same repo the console uses. authz applies a per-user grant by principal
 * directly, so it restores access while directory group resolution is still
 * broken.
 *
 * RUN IT THROUGH THE BUNDLED NODE RUNTIME. Double-clicking a .js, or running
 * it bare, hands the file to Windows Script Host, whose JScript engine cannot
 * parse ESM and dies with an 800A03EA compile error that says nothing useful.
 * The Grant-Role.cmd wrapper at the install root resolves the runtime and the
 * script path and passes arguments straight through:
 *
 *   C:\gcio\Grant-Role.cmd <sAMAccountName> <admin|pm|viewer>
 *   C:\gcio\Grant-Role.cmd --list
 *   C:\gcio\Grant-Role.cmd --remove <sAMAccountName>
 *
 * Explicit form (note runtime\node\node.exe, not runtime\node.exe):
 *
 *   C:\gcio\runtime\node\node.exe C:\gcio\app\server\tools\grant-role.js jdoe admin
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";

import { PRECEDENCE } from "../auth/authz.js";
import { loadConfig } from "../config.js";
import { getPool } from "../db/pool.js";
import { makeExecutor } from "../db/executor.js";
import { userRoleMappingRepo } from "../repos/userRoleMapping.js";

export const ROLES = PRECEDENCE;

export const USAGE = [
  "usage:",
  `  grant-role <sAMAccountName> <${ROLES.join("|")}>   grant or change a role`,
  "  grant-role --list                            show every current grant",
  "  grant-role --remove <sAMAccountName>         revoke a grant",
].join("\n");

/**
 * Parse arguments, drive the repo, and return what to print.
 *
 * Pure: no database, no filesystem, no process exit. That is what makes it
 * testable, and the host entrypoint below is then thin enough to read.
 *
 * @param {string[]} argv arguments after the script name
 * @param {{repo: object, grantedBy?: string}} deps
 * @returns {Promise<{code: number, lines: string[]}>} code 0 ok, 2 usage error
 */
export async function runGrantRole(argv, { repo, grantedBy = "grant-role-cli" } = {}) {
  const args = (argv || []).map((a) => String(a));
  const first = (args[0] || "").trim();

  if (first === "--list" || first === "-l") {
    const rows = await repo.list();
    const lines = ["current grants:"];
    /* Said plainly, because an empty table is the explanation for "nobody can
       sign in" - it has to read as an answer, not as a command that printed
       nothing. */
    if (!rows.length) lines.push("  (none - nobody has a direct grant)");
    for (const r of rows) {
      lines.push(`  ${r.Principal}\t${r.Role}\t(by ${r.GrantedBy || "?"} ${r.GrantedAt || ""})`.trimEnd());
    }
    return { code: 0, lines };
  }

  if (first === "--remove") {
    const principal = (args[1] || "").trim();
    if (!principal) return { code: 2, lines: ["error: --remove needs a sAMAccountName (see --list)", USAGE] };
    /* No "last admin" guard here, unlike the console. That guard exists
       because the console locks itself out - the screen you would use to undo
       the change is behind the check. This tool has no such problem: whatever
       it removes it can grant straight back, and refusing would disarm the
       recovery path in precisely the situation it exists for. */
    await repo.remove(principal);
    return { code: 0, lines: [`removed the grant for ${principal}`] };
  }

  const principal = first;
  const role = (args[1] || "").trim().toLowerCase();
  if (!principal || !role) return { code: 2, lines: ["error: a sAMAccountName and a role are required", USAGE] };
  if (!ROLES.includes(role)) {
    return { code: 2, lines: [`error: role must be one of: ${ROLES.join(", ")}`, USAGE] };
  }

  /* Passed through untouched: the repo owns the toSam normalisation, and
     applying it here as well would put the rule in two places to drift apart. */
  await repo.set(principal, role, grantedBy);
  return {
    code: 0,
    lines: [
      `granted ${principal} -> ${role}`,
      "they can sign in now; an existing session keeps its old role until they sign in again.",
      `to undo:  grant-role --remove ${principal}`,
    ],
  };
}

/* ---- host entrypoint: runs only when invoked directly, never on import ---- */

async function main() {
  const config = loadConfig(process.env);
  for (const w of config.warnings) console.warn(`[gcio] WARNING: ${w}`);

  if (config.store !== "mssql") {
    console.error(`STORE is '${config.store}', so there is no database to write to.`);
    console.error("Grants are only persisted for STORE=mssql; in-memory roles come from DEV_ROLE.");
    process.exit(1);
  }

  let pool;
  try {
    pool = await getPool(process.env);
  } catch (err) {
    console.error(`database connection failed: ${err?.message || err}`);
    console.error("(run this ON the GCIO host, from the install directory, so .env resolves)");
    process.exit(1);
  }

  const repo = userRoleMappingRepo(makeExecutor(() => pool));
  let code = 1;
  try {
    const res = await runGrantRole(process.argv.slice(2), { repo });
    res.lines.forEach((line) => console.log(line));
    code = res.code;
  } catch (err) {
    const message = String(err?.message || err);
    /* The one failure with a specific fix worth naming. Everything else is
       reported as it arrived. */
    if (/invalid object name|\b208\b/i.test(message)) {
      console.error("dbo.UserRoleMapping is missing - deploy a build carrying migration 12 first.");
    } else {
      console.error(`grant failed: ${message}`);
    }
  } finally {
    try { await pool.close(); } catch { /* closing after the work is done */ }
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
