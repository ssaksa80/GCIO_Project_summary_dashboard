/**
 * Environment configuration, validated once at boot.
 *
 * A missing secret must stop the process with the variable's name in the
 * message, not surface later as a confusing 500 in the middle of someone's
 * sign-in. Mirrors the shape DEDB uses: everything the app needs, resolved and
 * frozen before anything else starts.
 */
const STORES = ["memory", "mssql"];
const AUTH_MODES = ["ldap", "dev"];

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
    seedAdminGroup: String(env.SEED_ADMIN_GROUP || "").trim(),
  });
}
