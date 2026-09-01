/**
 * Purge -- DELETE /api/documents/:sourceFileId.
 *
 * It exists so that testing with demo files does not mean hand-editing a
 * database. Two things about it are easy to get wrong and are pinned here
 * rather than left to a reviewer:
 *
 *   - the vault copy is deliberately NOT deleted. The vault is
 *     content-addressed, so two documents holding identical bytes share one
 *     file, and deleting it would break the other row. The design comment on
 *     the route says so; the "purging one document" test below is what makes
 *     it true.
 *   - "removed" and "there was nothing to remove" are different answers. A
 *     store that reports success unconditionally must not read as a purge.
 *
 * There is no shared test-app helper in this project -- verified, it does not
 * exist. test/documents/upload.test.js and test/api/app.test.js build the app
 * inline and this file follows them rather than introducing a second harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { Store } from "../../server/store.js";
import { createVault } from "../../server/vault.js";
import { memorySessions, memoryRoleMapping, devAuthenticate } from "../../server/devBackends.js";
import { memoryDocuments, memorySourceFiles } from "../../server/documents/memoryDocuments.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/documents");
const MD = path.join(FIX, "status-report.md");
const PDF = path.join(FIX, "status-report.pdf");

const config = loadConfig({ NODE_ENV: "test", STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" });

/* The upload route writes accepted workbooks into dataDir, and a real vault
   writes real bytes. Both get a throwaway directory per app, never the real
   data/ folder -- pointing dataDir at data/ once dropped a workbook into the
   running dashboard's watched directory. */
const scratchDirs = [];
function scratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcio-purge-test-"));
  scratchDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {{role?: string, documents?: object|null, sourceFiles?: object|null, vault?: object|null}} [opts]
 *        documents/sourceFiles default to the in-memory pair; pass null to
 *        model a deployment that wired no document store.
 */
function makeApp({ role = "pm", documents = memoryDocuments(), sourceFiles = memorySourceFiles(), vault = null } = {}) {
  const audited = [];
  const app = createApp({
    store: new Store(),
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ [`gcio-dashboard-${role}s`]: role }),
    audit: { append: async (e) => { audited.push(e); }, recent: async () => [] },
    ldapAuthenticate: devAuthenticate(role),
    documents,
    sourceFiles,
    vault,
    dataDir: scratchDir(),
    clientDist: "client/dist",
  });
  return { app, audited };
}

/** Sign in and return an agent carrying the session cookie. */
async function signedIn(app) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username: "tester", password: "anything" });
  assert.equal(res.status, 200, `sign-in failed: ${JSON.stringify(res.body)}`);
  return agent;
}

/** Build an app and sign in against it. */
async function signedInApp(opts) {
  const made = makeApp(opts);
  return { ...made, agent: await signedIn(made.app) };
}

/** The Documents section as the briefing renders it. */
async function documentsSection(agent) {
  const res = await agent.get("/api/summary?period=monthly");
  assert.equal(res.status, 200, `/api/summary answered ${res.status}`);
  return res.body.sections.documents;
}

/** Import one file as this agent and hand back the id the briefing shows. */
async function importOne(agent, file, name) {
  const fileName = name || path.basename(file);
  const bytes = fs.readFileSync(file);
  const res = await agent.post("/api/ingest/upload").attach("files", bytes, fileName);
  assert.equal(res.body.ok, true, `import failed: ${JSON.stringify(res.body.errors)}`);
  const section = await documentsSection(agent);
  const doc = section.documents.find((d) => d.fileName === fileName);
  assert.ok(doc, `imported file is not in the briefing: ${JSON.stringify(section.documents.map((d) => d.fileName))}`);
  return doc.documentId;
}

/** Every file under a vault root, with its bytes, in a stable order. */
function vaultContents(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ rel: path.relative(root, full).split(path.sep).join("/"), bytes: fs.readFileSync(full) });
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * A document store already holding one row, so a role can be tested without
 * that role first needing the upload permission it is being denied.
 */
