/**
 * Authenticated encryption for secrets held at rest.
 *
 * Wire format: `enc:v1:base64(iv(12) | tag(16) | ciphertext)` under AES-256-GCM.
 * Byte-identical to DEDB's server/src/crypto/secretBox.js, deliberately - the
 * two products sit on the same host and are administered by the same people,
 * and a token that looks the same in both files behaves the same in both.
 *
 * GCM rather than CBC because the threat here is tampering as much as reading.
 * An unauthenticated cipher hands back a corrupted password on a flipped byte,
 * which the app then binds with; enough of those and the directory locks the
 * service account out. A modified token must fail closed instead.
 *
 * The key never appears here. It comes from crypto/masterKey.js, which keeps it
 * OS-protected and machine-bound.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
const IV_LEN = 12;
const TAG_LEN = 16;

/** Does this value look like something seal() produced? */
export function isSealed(v) {
  return typeof v === "string" && v.startsWith(PREFIX);
}

/**
 * @param {Buffer} key exactly 32 bytes
 * @returns {{ seal(plain: string): string, open(token: string): string }}
 */
export function makeSecretBox(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("secretBox: key must be 32 bytes");
  }
  return {
    seal(plain) {
      /* A fresh IV per seal. Reusing one under GCM is catastrophic, and even
         short of that, a fixed IV makes identical secrets encrypt identically -
         so anyone diffing two .env files learns whether the password changed. */
      const iv = randomBytes(IV_LEN);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
      return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    },
    open(token) {
      /* Pass-through, not an error: a host that has not been migrated yet still
         has a plaintext password in .env and must keep working. config.js is
         what notices and warns. */
      if (!isSealed(token)) return token;
      const raw = Buffer.from(token.slice(PREFIX.length), "base64");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_LEN));
      d.setAuthTag(raw.subarray(IV_LEN, IV_LEN + TAG_LEN));
      return Buffer.concat([d.update(raw.subarray(IV_LEN + TAG_LEN)), d.final()]).toString("utf8");
    },
  };
}
