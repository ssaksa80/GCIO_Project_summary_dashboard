import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dayjs from "dayjs";
import request from "supertest";
import { buildDocumentsSection, buildSections, SECTION_TITLES, annotateChanges } from "../../server/sections.js";
import { loadDocuments, buildSummary } from "../../server/summarize.js";
import { memoryDocuments } from "../../server/documents/memoryDocuments.js";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { Store } from "../../server/store.js";
import { memorySessions, memoryRoleMapping, devAuthenticate } from "../../server/devBackends.js";

/* A PDF: paged, with facts and a summary read off it. */
const pdfDoc = {
  sourceFileId: 7,
  fileName: "status.pdf",
  kind: "pdf",
  title: "Digital Identity Programme",
  pageCount: 3,
  wordCount: 220,
  extractedAt: "2026-08-31T10:00:00.000Z",
  extract: {
    blocks: [],
    facts: {
      dates: [{ iso: "2026-11-15", text: "15 November 2026", page: 1, context: "Go-live." }],
      money: [{ currency: "SAR", amount: 4200000, text: "SAR 4,200,000", page: 2 }],
      projectRefs: ["PRJ-1001"],
    },
    summary: [{ text: "The milestone slipped.", page: 1, heading: "Risks", score: 4 }],
    warnings: [],
  },
};

/* A Word file: no pages at all before it is rendered, so pageCount is null --
   the one field the whole pipeline has been careful never to coerce to 0. */
const wordDoc = {
  sourceFileId: 9,
  fileName: "plan.docx",
  kind: "docx",
  title: "Programme Plan",
  pageCount: null,
  wordCount: 84,
  extractedAt: "2026-08-31T09:00:00.000Z",
  extract: {
    blocks: [],
    facts: { dates: [], money: [], projectRefs: [] },
    summary: [{ text: "Phase two begins in October.", page: null, heading: null, score: 2 }],
    warnings: [],
  },
};

/* A scan: the adapter got nothing out of it and said so. */
const scannedDoc = {
  sourceFileId: 12,
  fileName: "scan.pdf",
  kind: "pdf",
  title: "scan.pdf",
  pageCount: 2,
  wordCount: 0,
  extractedAt: "2026-08-31T08:00:00.000Z",
  extract: {
    blocks: [],
    facts: { dates: [], money: [], projectRefs: [] },
    summary: [],
    warnings: ["no text layer — this looks like a scan"],
  },
};

/** Every object reachable from `node`, itself included. Arrays are containers,
    not nodes -- the same shape annotateChanges walks. */
function everyNode(node, out = [], seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const entry of node) everyNode(entry, out, seen);
    return out;
  }
  out.push(node);
  for (const value of Object.values(node)) everyNode(value, out, seen);
  return out;
}

test("Documents is the sixth section title", () => {
  assert.equal(SECTION_TITLES.length, 6);
  assert.equal(SECTION_TITLES[5], "Documents");
  /* The five before it are unchanged and still in CIO order: this is an
     addition to the interface, not a reshuffle of it. */
  assert.deepEqual(SECTION_TITLES, [
    "Successes",
    "Questions, Risks & Issues",
    "Priorities",
    "Roadmap / Planned Projects",
    "Security Posture",
    "Documents",
  ]);
});

test("an empty import list reports unavailable rather than an empty list", () => {
  const section = buildDocumentsSection([]);
  assert.equal(section.available, false);
  assert.match(section.headline, /No documents/i);
  assert.deepEqual(section.documents, []);
});

test("a deployment with no document store at all is unavailable, not a crash", () => {
  /* buildSections calls this with its `documents = []` default whenever no
     store was wired up, and loadDocuments hands back [] for a null store. The
     no-argument call is the same claim one level further out. */
  const section = buildDocumentsSection();
  assert.equal(section.available, false);
  assert.deepEqual(section.documents, []);
});

test("buildSections always produces a documents section, wired or not", () => {
  const ctx = {
    period: "weekly",
    start: dayjs("2026-08-24"),
    end: dayjs("2026-08-30"),
    todayISO: "2026-08-31",
  };
  const bare = buildSections([], ctx);
  assert.equal(bare.documents.available, false, "no documents option must still yield the section");

  const wired = buildSections([], { ...ctx, documents: [pdfDoc] });
  assert.equal(wired.documents.available, true);
  assert.equal(wired.documents.documents[0].fileName, "status.pdf");
});

