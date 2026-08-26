/**
 * The file-backed audit sink used when STORE=memory.
 *
 * Its recent() returned an empty array, which is worse than unimplemented: the
 * admin screen would have shown "no events" over a file full of them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileAudit } from "../../server/devBackends.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "gcio-audit-"));
const quiet = { error() {} };

test("appended events are read back, newest first", async () => {
  const dir = scratch();
  const audit = createFileAudit(dir, { logger: quiet });

  await audit.append({ actor: "a@x", action: "signin", subject: "pm" });
  await audit.append({ actor: "b@x", action: "export", subject: "pptx weekly" });

  const events = await audit.recent();
  assert.equal(events.length, 2);
  assert.equal(events[0].action, "export", "events are not newest-first");
  assert.equal(events[1].action, "signin");
  assert.ok(events[0].at, "no timestamp was recorded");
});

test("the limit is honoured", async () => {
  const dir = scratch();
  const audit = createFileAudit(dir, { logger: quiet });
  for (let i = 0; i < 25; i += 1) await audit.append({ actor: "a@x", action: "export", subject: String(i) });

  const events = await audit.recent({ limit: 10 });
  assert.equal(events.length, 10);
  assert.equal(events[0].subject, "24", "the newest event was not first");
});

test("events can be filtered by action", async () => {
  const dir = scratch();
  const audit = createFileAudit(dir, { logger: quiet });
  await audit.append({ actor: "a@x", action: "signin", subject: "pm" });
  await audit.append({ actor: "a@x", action: "export", subject: "pptx" });
  await audit.append({ actor: "a@x", action: "export", subject: "xlsx" });

  const events = await audit.recent({ action: "export" });
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.action === "export"));
});

test("events from several days are merged, newest day first", async () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, "audit-2026-08-22.jsonl"),
    `${JSON.stringify({ at: "2026-08-22T09:00:00.000Z", actor: "old@x", action: "signin" })}\n`);
  fs.writeFileSync(path.join(dir, "audit-2026-08-24.jsonl"),
    `${JSON.stringify({ at: "2026-08-24T09:00:00.000Z", actor: "new@x", action: "signin" })}\n`);

  const events = await createFileAudit(dir, { logger: quiet }).recent();
  assert.equal(events.length, 2);
  assert.equal(events[0].actor, "new@x");
  assert.equal(events[1].actor, "old@x");
});

test("a corrupt line is skipped rather than losing the file", async () => {
  const dir = scratch();
  const file = path.join(dir, "audit-2026-08-24.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ at: "2026-08-24T09:00:00.000Z", actor: "a@x", action: "signin" }),
    "{ this is not json",
    JSON.stringify({ at: "2026-08-24T10:00:00.000Z", actor: "b@x", action: "export" }),
    "",
  ].join("\n"));

  const events = await createFileAudit(dir, { logger: quiet }).recent();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.actor), ["b@x", "a@x"]);
});

test("no audit directory yet is an empty list, not an error", async () => {
  const events = await createFileAudit(path.join(scratch(), "not-created-yet"), { logger: quiet }).recent();
  assert.deepEqual(events, []);
});