async function seededDocuments(sourceFileId = 4242) {
  const documents = memoryDocuments();
  await documents.add({
    sourceFileId,
    fileName: "seeded.md",
    kind: "text",
    title: "Seeded Document",
    pageCount: null,
    wordCount: 12,
    extract: { blocks: [], facts: { dates: [], money: [], projectRefs: [] }, summary: ["seeded"], warnings: [] },
  });
  return documents;
}

test("a pm can remove an imported document and it leaves the briefing", async () => {
  const { agent } = await signedInApp({ role: "pm" });
  const id = await importOne(agent, MD);

  /* The document is really there first -- otherwise "gone afterwards" is
     satisfied by an import that never landed. */
  const before = await documentsSection(agent);
  assert.equal(before.available, true);
  assert.equal(before.documents.length, 1);

  const res = await agent.delete(`/api/documents/${id}`);
  assert.equal(res.status, 200, `purge answered ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);

  /* Gone from the briefing, not merely a 200. A route that answers ok and
     removes nothing passes the status assertion and fails this one. */
  const after = await documentsSection(agent);
  assert.equal(after.available, false, `still in the briefing: ${JSON.stringify(after.documents)}`);
  assert.equal(after.documents.length, 0);
});

test("purging one document leaves the others, and leaves the shared vault copy", async () => {
  /* A real vault, not a spy: it is content-addressed, and that is the whole
     reason the purge does not touch it. Identical bytes filed under two names
     are two documents sharing one vault file. */
  const vaultRoot = scratchDir();
  const { agent } = await signedInApp({ role: "pm", vault: createVault(vaultRoot) });

  const doomedId = await importOne(agent, MD, "doomed.md");
  const keptId = await importOne(agent, MD, "kept.md");
  assert.notEqual(doomedId, keptId, "the two imports collapsed into one document");

  const section = await documentsSection(agent);
  assert.deepEqual(section.documents.map((d) => d.fileName).sort(), ["doomed.md", "kept.md"]);

  const vaultBefore = vaultContents(vaultRoot);
  assert.equal(
    vaultBefore.length,
    1,
    `identical bytes should be vaulted once, got ${JSON.stringify(vaultBefore.map((f) => f.rel))}`
  );

  const res = await agent.delete(`/api/documents/${doomedId}`);
  assert.equal(res.status, 200, `purge answered ${res.status}: ${JSON.stringify(res.body)}`);

  /* Exactly the one named, by name -- a count of one is also what deleting
     the wrong row leaves behind. */
  const after = await documentsSection(agent);
  assert.equal(after.available, true, "purging one document emptied the section");
  assert.deepEqual(after.documents.map((d) => d.fileName), ["kept.md"]);
  assert.equal(after.documents[0].documentId, keptId);

  /* And the bytes are untouched, which is what kept.md still depends on. */
  assert.deepEqual(vaultContents(vaultRoot), vaultBefore, "the purge deleted the shared vault copy");
});

test("removing something that is not there is a 404, not a silent success", async () => {
  const { agent } = await signedInApp({ role: "pm" });
  const realId = await importOne(agent, MD);

  const missing = await agent.delete("/api/documents/999999");
  assert.equal(missing.status, 404, `answered ${missing.status}: ${JSON.stringify(missing.body)}`);
  /* "not found" specifically, not whatever else happens to answer 404. */
  assert.match(JSON.stringify(missing.body), /no such imported document/i);

  /* The miss removed nothing on its way past. */
  assert.equal((await documentsSection(agent)).documents.length, 1);

  /* And the same call against an id that does exist is a 200 -- without this
     the 404 above is also what a route that can never delete anything gives. */
  const hit = await agent.delete(`/api/documents/${realId}`);
  assert.equal(hit.status, 200, `the real id answered ${hit.status}: ${JSON.stringify(hit.body)}`);
});

test("an id that is not a whole number is refused before anything is removed", async () => {
  const { agent } = await signedInApp({ role: "pm" });
  await importOne(agent, MD);

  for (const bad of ["not-a-number", "1.5", "12abc"]) {
    const res = await agent.delete(`/api/documents/${bad}`);
    assert.equal(res.status, 400, `'${bad}' answered ${res.status}: ${JSON.stringify(res.body)}`);
    assert.match(JSON.stringify(res.body), /document id/i);
  }

  assert.equal((await documentsSection(agent)).documents.length, 1, "a malformed id removed a document");
});

test("a viewer cannot remove a document, and the identical call works as a pm", async () => {
  const ID = 4242;

  /* Seeded rather than uploaded: a viewer cannot upload either, so seeding is
     what lets the two roles be handed byte-for-byte the same request. */
  const viewer = await signedInApp({ role: "viewer", documents: await seededDocuments(ID) });
  const refused = await viewer.agent.delete(`/api/documents/${ID}`);

  assert.equal(refused.status, 403, `a viewer got ${refused.status}: ${JSON.stringify(refused.body)}`);
  /* The role check, not some other failure that also answers 403. */
  assert.equal(refused.body.error.code, "forbidden");
  assert.match(refused.body.error.message, /pm role/);
  assert.equal(
    (await documentsSection(viewer.agent)).documents.length,
    1,
    "the refused purge still removed the document"
  );

  /* One role up, same id, same request: 200. Without this the 403 proves
     nothing about the role -- a bad fixture would pass it too. */
  const pm = await signedInApp({ role: "pm", documents: await seededDocuments(ID) });
  const accepted = await pm.agent.delete(`/api/documents/${ID}`);
  assert.equal(accepted.status, 200, `a pm got ${accepted.status}: ${JSON.stringify(accepted.body)}`);
  assert.equal((await documentsSection(pm.agent)).documents.length, 0);
});

test("removing a document needs a session at all", async () => {
  const { app } = makeApp({ role: "pm", documents: await seededDocuments(7) });

  const res = await request(app).delete("/api/documents/7");
  assert.equal(res.status, 401, `an anonymous caller got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error.code, "no_session");

  /* And it removed nothing on the way to being refused. */
  const agent = await signedIn(app);
  assert.equal((await documentsSection(agent)).documents.length, 1);
});

