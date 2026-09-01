/**
 * Documents arrive through the same upload route as workbooks, and take a
 * different path once inside it.
 *
 * A workbook is written into the watched folder and the watcher owns the
 * upsert. A document has no projects to upsert, and the watcher does not
 * handle documents at all -- so the route vaults, records and extracts it
 * inline. These tests pin both halves of that fork, because the failure that
 * matters is not "documents do not import" but "documents import AND
 * workbooks quietly stopped".
 *
 * There is no shared test-app helper in this project -- verified, it does not
 * exist. test/api/app.test.js builds the app inline and this file follows it
 * rather than introducing a second harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { Store } from "../../server/store.js";
import { memorySessions, memoryRoleMapping, devAuthenticate } from "../../server/devBackends.js";
import { memoryDocuments, memorySourceFiles } from "../../server/documents/memoryDocuments.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/documents");
const PDF = path.join(FIX, "status-report.pdf");
const MD = path.join(FIX, "status-report.md");
const CORRUPT = path.join(FIX, "corrupt.pdf");
const WORKBOOK = path.resolve("sample-data", "GCIO_Portfolio_Master.xlsx");

const config = loadConfig({ NODE_ENV: "test", STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" });

/* The upload route writes accepted workbooks into dataDir. Pointing that at
   the real data/ folder once dropped a workbook into the running dashboard's
   watched directory. Every app under test gets its own throwaway one. */
const scratchDirs = [];
function scratchDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcio-docs-test-"));
  scratchDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {{role?: string, documents?: object|null, sourceFiles?: object|null}} [opts]
 *        documents/sourceFiles default to the in-memory pair; pass null to
 *        model a deployment that wired no document store.
 */
function makeApp({ role = "pm", documents = memoryDocuments(), sourceFiles = memorySourceFiles(), vault = null } = {}) {
  const audited = [];
  const dataDir = scratchDataDir();
  const app = createApp({
    store: new Store(),
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ [`gcio-dashboard-${role}s`]: role }),
    audit: { append: async (e) => { audited.push(e); }, recent: async () => [] },
    ldapAuthenticate: devAuthenticate(role),
    documents,
    sourceFiles,
    /* Null by default: only SqlStore has a vault. The document still imports
       without one, which is exactly the STORE=memory situation this suite
       runs in -- and the reason app.js takes the vault as its own dependency
       rather than reaching into store internals that memory mode lacks. */
    vault,
    dataDir,
    clientDist: "client/dist",
  });
  return { app, audited, dataDir };
}

/** A real vault, backed by a throwaway directory, that records what it stored. */
function spyVault() {
  const root = scratchDataDir();
  const stored = [];
  return {
    root,
    stored,
    store(buffer, name) {
      const entry = { name, bytes: buffer.length, hash: `vaulted-${stored.length}`, vaultPath: `2026/09/${name}` };
      stored.push(entry);
      fs.writeFileSync(path.join(root, name), buffer);
      return entry;
    },
  };
}

/** memorySourceFiles, plus the argument list every call was made with. */
function spySourceFiles() {
  const real = memorySourceFiles();
  const calls = [];
  return {
    calls,
    async record(file) {
      calls.push(file);
      return real.record(file);
    },
  };
}

/** Sign in and return an agent carrying the session cookie. */
async function signedIn(app) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username: "tester", password: "anything" });
  assert.equal(res.status, 200, `sign-in failed: ${JSON.stringify(res.body)}`);
  return agent;
}

/** Sign in and hand back the agent plus the audit log and data dir behind it. */
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

test("a mixed batch imports the good files and reports only the bad one", async () => {
  const { agent } = await signedInApp({ role: "pm" });

  const res = await agent
    .post("/api/ingest/upload")
    .attach("files", PDF)
    .attach("files", CORRUPT)
    .attach("files", MD);

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false, "one file failed, so the batch is not ok");

  /* By name, not by count: a count of two is also what you get if the corrupt
     file "succeeded" and one good one was dropped. */
  assert.deepEqual(
    res.body.ingested.map((i) => i.file).sort(),
    ["status-report.md", "status-report.pdf"],
    `wrong files reported as ingested: ${JSON.stringify(res.body.ingested)}`
  );
  assert.equal(res.body.errors.length, 1, `expected exactly one failure, got ${JSON.stringify(res.body.errors)}`);
  assert.equal(res.body.errors[0].file, "corrupt.pdf");
  /* The extractor's reason, not the guard's: corrupt.pdf carries a real %PDF-
     header, so it passes looksLikeSupportedFile and fails on the way in. A
     guard rejection here would mean the document branch never ran. */
  assert.match(res.body.errors[0].error, /not a readable \.pdf/i);

  /* The response array is not the store. Both good files must be readable
     back out of the briefing as two separate documents -- which is also what
     fails if every document is filed under the same source-file id. */
  const section = await documentsSection(agent);
  assert.equal(section.available, true);
  assert.deepEqual(
    section.documents.map((d) => d.fileName).sort(),
    ["status-report.md", "status-report.pdf"]
  );
});

