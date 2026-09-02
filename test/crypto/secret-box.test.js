/*
 * Sealing a secret at rest.
 *
 * The wire format is deliberately identical to DEDB's
 * (server/src/crypto/secretBox.js): `enc:v1:base64(iv|tag|ct)` over AES-256-GCM.
 * An operator who has seen one product's .env should recognise the other's, and
 * a token pasted into the wrong file should fail to open rather than decode to
 * something plausible.
 *
 * GCM is chosen over CBC for one reason that matters here: it AUTHENTICATES.
 * A password file is exactly the thing an attacker would rather corrupt than
 * read - flip a byte in a CBC blob and you get garbage that the app cheerfully
 * binds with, producing an account lockout across the directory. Under GCM a
 * modified token throws instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { makeSecretBox, isSealed } from "../../server/crypto/secretBox.js";

const KEY = Buffer.alloc(32, 7);

test("a sealed secret round-trips back to the original", () => {
  const box = makeSecretBox(KEY);
  assert.equal(box.open(box.seal("hunter2")), "hunter2");
});

test("a sealed value carries the enc:v1: marker so config can recognise it", () => {
  const token = makeSecretBox(KEY).seal("x");
  assert.ok(token.startsWith("enc:v1:"), "config.js decides whether to unseal by this prefix alone");
  assert.ok(isSealed(token));
  assert.equal(isSealed("hunter2"), false, "a plaintext password must not be mistaken for a token");
  assert.equal(isSealed(""), false);
  assert.equal(isSealed(undefined), false);
});

test("open passes an unsealed value straight through", () => {
  /* Deliberate: an operator who has not run seal-secret.ps1 yet still gets a
     working service, with a warning. Making this throw would turn an upgrade
     into an outage for every host that had not been migrated. */
  assert.equal(makeSecretBox(KEY).open("still-plaintext"), "still-plaintext");
});

test("a tampered ciphertext is refused, not silently decrypted to garbage", () => {
  const box = makeSecretBox(KEY);
  const token = box.seal("hunter2");
  const raw = Buffer.from(token.slice("enc:v1:".length), "base64");
  raw[raw.length - 1] ^= 0xff;                       // last byte of the ciphertext
  const tampered = "enc:v1:" + raw.toString("base64");
  assert.throws(() => box.open(tampered), /auth|tag|decrypt/i,
    "an unauthenticated cipher would hand back a corrupted password and bind with it, locking the account out across the directory");
});

test("a tampered auth tag is refused", () => {
  const box = makeSecretBox(KEY);
  const raw = Buffer.from(box.seal("hunter2").slice("enc:v1:".length), "base64");
  raw[13] ^= 0xff;                                    // inside the 16-byte tag at offset 12
  assert.throws(() => box.open("enc:v1:" + raw.toString("base64")));
});

test("a token sealed under a different key does not open", () => {
  const token = makeSecretBox(KEY).seal("hunter2");
  const other = makeSecretBox(randomBytes(32));
  assert.throws(() => other.open(token),
    "this is what makes a stolen .env useless without the matching key.bin");
});

test("sealing the same secret twice produces different tokens", () => {
  const box = makeSecretBox(KEY);
  assert.notEqual(box.seal("hunter2"), box.seal("hunter2"),
    "a fixed IV would let anyone diffing two .env files see that the password did not change between them");
});

test("the key must be exactly 32 bytes", () => {
  assert.throws(() => makeSecretBox(Buffer.alloc(16)), /32 bytes/);
  assert.throws(() => makeSecretBox("not a buffer"), /32 bytes/);
});
