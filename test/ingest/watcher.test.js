/**
 * The drop-folder watcher.
 *
 * It used to persist through applyResult() itself, which hard-wired it to the
 * in-memory store's synchronous API. With STORE=mssql that threw inside the
 * chokidar handler — before the batch callback — so a workbook dropped into
 * data/ silently never reached the database and nothing was logged.
 *
 * The watcher now only detects; the caller decides what persistence means.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watchDataDir } from "../../server/ingest.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "gcio-watch-"));
const settle = (ms = 1800) => new Promise((r) => setTimeout(r, ms));

/* chokidar suppresses everything it sees during its initial scan, so a file
   written before "ready" is silently ignored. Wait for it before touching the
   folder, or the test measures the scan rather than the watcher. */
const ready = (watcher) => new Promise((resolve) => watcher.on("ready", resolve));

test("a dropped workbook is handed to an async persister", async (t) => {
  const dir = scratch();
  const applied = [];
  const batches = [];

  const watcher = watchDataDir(dir, {
    onUpsert: async (filePath) => {
      /* Async on purpose: the SQL store's writes are promises. */
      await new Promise((r) => setTimeout(r, 10));
      applied.push(path.basename(filePath));
    },
    onRemove: async (name) => { applied.push(`-${name}`); },
    onBatch: (batch) => batches.push(batch),
  });
  t.after(async () => {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ready(watcher);
  fs.copyFileSync("sample-data/GCIO_Portfolio_Master.xlsx", path.join(dir, "dropped.xlsx"));
  await settle();

  assert.deepEqual(applied, ["dropped.xlsx"], "the workbook was not handed over");
  assert.equal(batches.length, 1, "no batch was announced");
  assert.deepEqual(batches[0].files, ["dropped.xlsx"]);
});

test("a deleted workbook is announced too", async (t) => {
  const dir = scratch();
  const removed = [];
  const target = path.join(dir, "gone.xlsx");
  fs.copyFileSync("sample-data/GCIO_Portfolio_Master.xlsx", target);

  const watcher = watchDataDir(dir, {
    onUpsert: async () => {},
    onRemove: async (name) => { removed.push(name); },
    onBatch: () => {},
  });
  t.after(async () => {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ready(watcher);
  fs.rmSync(target);
  await settle();

  assert.deepEqual(removed, ["gone.xlsx"], "the deletion was not reported");
});

test("a file that is not a workbook is ignored", async (t) => {
  const dir = scratch();
  const seen = [];
  const watcher = watchDataDir(dir, {
    onUpsert: async (p) => { seen.push(path.basename(p)); },
    onRemove: async () => {},
    onBatch: () => {},
  });
  t.after(async () => {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ready(watcher);
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a workbook");
  fs.writeFileSync(path.join(dir, ".hidden.xlsx"), "dot file");
  await settle();

  assert.deepEqual(seen, [], `unexpected files were ingested: ${seen.join(", ")}`);
});

test("a persister that throws does not kill the watcher", async (t) => {
  const dir = scratch();
  const seen = [];
  const errors = [];

  const watcher = watchDataDir(dir, {
    onUpsert: async (filePath) => {
      const name = path.basename(filePath);
      seen.push(name);
      if (name === "first.xlsx") throw new Error("database is down");
    },
    onRemove: async () => {},
    onBatch: () => {},
    logger: { error: (m) => errors.push(m) },
  });
  t.after(async () => {
    await watcher.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await ready(watcher);
  fs.copyFileSync("sample-data/GCIO_Portfolio_Master.xlsx", path.join(dir, "first.xlsx"));
  await settle();
  fs.copyFileSync("sample-data/GCIO_Portfolio_Master.xlsx", path.join(dir, "second.xlsx"));
  await settle();

  assert.deepEqual(seen, ["first.xlsx", "second.xlsx"], "the watcher stopped after a failure");
  assert.ok(errors.some((m) => /database is down/.test(m)), "the failure was not logged");
});
