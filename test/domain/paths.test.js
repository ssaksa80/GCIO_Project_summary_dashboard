/**
 * Where the drop folder and the vault actually live.
 *
 * This matters because of how a release bundle is laid out. The bundle
 * installs code to `<install>/app`, and server/index.js computes
 * `ROOT = path.resolve(__dirname, "..")` — so with the app at
 * `C:\gcio\app\server`, ROOT becomes `C:\gcio\app` and every path hanging off
 * it moves with it:
 *
 *     drop folder   C:\gcio\data   ->   C:\gcio\app\data
 *     vault         C:\gcio\vault  ->   C:\gcio\app\vault
 *
 * An operator's existing drop folder would be orphaned: workbooks copied there
 * are silently never ingested, /healthz stays green, and nothing reports it.
 * The vault is also the audit trail — what a file actually said — and
 * Backup-GcioAppCopy copies the whole app directory before every patch, so a
 * vault inside it would be re-copied on every deploy.
 *
 * So both must be configurable to an absolute path outside `app/`. VAULT_DIR
 * already was (commit 6bd993c). DATA_DIR was not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadConfig, resolveStateDir } from "../../server/config.js";

const base = { STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" };

test("an absolute DATA_DIR is carried through the config", () => {
  const cfg = loadConfig({ ...base, DATA_DIR: "C:\\gcio\\data" });
  assert.equal(cfg.dataDir, "C:\\gcio\\data",
    "a bundle installs code under <install>/app, so the drop folder must be configurable outside it - otherwise an upgrade silently orphans the folder the operator drops workbooks into");
});

test("DATA_DIR defaults to the repo-relative data/ when unset", () => {
  const cfg = loadConfig(base);
  assert.equal(cfg.dataDir, "data", "the default must not change for an ordinary dev checkout");
});

test("VAULT_DIR keeps the same shape, so the two are configured alike", () => {
  assert.equal(loadConfig({ ...base, VAULT_DIR: "C:\\gcio\\vault" }).vaultDir, "C:\\gcio\\vault");
  assert.equal(loadConfig(base).vaultDir, "vault");
});

/*
 * path.resolve, not path.join — the same distinction that was fixed for the
 * vault in 6bd993c. join would concatenate an absolute path onto ROOT and
 * produce C:\gcio\app\C:\gcio\data, which is not a real directory and fails in
 * a way that looks nothing like its cause.
 */
test("resolving an absolute configured dir against ROOT yields the configured dir", () => {
  const ROOT = "C:\\gcio\\app";
  assert.equal(path.resolve(ROOT, "C:\\gcio\\data"), "C:\\gcio\\data");
  assert.notEqual(path.join(ROOT, "C:\\gcio\\data"), "C:\\gcio\\data",
    "join is the wrong operation here; this asserts the two genuinely differ so the choice is not incidental");
});

test("a relative configured dir still resolves under ROOT", () => {
  const ROOT = "C:\\gcio\\app";
  assert.equal(path.resolve(ROOT, "data"), "C:\\gcio\\app\\data");
});

/*
 * resolveStateDir exists so the resolve-vs-join choice is covered by a test
 * rather than only by booting the server. Without it, changing index.js to
 * path.join left every test in this file green — the mangled path only showed
 * up as a watcher that never started, which nothing automated was watching for.
 */
test("resolveStateDir returns an absolute setting unchanged", () => {
  assert.equal(resolveStateDir("C:\\gcio\\app", "C:\\gcio\\data"), "C:\\gcio\\data",
    "a bundle puts ROOT at <install>/app; an absolute DATA_DIR must escape it, or the operator's drop folder is silently orphaned");
  assert.equal(resolveStateDir("C:\\gcio\\app", "C:\\gcio\\vault"), "C:\\gcio\\vault");
});

test("resolveStateDir resolves a relative setting under root", () => {
  assert.equal(resolveStateDir("C:\\gcio\\app", "data"), "C:\\gcio\\app\\data");
  assert.equal(resolveStateDir("C:\\gcio\\app", "vault"), "C:\\gcio\\app\\vault");
});
