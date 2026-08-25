import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVault } from "../server/vault.js";
import { hashBytes } from "../server/ingest/hash.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "gcio-vault-"));
const quiet = { error() {}, info() {} };

test("a stored file can be read back byte for byte", () => {
  const vault = createVault(scratch(), { logger: quiet });
  const bytes = Buffer.from("a workbook's bytes");
  const at = new Date("2026-08-25T10:00:00Z");

  const stored = vault.store(bytes, "master.xlsx", { at });
  assert.equal(stored.hash, hashBytes(bytes));
  assert.deepEqual(vault.read(stored.hash, ".xlsx"), bytes);
});

test("files are filed by year and month, so a folder never grows without bound", () => {
  const dir = scratch();
  const vault = createVault(dir, { logger: quiet });
  const stored = vault.store(Buffer.from("x"), "a.xlsx", { at: new Date("2026-08-25T10:00:00Z") });

  assert.match(stored.vaultPath.replace(/\\/g, "/"), /2026\/08\//);
  assert.ok(fs.existsSync(path.join(dir, stored.vaultPath)));
});

test("storing identical bytes twice keeps one copy", () => {
  const dir = scratch();
  const vault = createVault(dir, { logger: quiet });
  const bytes = Buffer.from("identical");

  const first = vault.store(bytes, "a.xlsx", { at: new Date("2026-08-25T10:00:00Z") });
  const second = vault.store(bytes, "b.xlsx", { at: new Date("2026-08-25T10:00:00Z") });

  assert.equal(first.hash, second.hash);
  assert.equal(first.vaultPath, second.vaultPath);
  const files = fs.readdirSync(path.join(dir, "2026", "08"));
  assert.equal(files.length, 1, "the same bytes were stored twice");
});

test("the extension is preserved so a replayed file is still openable", () => {
  const vault = createVault(scratch(), { logger: quiet });
  const stored = vault.store(Buffer.from("x"), "legacy.XLS", { at: new Date("2026-08-25T10:00:00Z") });
  assert.match(stored.vaultPath, /\.xls$/);
});

test("a vault that cannot be written reports it rather than pretending", () => {
  /* Root points at a FILE, so creating a directory beneath it fails with
     ENOTDIR on every platform. " /impossible" is not reliably invalid on
     Windows, which is what the plan originally assumed. */
  const dir = scratch();
  const notADirectory = path.join(dir, "definitely-a-file");
  fs.writeFileSync(notADirectory, "x");

  const vault = createVault(notADirectory, { logger: quiet });
  assert.throws(() => vault.store(Buffer.from("x"), "a.xlsx"), /vault/i);

  /* Nothing was left lying around by the failed attempt. */
  const stray = fs.readdirSync(dir).filter((name) => name.endsWith(".writing"));
  assert.deepEqual(stray, [], "a .writing file survived a failed store");
});

test("reading something the vault does not hold returns null", () => {
  const vault = createVault(scratch(), { logger: quiet });
  assert.equal(vault.read("0".repeat(64), ".xlsx"), null);
});

test("the stored path uses forward slashes on every platform", () => {
  /* It is persisted to the database and read by humans and scripts; it must
     not depend on which OS happened to ingest the file. */
  const vault = createVault(scratch(), { logger: quiet });
  const stored = vault.store(Buffer.from("x"), "a.xlsx", { at: new Date("2026-08-25T10:00:00Z") });
  assert.equal(stored.vaultPath, `2026/08/${hashBytes(Buffer.from("x"))}.xlsx`);
  assert.ok(!stored.vaultPath.includes("\\"), "a backslash reached the stored path");
});

test("reading from a vault that was never written returns null", () => {
  const vault = createVault(path.join(scratch(), "never-created"), { logger: quiet });
  assert.equal(vault.read("0".repeat(64), ".xlsx"), null);
});