test("a stored document becomes one section item carrying its provenance", () => {
  const section = buildDocumentsSection([pdfDoc]);
  assert.equal(section.available, true);
  assert.equal(section.headline, "1 document imported.");
  assert.equal(section.documents.length, 1);

  const doc = section.documents[0];
  assert.equal(doc.title, "Digital Identity Programme");
  assert.equal(doc.fileName, "status.pdf");
  assert.equal(doc.kind, "pdf");
  assert.equal(doc.pageCount, 3);
  assert.equal(doc.wordCount, 220);
  assert.equal(doc.extractedAt, "2026-08-31T10:00:00.000Z");
  assert.equal(doc.summary[0].heading, "Risks");
  assert.equal(doc.summary[0].text, "The milestone slipped.");
  assert.deepEqual(doc.projectRefs, ["PRJ-1001"]);
  assert.equal(doc.dates[0].iso, "2026-11-15");
  assert.equal(doc.money[0].text, "SAR 4,200,000");
});

test("the headline counts what is actually there and agrees in number", () => {
  assert.equal(buildDocumentsSection([pdfDoc]).headline, "1 document imported.");
  assert.equal(buildDocumentsSection([pdfDoc, wordDoc]).headline, "2 documents imported.");
  assert.equal(buildDocumentsSection([pdfDoc, wordDoc, scannedDoc]).headline, "3 documents imported.");
});

test("a document with no pages keeps a null page count rather than inventing a zero", () => {
  const [doc] = buildDocumentsSection([wordDoc]).documents;
  assert.ok("pageCount" in doc, "the field must be present, not dropped");
  assert.strictEqual(doc.pageCount, null,
    "0 or undefined would report a page count that is a lie rather than a gap");
  /* The paged case in the same run, so a builder that hardcoded null here
     would not slip through. */
  const [paged] = buildDocumentsSection([pdfDoc]).documents;
  assert.strictEqual(paged.pageCount, 3);
});

test("a document the extractor could not read surfaces its warnings", () => {
  const [doc] = buildDocumentsSection([scannedDoc]).documents;
  assert.deepEqual(doc.warnings, ["no text layer — this looks like a scan"]);
  assert.equal(doc.wordCount, 0);
  assert.deepEqual(doc.summary, []);
  /* And a clean document is not given warnings it does not have. */
  const [clean] = buildDocumentsSection([pdfDoc]).documents;
  assert.deepEqual(clean.warnings, []);
});

test("the store's order is the section's order", () => {
  /* Both stores return newest first (documentExtractsRepo orders by
     ExtractedAt DESC; memoryDocuments reverses insertion order). The section
     must not re-sort or reverse that, or the two stores would disagree about
     which document is at the top of the briefing. */
  const section = buildDocumentsSection([pdfDoc, wordDoc, scannedDoc]);
  assert.deepEqual(section.documents.map((d) => d.documentId), [7, 9, 12]);
  assert.deepEqual(section.documents.map((d) => d.fileName), ["status.pdf", "plan.docx", "scan.pdf"]);
});

test("a stored row with no extract at all still lists, with empty facts", () => {
  /* Defensive, and cheap: a row written before the extract shape settled, or
     an extract that failed to parse, must not take the briefing down. */
  const section = buildDocumentsSection([{ sourceFileId: 3, fileName: "odd.txt", kind: "txt", title: "odd.txt", pageCount: null, wordCount: 0 }]);
  const [doc] = section.documents;
  assert.equal(section.available, true);
  assert.deepEqual(doc.summary, []);
  assert.deepEqual(doc.dates, []);
  assert.deepEqual(doc.money, []);
  assert.deepEqual(doc.projectRefs, []);
  assert.deepEqual(doc.warnings, []);
});

test("document nodes key on documentId so annotateChanges cannot touch them", () => {
  const section = buildDocumentsSection([pdfDoc, wordDoc, scannedDoc]);
  const doc = section.documents[0];

  assert.equal(doc.documentId, 7);

  /* annotateChanges walks on `node.projectId || node.id`. Its own comment
     warns that a builder exposing an item's OWN id under those names is
     silently misannotated with a project's change. This is that builder, so
     the invariant is asserted over EVERY node in the section, not just the
     first document: the field NAME is the protection. Do not weaken this to
     "no string id" -- the numeric type of a sourceFileId is an accident of
     the store, not a guard, and annotateChanges is one line away from
     matching numbers too. */
  const offenders = everyNode(section)
    .filter((n) => "id" in n || "projectId" in n)
    .map((n) => JSON.stringify(n).slice(0, 120));
  assert.deepEqual(offenders, [],
    "a Documents node exposed its own identity under `id`/`projectId`, which annotateChanges reads as a project");

  /* Now the behaviour itself, with a live changes map that contains every key
     a document node could plausibly collide on. The control item proves the
     walk actually ran with a live map -- without it this test would pass just
     as happily if annotateChanges did nothing at all. */
  const sections = {
    documents: section,
    control: { items: [{ id: "PRJ-1001", name: "a real project" }] },
  };
  const changes = new Map([
    ["7", { worst: "worse" }],
    [7, { worst: "worse" }],
    ["status.pdf", { worst: "worse" }],
    ["PRJ-1001", { worst: "worse" }],
  ]);
  annotateChanges(sections, changes);

  assert.equal(sections.control.items[0].change.worst, "worse",
    "positive control: annotateChanges did not annotate anything, so the rest of this test proves nothing");

  const annotated = everyNode(section).filter((n) => "change" in n);
  assert.deepEqual(annotated, [],
    "a document must never be annotated with a project's change");
});

