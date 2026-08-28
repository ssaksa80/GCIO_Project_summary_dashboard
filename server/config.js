/**
 * Environment configuration, validated once at boot.
 *
 * A missing secret must stop the process with the variable's name in the
 * message, not surface later as a confusing 500 in the middle of someone's
 * sign-in. Mirrors the shape DEDB uses: everything the app needs, resolved and
 * frozen before anything else starts.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

/**
 * Resolve a configured state directory against the application root.
 *
 * Exists as its own function so the resolve-vs-join choice is unit-testable.
 * It is not incidental: DATA_DIR and VAULT_DIR are absolute on a real
 * deployment, because a release bundle installs code to `<install>/app` and the
 * drop folder and vault must NOT move under it — orphaning them is silent
 * (empty watcher, green health check, a portfolio that just stops changing).
 * `path.join` would turn an absolute setting into `C:\gcio\app\C:\gcio\data`,
 * the same bug fixed for the vault in 6bd993c.
 *
 * @param {string} root the application root
 * @param {string} configured an absolute path, or one relative to root
 * @returns {string}
 */
export function resolveStateDir(root, configured) {
  return path.resolve(root, configured);
}

const STORES = ["memory", "mssql"];
const AUTH_MODES = ["ldap", "dev"];

/**
 * The running build's version, for /metrics' gcio_build_info and nothing
 * else -- it is not load-bearing, so a missing or unreadable package.json
 * (an unusual layout, a trimmed deployment) must not stop the process the way
 * a missing secret does.
 * @returns {string}
 */
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {Readonly<object>}
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const need = (key) => {
    const value = String(env[key] || "").trim();
    if (!value) problems.push(`${key} is required`);
    if (/^(changeme|placeholder|todo)$/i.test(value)) problems.push(`${key} still holds a placeholder value`);
    return value;
  };

  const nodeEnv = env.NODE_ENV || "development";
  const isProd = nodeEnv === "production";

  const store = String(env.STORE || (isProd ? "mssql" : "memory")).toLowerCase();
  if (!STORES.includes(store)) problems.push(`STORE must be one of ${STORES.join(", ")}`);

  const authMode = String(env.AUTH_MODE || (isProd ? "ldap" : "dev")).toLowerCase();
  if (!AUTH_MODES.includes(authMode)) problems.push(`AUTH_MODE must be one of ${AUTH_MODES.join(", ")}`);
  if (authMode === "dev" && isProd) {
    problems.push("AUTH_MODE=dev is not permitted when NODE_ENV=production");
  }

  const ldap = { url: "", baseDN: "", domain: "", upnSuffix: "", timeoutMs: Number(env.LDAP_TIMEOUT_MS || 10000) };
  if (authMode === "ldap") {
    ldap.url = need("LDAP_URL");
    ldap.baseDN = need("LDAP_BASE_DN");
    ldap.domain = String(env.LDAP_DOMAIN || "").trim();
    ldap.upnSuffix = String(env.LDAP_UPN_SUFFIX || "").trim();
  }

  /* SSO is additive: it can be enabled alongside LDAP so people may use
     either, which is how DEDB runs. */
  const ssoEnabled = String(env.SSO_ENABLED || "false") === "true";
  const entra = { tenantId: "", clientId: "", issuer: "", requireMfaClaim: true, offlineKeys: null };
  if (ssoEnabled) {
    entra.tenantId = need("ENTRA_TENANT_ID");
    entra.clientId = need("ENTRA_CLIENT_ID");
    entra.issuer = env.ENTRA_ISSUER || `https://login.microsoftonline.com/${entra.tenantId}/v2.0`;
    entra.requireMfaClaim = String(env.ENTRA_REQUIRE_MFA || "true") === "true";
    if (env.ENTRA_OFFLINE_JWKS) {
      try {
        entra.offlineKeys = JSON.parse(env.ENTRA_OFFLINE_JWKS);
      } catch {
        problems.push("ENTRA_OFFLINE_JWKS is not valid JSON");
      }
    }
  }

  const devRole = String(env.DEV_ROLE || "admin").toLowerCase();
  if (authMode === "dev" && !["viewer", "pm", "admin"].includes(devRole)) {
    problems.push("DEV_ROLE must be viewer, pm or admin");
  }

  if (problems.length) {
    throw new Error(`configuration is not usable:\n  - ${problems.join("\n  - ")}`);
  }

  return Object.freeze({
    nodeEnv,
    isProd,
    version: readVersion(),
    port: Number(env.PORT || 8123),
    host: env.HOST || (isProd ? "127.0.0.1" : "0.0.0.0"),
    store,
    authMode,
    devRole,
    ldap: Object.freeze(ldap),
    ssoEnabled,
    entra: Object.freeze(entra),
    sessionAbsoluteHours: env.SESSION_ABSOLUTE_HOURS || "8",
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES || 240),
    auditDir: env.AUDIT_DIR || "audit",
    vaultDir: env.VAULT_DIR || "vault",
    /* Both of these are resolved against ROOT by index.js, and both may
       legitimately be ABSOLUTE on a real deployment. A release bundle installs
       code to <install>/app, so ROOT becomes C:\gcio\app -- and the drop folder
       and vault must not move there with it, or the operator's existing folders
       are orphaned and workbooks copied into them are silently never ingested.
       See test/domain/paths.test.js. */
    dataDir: env.DATA_DIR || "data",
    seedAdminGroup: String(env.SEED_ADMIN_GROUP || "").trim(),
  });
}