test("an imported document appears in the briefing's Documents section", async () => {
  const { agent } = await signedInApp({ role: "pm" });

  const upload = await agent.post("/api/ingest/upload").attach("files", PDF);
  assert.equal(upload.status, 200);
  assert.equal(upload.body.ok, true, `upload failed: ${JSON.stringify(upload.body.errors)}`);

  const section = await documentsSection(agent);
  assert.equal(section.available, true);
  assert.equal(section.documents.length, 1);

  const doc = section.documents[0];
  assert.match(doc.title, /Digital Identity/);
  assert.equal(doc.fileName, "status-report.pdf");
  assert.equal(doc.kind, "pdf");
  assert.equal(doc.pageCount, 1);
  assert.equal(doc.wordCount, 61);
  /* The id the source-file ledger handed back, carried through to the
     section. Undefined here means the recorded id was thrown away, which
     would silently collapse every document into one row. */
  assert.equal(typeof doc.documentId, "number");
  assert.ok(doc.documentId > 0, `documentId was ${doc.documentId}`);
  /* Facts and summary were computed at import, not left for the renderer. */
  assert.deepEqual(doc.projectRefs, ["PRJ-1001"]);
  assert.ok(doc.summary.length > 0, "the extractive summary is empty");
  assert.ok(doc.dates.some((d) => d.iso === "2026-11-15"), `dates were ${JSON.stringify(doc.dates)}`);
  assert.ok(doc.money.some((m) => m.text === "SAR 6,000,000"), `money was ${JSON.stringify(doc.money)}`);
});

test("importing the same document twice keeps one entry, unrestamped", async () => {
  const { agent } = await signedInApp({ role: "pm" });

  const first = await agent.post("/api/ingest/upload").attach("files", PDF);
  assert.equal(first.body.ok, true, `first upload failed: ${JSON.stringify(first.body.errors)}`);
  const afterFirst = await documentsSection(agent);
  assert.equal(afterFirst.documents.length, 1, "the first import did not land");
  const stampedAt = afterFirst.documents[0].extractedAt;
  assert.ok(stampedAt, "the stored document has no extractedAt to compare");

  const second = await agent.post("/api/ingest/upload").attach("files", PDF);
  assert.equal(second.status, 200);
  assert.equal(second.body.ok, true, "re-importing an unchanged file is not an error");

  const after = await documentsSection(agent);
  assert.equal(after.documents.length, 1, "the second import duplicated the document");
  /* First write wins: an unchanged file must not look freshly imported. */
  assert.equal(after.documents[0].extractedAt, stampedAt);
});

test("a revised document under the same file name imports as a new entry", async () => {
  const { agent } = await signedInApp({ role: "pm" });

  const original = fs.readFileSync(MD);
  const revised = Buffer.from(String(original).replace("Digital Identity Programme", "Sovereign Cloud Programme"));
  assert.notEqual(String(original), String(revised), "the fixture edit did not take");

  await agent.post("/api/ingest/upload").attach("files", original, "status-report.md");
  const second = await agent.post("/api/ingest/upload").attach("files", revised, "status-report.md");
  assert.equal(second.body.ok, true, `the revision was refused: ${JSON.stringify(second.body.errors)}`);

  /* A document's identity is its content hash, not its name -- exactly what
     UX_SourceFile_Name_Sha means in SQL. Hash the name, or anything else
     constant, and the revision silently vanishes into the first import. */
  const section = await documentsSection(agent);
  assert.equal(section.documents.length, 2, "the revision did not import as its own document");
  assert.deepEqual(
    section.documents.map((d) => d.title).sort(),
    ["Digital Identity Programme", "Sovereign Cloud Programme"]
  );
});

test("a document with an extraction warning imports and carries the warning", async () => {
  const { agent } = await signedInApp({ role: "pm" });

  const res = await agent.post("/api/ingest/upload").attach("files", path.join(FIX, "scanned.pdf"));
  assert.equal(res.body.ok, true, `the scan was refused: ${JSON.stringify(res.body.errors)}`);
  assert.deepEqual(res.body.ingested[0].warnings, ["no text layer — this looks like a scan"]);

  /* And the warning survives into the briefing, rather than being computed
     for the upload response and dropped on the way to the store. */
  const doc = (await documentsSection(agent)).documents[0];
  assert.deepEqual(doc.warnings, ["no text layer — this looks like a scan"]);
  assert.equal(doc.wordCount, 0, "an empty scan must not be reported as having text");
});

