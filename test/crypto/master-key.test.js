/*
 * The master key: where it lives, and what must never happen to it.
 *
 * Every test here injects protect/unprotect and fs. None invoke DPAPI - a test
 * that shells out to PowerShell would be slow, would fail on a non-Windows
 * runner, and would prove nothing that isn't already covered by asserting WHAT
 * gets written rather than HOW it is encrypted.
 *
 * Paths are written with forward slashes on purpose. A Windows path in a JS
 * string literal is a minefield: "C:\gcio\app" contains \g and \a, neither of
 * which is an escape, so it silently becomes C:gcioapp. path treats / and \
 * interchangeably on win32, so this is the same path with none of the risk.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadOrCreateKey, resolveKeyFile } from "../../server/crypto/masterKey.js";

/*
 * A stand-in for DPAPI. It must actually TRANSFORM the bytes, not merely tag
 * them: a stand-in that prepends a marker leaves the raw key sitting in the
 * output, so "the key is not on disk in the clear" would pass against a
 * completely unprotected write. The first draft of this file made exactly that
 * mistake and the assertion below caught it.
 */
const P = Buffer.from("PROTECTED:");
const flip = (b) => Buffer.from(b.map((x) => x ^ 0xff));
const protect = (b) => Buffer.concat([P, flip(b)]);
const unprotect = (b) => {
  if (!b.subarray(0, P.length).equals(P)) throw new Error("not protected by this stand-in");
  return flip(b.subarray(P.length));
};

function fakeFs(initial = {}) {
  const files = { ...initial };
  return {
    files,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => files[p],
    writeFileSync: (p, data) => { files[p] = Buffer.from(data); },
    chmodSync: () => {},
  };
}

const opts = (fs, extra = {}) => ({ fs, protect, unprotect, platform: "win32", ...extra });

test("the stand-in for DPAPI genuinely obscures its input", () => {
  /* Guards every assertion below it. If this stand-in ever degrades into
     something that passes the key through, the tests that depend on it go
     vacuously green while the real defect walks past. */
  const sample = Buffer.alloc(32, 0xab);
  assert.equal(protect(sample).includes(sample), false);
  assert.deepEqual(unprotect(protect(sample)), sample, "and it must still round-trip");
});

test("a first call generates a 32-byte key", () => {
  const key = loadOrCreateKey("K", opts(fakeFs()));
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, 32, "AES-256 needs exactly this, and makeSecretBox refuses anything else");
});

test("what lands on disk is the PROTECTED key, never the raw bytes", () => {
  /* The whole point. If this regresses, key.bin is a plaintext key sitting
     next to the ciphertext it unlocks, and the encryption is theatre. */
  const fs = fakeFs();
  const key = loadOrCreateKey("K", opts(fs));
  const written = fs.files["K"];
  assert.equal(written.includes(key), false, "the raw key bytes appear verbatim in the file");
  assert.deepEqual(unprotect(written), key, "and what was written must still be the key, protected");
});

test("a second call returns the same key rather than replacing it", () => {
  /* A regenerated key silently orphans every secret already sealed with the
     old one - the service starts, then fails every bind with a password nobody
     changed. */
  const fs = fakeFs();
  const first = loadOrCreateKey("K", opts(fs));
  const written = Buffer.from(fs.files["K"]);
  const second = loadOrCreateKey("K", opts(fs));
  assert.deepEqual(second, first);
  assert.deepEqual(fs.files["K"], written, "the existing key file must not be rewritten on read");
});

test("an unopenable key file fails loudly, naming the path and the reason", () => {
  const fs = fakeFs({ K: Buffer.from("this was written on another machine") });
  assert.throws(() => loadOrCreateKey("K", opts(fs)), (err) => {
    assert.match(err.message, /K/, "an operator needs to know which file");
    assert.match(err.message, /machine-bound|another host/i, "and why moving a host broke it");
    return true;
  });
});

test("a failed unseal does not overwrite the key file with a new key", () => {
  /* The tempting recovery - "can't open it, make a new one" - destroys the only
     thing that could ever open the existing secrets. Refuse instead. */
  const fs = fakeFs({ K: Buffer.from("foreign") });
  const before = Buffer.from(fs.files["K"]);
  assert.throws(() => loadOrCreateKey("K", opts(fs)));
  assert.deepEqual(fs.files["K"], before);
});

/*
 * Where the file goes. A patch overlays <install>/app wholesale, so a key
 * written inside it is destroyed by the next deploy - and destroying the key
 * destroys every sealed secret with it. Same failure mode as the DATA_DIR
 * comment in config.js, with a worse blast radius.
 */
test("on a bundle install the key sits beside .env, OUTSIDE the app directory", () => {
  const resolved = resolveKeyFile("C:/gcio/app");
  assert.equal(resolved, path.resolve("C:/gcio", "key.bin"));
  assert.equal(/[\\/]app[\\/]/i.test(resolved), false,
    "a patch overlays app/ wholesale; a key in there is gone on the next deploy and takes every sealed secret with it");
});

test("on a dev checkout the key sits in the repo root, not its parent", () => {
  /* ROOT is the checkout itself there, and nothing overlays it. Walking up
     would scatter key files across C:\\dev beside unrelated projects. */
  assert.equal(resolveKeyFile("C:/dev/gcio-p4"), path.resolve("C:/dev/gcio-p4", "key.bin"));
});

test("an explicit GCIO_KEY_FILE wins over both defaults", () => {
  assert.equal(resolveKeyFile("C:/gcio/app", "D:/secure/gcio.key"), path.resolve("D:/secure/gcio.key"));
});

test("a relative GCIO_KEY_FILE resolves against the root, not the cwd", () => {
  /* The service's working directory is whatever NSSM was given; resolving
     against it would put the key somewhere nobody predicted. */
  assert.equal(resolveKeyFile("C:/gcio/app", "keys/k.bin"), path.resolve("C:/gcio/app", "keys/k.bin"));
});

test("outside win32 the key is stored as-is and file permissions carry it", () => {
  const fs = fakeFs();
  const key = loadOrCreateKey("K", { fs, platform: "linux" });
  assert.deepEqual(fs.files["K"], key, "no DPAPI off Windows; this path exists so the suite runs anywhere");
});