test("a removal is audited, naming the actor and the document", async () => {
  const { agent, audited } = await signedInApp({ role: "pm" });
  const id = await importOne(agent, PDF);

  await agent.delete(`/api/documents/${id}`);

  const event = audited.find((a) => a.action === "document.removed");
  assert.ok(event, `no document.removed event in ${JSON.stringify(audited.map((a) => a.action))}`);
  assert.match(event.actor, /tester/);
  assert.equal(event.subject, String(id));

  /* A miss is not a removal and must not be audited as one. */
  await agent.delete("/api/documents/999999");
  assert.equal(
    audited.filter((a) => a.action === "document.removed").length,
    1,
    "a 404 was audited as a removal"
  );
});

test("a deployment with no document store answers 404 rather than failing obscurely", async () => {
  const { agent } = await signedInApp({ role: "pm", documents: null, sourceFiles: null });

  const res = await agent.delete("/api/documents/1");
  /* Specifically not a 500 from reaching through a null store. */
  assert.equal(res.status, 404, `answered ${res.status}: ${JSON.stringify(res.body)}`);
});

test("a purged document can be imported again", async () => {
  const { agent } = await signedInApp({ role: "pm" });
  const id = await importOne(agent, MD);
  assert.equal((await agent.delete(`/api/documents/${id}`)).status, 200);
  assert.equal((await documentsSection(agent)).available, false);

  /* The extract row was really removed, so the same bytes import again --
     rather than being swallowed by a row that only looked deleted. */
  const again = await importOne(agent, MD);
  const section = await documentsSection(agent);
  assert.equal(section.available, true);
  assert.equal(section.documents.length, 1);
  assert.equal(section.documents[0].documentId, again);
});