/* ---------------------------------------------------------------------------
   loadDocuments, and the wiring that carries its result to the briefing.

   Without the two app-level tests at the bottom, `deps.documents` and the
   loadDocuments call in app.js's summarize helper could both be deleted and
   the whole suite would stay green -- the section builder above is tested
   directly, so nothing else notices that no document ever reaches it.
   --------------------------------------------------------------------------- */

test("no document store at all is an empty list, not a throw", async () => {
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(msg);
  try {
    assert.deepEqual(await loadDocuments(null), []);
    assert.deepEqual(await loadDocuments(undefined), []);
    /* A store object that predates this feature, or a stub that only writes.
       Checked before it is called, not caught after: a deployment that never
       had a document store is a normal condition and must not fill the log
       with TypeErrors on every summary request. */
    assert.deepEqual(await loadDocuments({ add: async () => {} }), []);
  } finally {
    console.error = original;
  }
  assert.deepEqual(errors, [], "not having a document store is not an error worth logging");
});

test("a store that lists returns its rows untouched", async () => {
  const store = memoryDocuments();
  await store.add(wordDoc);
  await store.add(pdfDoc);
  const rows = await loadDocuments(store);
  assert.deepEqual(rows.map((r) => r.sourceFileId), [7, 9],
    "loadDocuments must hand back the store's own order, newest first");
});

test("a store that cannot be read costs the section, not the briefing", async () => {
  /* Same trade loadChanges makes: the dashboard is still correct without the
     Documents section, so a failed query must not take the whole page down. */
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(msg);
  try {
    const rows = await loadDocuments({ list: async () => { throw new Error("connection reset"); } });
    assert.deepEqual(rows, []);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /connection reset/);
});

test("buildSummary puts the loaded documents in the sections payload", () => {
  const store = new Store();
  const summary = buildSummary(store, "weekly", "2026-08-24", { documents: [pdfDoc] });
  assert.equal(summary.sections.documents.available, true);
  assert.equal(summary.sections.documents.documents[0].fileName, "status.pdf");

  /* And a caller that passes no documents option still gets the section. */
  const bare = buildSummary(store, "weekly", "2026-08-24");
  assert.equal(bare.sections.documents.available, false);
});

const scratchDirs = [];
test.after(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function appWith(documents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcio-docs-test-"));
  scratchDirs.push(dir);
  return createApp({
    store: new Store(),
    config: loadConfig({ NODE_ENV: "test", STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" }),
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ "gcio-dashboard-admins": "admin" }),
    audit: { append: async () => {}, recent: async () => [] },
    ldapAuthenticate: devAuthenticate("admin"),
    dataDir: dir,
    clientDist: "client/dist",
    documents,
  });
}

async function signedIn(app) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username: "tester", password: "anything" });
  assert.equal(res.status, 200, `sign-in failed: ${JSON.stringify(res.body)}`);
  return agent;
}

test("a wired document store reaches /api/summary", async () => {
  const store = memoryDocuments();
  await store.add(wordDoc);
  await store.add(pdfDoc);

  const agent = await signedIn(appWith(store));
  const res = await agent.get("/api/summary?period=weekly&date=2026-08-24");
  assert.equal(res.status, 200);

  const section = res.body.sections.documents;
  assert.equal(section.available, true, "the app never asked the document store for anything");
  assert.equal(section.headline, "2 documents imported.");
  assert.deepEqual(section.documents.map((d) => d.fileName), ["status.pdf", "plan.docx"]);
  assert.equal(section.documents[0].documentId, 7);
  assert.equal(section.documents[1].pageCount, null, "the null page count did not survive the round trip");
});

test("no document store wired is an unavailable section, not a 500", async () => {
  const agent = await signedIn(appWith(undefined));
  const res = await agent.get("/api/summary?period=weekly&date=2026-08-24");
  assert.equal(res.status, 200);
  assert.equal(res.body.sections.documents.available, false);
  assert.deepEqual(res.body.sections.documents.documents, []);
});
