/**
 * The 32-byte key that crypto/secretBox.js seals secrets with.
 *
 * On Windows the key file holds the key DPAPI-protected at LocalMachine scope,
 * so the bytes are bound to this host. Ported from DEDB's
 * server/src/crypto/masterKey.js, which has carried this in production.
 *
 * WHAT THIS PROTECTS AGAINST, precisely, because overstating it is worse than
 * not having it: a copy of .env and key.bin taken OFF this machine - a backup,
 * a support bundle, a folder copied to a share, a file committed by accident -
 * is useless, because DPAPI will not unprotect them anywhere else. It does NOT
 * protect against an attacker already executing on this host: the service has
 * to decrypt unattended, so anything the service can do, code running as the
 * service account can do too. No unattended scheme can do better than that.
 *
 * No native module and no new dependency: DPAPI is reached through PowerShell,
 * which also keeps this a patch-tier release rather than a bundle.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import path from "node:path";

/**
 * Key material crosses to PowerShell on STDIN, never as an argument.
 *
 * argv is world-readable on Windows - any process listing, any EDR agent, any
 * `Get-CimInstance Win32_Process` picks it up, and it lands in command-line
 * auditing logs that are themselves shipped off the box. stdin does not.
 * Protect and unprotect share this shape so the key has exactly one way in and
 * one way out.
 */
function runDpapi(mode, buf, spawnSync) {
  const ps =
    "Add-Type -AssemblyName System.Security;" +
    "$b64=[Console]::In.ReadToEnd();" +
    "$d=[Convert]::FromBase64String($b64);" +
    `$p=[Security.Cryptography.ProtectedData]::${mode}($d,$null,'LocalMachine');` +
    "[Console]::Out.Write([Convert]::ToBase64String($p))";
  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    encoding: "utf8",
    input: buf.toString("base64"),
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`DPAPI ${mode} failed (exit ${res.status}): ${(res.stderr || "").trim()}`);
  }
  return Buffer.from(String(res.stdout).trim(), "base64");
}

/**
 * Where key.bin belongs, given the application root.
 *
 * A release patch overlays `<install>/app` wholesale. A key written inside it
 * is destroyed by the next deploy, and losing the key loses every secret sealed
 * with it - the service comes back up and rejects a password nobody changed.
 * So on a bundle install (ROOT is `<install>/app`) the key goes to `<install>`,
 * beside the .env it protects. On a dev checkout ROOT is the checkout itself,
 * nothing overlays it, and walking up would scatter key files across C:\dev.
 *
 * @param {string} root the application root
 * @param {string} [configured] GCIO_KEY_FILE, absolute or relative to root
 */
export function resolveKeyFile(root, configured) {
  if (configured) return path.resolve(root, configured);
  const isBundle = path.basename(root).toLowerCase() === "app";
  return path.resolve(isBundle ? path.dirname(root) : root, "key.bin");
}

/**
 * Return the 32-byte master key, creating and persisting it once.
 *
 * @param {string} keyPath
 * @param {object} [opts] injection seam for tests: fs, spawnSync, protect,
 *   unprotect, platform
 */
export function loadOrCreateKey(keyPath, opts = {}) {
  const platform = opts.platform || process.platform;
  const fs = opts.fs || { existsSync, readFileSync, writeFileSync, chmodSync };
  const spawnSync = opts.spawnSync || nodeSpawnSync;
  const isWin = platform === "win32";
  const protect = opts.protect || (isWin ? (b) => runDpapi("Protect", b, spawnSync) : (b) => b);
  const unprotect = opts.unprotect || (isWin ? (b) => runDpapi("Unprotect", b, spawnSync) : (b) => b);

  if (fs.existsSync(keyPath)) {
    try {
      return unprotect(fs.readFileSync(keyPath));
    } catch (e) {
      /* Deliberately does NOT fall through to generating a new key. That looks
         like recovery and is destruction: the old key is the only thing that
         could ever open the secrets already sealed with it. */
      throw new Error(
        `master key at ${keyPath} could not be unsealed. DPAPI is machine-bound, so ` +
        `a config restored from another host needs its secrets re-entered with ` +
        `deploy/seal-secret.ps1. Underlying: ${e.message}`,
      );
    }
  }

  const key = randomBytes(32);
  fs.writeFileSync(keyPath, protect(key));
  try { fs.chmodSync(keyPath, 0o600); } catch { /* windows: the installer owns the ACL */ }
  return key;
}
