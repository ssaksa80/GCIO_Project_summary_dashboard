/**
 * The document store STORE=memory uses, and the vault ledger beside it.
 *
 * This is the only one of the two stores the hermetic suite can run: the SQL
 * one needs a database, and the live suite is not run here. So these assert
 * the guarantees the SQL schema enforces with a unique index -- first write
 * wins, a re-import does not restamp -- rather than trusting that the two
 * implementations agree by inspection.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDocuments, memorySourceFiles } from "../../server/documents/memoryDocuments.js";

const sample = (id, over = {}) => ({
  sourceFileId: id,
  fileName: `doc-${id}.pdf`,
  kind: "pdf",
  title: `Doc ${id}`,
  pageCount: 1,
  wordCount: 10,
  extract: {
    blocks: [{ type: "para", text: "Go-live slipped.", page: 1, level: null }],
    facts: { dates: [{ iso: "2026-11-15", text: "15 November 2026", page: 1 }], money: [], projectRefs: ["PRJ-1001"] },
    summary: [{ text: "Go-live slipped.", page: 1, heading: "Risks", score: 4 }],
    warnings: [],
  },
  ...over,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a document is stored whole and listed back, stamped with when it was extracted", async () => {
  const docs = memoryDocuments();
  const doc = sample(1);
  const returned = await docs.add(doc);

  const all = await docs.list();
  assert.equal(all.length, 1);

  /* Every field, not just the title: a store that quietly dropped `extract`
     or `wordCount` would still satisfy a title assertion, and the section
     builder reads all of them. */
  assert.deepEqual(all[0], { ...doc, extractedAt: all[0].extractedAt });
  assert.deepEqual(returned, all[0], "add returns exactly what list will show");

  /* Not `assert.ok(extractedAt)` -- that is true of any non-empty string,
     including "yes". It has to be a real ISO instant, and a recent one. */
  const stampedAt = Date.parse(all[0].extractedAt);
  assert.ok(Number.isFinite(stampedAt), `extractedAt is not a timestamp: ${all[0].extractedAt}`);
  assert.equal(all[0].extractedAt, new Date(stampedAt).toISOString(), "extractedAt is not ISO-8601");
  assert.ok(Math.abs(Date.now() - stampedAt) < 60_000, "extractedAt is not now");
});

test("a document with no pages stores null, because 0 pages would be a lie", async () => {
  const docs = memoryDocuments();
  await docs.add(sample(2, { fileName: "brief.docx", kind: "docx", pageCount: null }));

  const [stored] = await docs.list();
  /* .docx and .txt have no pages before they are rendered -- that is a gap,
     not a count. Strict, so a 0 or an undefined here both fail. */
  assert.equal(stored.pageCount, null, "a page-less document must keep its null");
  assert.ok("pageCount" in stored, "pageCount must be present and null, not absent");
});

test("re-importing the same source file keeps the first extract, unrestamped", async () => {
  const docs = memoryDocuments();
  const first = await docs.add(sample(1));

  /* The clock has millisecond resolution, so two adds in the same tick would
     produce identical timestamps and an extractedAt assertion would pass
     against a store that restamps on every write. Separate them. */
  await sleep(5);
  const second = await docs.add(sample(1, { title: "Renamed", wordCount: 999, pageCount: 42 }));

  const all = await docs.list();
  assert.equal(all.length, 1, "a re-import must not add a second row");
  assert.equal(all[0].title, "Doc 1", "first write wins -- the later title must not overwrite it");
  assert.equal(all[0].wordCount, 10);
  assert.equal(all[0].extractedAt, first.extractedAt,
    "a re-import must not restamp -- it is the same document");
  assert.deepEqual(second, first, "add returns the extract already held, not the one offered");
});

test("removing reports whether anything was actually removed", async () => {
  const docs = memoryDocuments();
  await docs.add(sample(1));

  assert.equal(await docs.remove(1), true, "the row was there");
  assert.equal(await docs.remove(1), false, "it is gone now, so nothing was removed");
  assert.equal(await docs.remove(999), false, "a document that was never imported cannot be removed");
  assert.deepEqual(await docs.list(), []);
});

test("documents list newest first, the order the SQL store returns", async () => {
  const docs = memoryDocuments();
  await docs.add(sample(1));
  await docs.add(sample(2));
  await docs.add(sample(3));

  /* documentExtractsRepo.list orders by ExtractedAt DESC, DocumentExtractId
     DESC. If this store disagreed, the Documents section would be ordered one
     way on STORE=memory and the other on STORE=mssql -- and only the store no
     test ever runs would be right. */
  assert.deepEqual((await docs.list()).map((d) => d.sourceFileId), [3, 2, 1]);
});

test("recording identical bytes twice returns the same id", async () => {
  const files = memorySourceFiles();
  const a = await files.record({ fileName: "x.pdf", sha256: "a".repeat(64) });
  assert.equal(a.alreadySeen, false, "the first sighting is not a re-import");

  const b = await files.record({ fileName: "x.pdf", sha256: "a".repeat(64) });
  assert.equal(b.sourceFileId, a.sourceFileId);
  assert.equal(b.alreadySeen, true);

  const c = await files.record({ fileName: "x.pdf", sha256: "b".repeat(64) });
  assert.notEqual(c.sourceFileId, a.sourceFileId, "different bytes are a different file");
  assert.equal(c.alreadySeen, false);
});

test("the same bytes under a different name are a different file", async () => {
  const files = memorySourceFiles();
  const a = await files.record({ fileName: "x.pdf", sha256: "a".repeat(64) });
  const b = await files.record({ fileName: "renamed.pdf", sha256: "a".repeat(64) });

  /* UX_SourceFile_Name_Sha is on (FileName, Sha256), so SQL keeps both rows.
     Keying on the hash alone here would collapse them and hand the document
     store one id for two names. */
  assert.notEqual(b.sourceFileId, a.sourceFileId);
  assert.equal(b.alreadySeen, false);
});