test("a viewer cannot import documents, and the same upload works as a pm", async () => {
  /* The bytes in memory rather than the path, deliberately. requireRole
     answers 403 before multer reads a byte -- correct, or an unauthorised
     caller could make the server buffer 25MB first -- and superagent's
     disk-streamed attachment then dies with ECONNRESET instead of surfacing
     the response. Attaching the same bytes as a buffer sends the same
     request and lets the refusal be read. */
  const bytes = fs.readFileSync(MD);
  const attach = (agent) =>
    agent.post("/api/ingest/upload").attach("files", bytes, "status-report.md");

  const viewer = await signedInApp({ role: "viewer" });
  const refused = await attach(viewer.agent);

  assert.equal(refused.status, 403);
  /* The role check, not some other failure that also answers 403. */
  assert.equal(refused.body.error.code, "forbidden");
  assert.match(refused.body.error.message, /pm role/);
  assert.equal((await documentsSection(viewer.agent)).available, false, "the refused file still landed");

  /* Byte-for-byte the same request, one role up: 200. Without this the 403
     above proves nothing about the role -- a broken fixture would pass it. */
  const pm = await signedInApp({ role: "pm" });
  const accepted = await attach(pm.agent);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.ok, true, `the pm upload failed: ${JSON.stringify(accepted.body.errors)}`);
  assert.equal((await documentsSection(pm.agent)).documents.length, 1);
});

test("with no vault the ledger still records the file, hashed by content", async () => {
  const sourceFiles = spySourceFiles();
  const { agent } = await signedInApp({ role: "pm", sourceFiles });

  await agent.post("/api/ingest/upload").attach("files", MD);

  assert.equal(sourceFiles.calls.length, 1);
  const call = sourceFiles.calls[0];
  assert.equal(call.fileName, "status-report.md");
  assert.equal(call.bytes, fs.statSync(MD).size);
  /* No provenance copy, and the route says so rather than inventing a path. */
  assert.equal(call.vaultPath, null);
  /* Who imported it -- the ledger's whole point is answering that later. */
  assert.match(call.uploadedBy, /tester/);
  /* The sha256 of the bytes, not of the name and not a placeholder. */
  assert.equal(call.sha256, createHash("sha256").update(fs.readFileSync(MD)).digest("hex"));
});

test("when a vault is wired the bytes are vaulted and its hash is what is recorded", async () => {
  const vault = spyVault();
  const sourceFiles = spySourceFiles();
  const { agent } = await signedInApp({ role: "pm", vault, sourceFiles });

  await agent.post("/api/ingest/upload").attach("files", MD);

  assert.equal(vault.stored.length, 1, "the document was not vaulted");
  assert.equal(vault.stored[0].name, "status-report.md");
  assert.deepEqual(
    fs.readFileSync(path.join(vault.root, "status-report.md")),
    fs.readFileSync(MD),
    "the vaulted copy is not the uploaded bytes"
  );

  /* The vault's answer, carried straight into the ledger: with a vault it is
     the vault that decides the hash and the path, not the route. */
  assert.equal(sourceFiles.calls[0].sha256, "vaulted-0");
  assert.equal(sourceFiles.calls[0].vaultPath, "2026/09/status-report.md");

  /* And it still imported. */
  assert.equal((await documentsSection(agent)).documents.length, 1);
});

test("a workbook still takes the watched-folder path and is never a document", async () => {
  const { agent, dataDir } = await signedInApp({ role: "pm" });

  const res = await agent.post("/api/ingest/upload").attach("files", WORKBOOK);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true, `the workbook was refused: ${JSON.stringify(res.body.errors)}`);
  assert.equal(res.body.ingested.length, 1);
  /* `projects`, not `document`: the workbook went through ingestBuffer. */
  assert.ok(res.body.ingested[0].projects > 0, `ingested as ${JSON.stringify(res.body.ingested[0])}`);

  /* And it was handed to the watcher by landing in the watched folder, with
     no .uploading leftover. */
  assert.deepEqual(fs.readdirSync(dataDir), ["GCIO_Portfolio_Master.xlsx"]);

  assert.equal((await documentsSection(agent)).available, false, "a workbook was filed as a document");
});

test("a deployment with no document store says so instead of failing obscurely", async () => {
  const { agent } = await signedInApp({ role: "pm", documents: null, sourceFiles: null });

  const res = await agent.post("/api/ingest/upload").attach("files", MD);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.ingested.length, 0);
  assert.match(res.body.errors[0].error, /cannot import documents/i);
});

test("importing and failing to import a document are both audited", async () => {
  const { agent, audited } = await signedInApp({ role: "pm" });

  await agent.post("/api/ingest/upload").attach("files", PDF).attach("files", CORRUPT);

  const imported = audited.find((a) => a.action === "upload.document");
  assert.ok(imported, `no upload.document event in ${JSON.stringify(audited.map((a) => a.action))}`);
  assert.match(imported.actor, /tester/);
  assert.match(imported.subject, /status-report\.pdf/);
  assert.match(imported.subject, /61 words/);

  const rejected = audited.find((a) => a.action === "upload.rejected" && /corrupt/.test(a.subject));
  assert.ok(rejected, `the unreadable file was not audited: ${JSON.stringify(audited.map((a) => a.subject))}`);
  assert.match(rejected.subject, /not a readable \.pdf/i);
});
