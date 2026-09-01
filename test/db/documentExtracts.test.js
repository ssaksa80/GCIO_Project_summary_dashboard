/**
 * documentExtractsRepo against a scripted executor.
 *
 * This is NOT a substitute for running it against SQL Server -- no statement
 * here is ever parsed by a database, so a syntax error would pass. What it
 * does pin is everything decided in JavaScript that would otherwise ship
 * unexercised: values are bound as typed parameters rather than concatenated,
 * a page-less document binds and reads back as NULL rather than 0,
 * ExtractedAt is the database's clock, and `add` reports the row the database
 * holds rather than the one it was offered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { documentExtractsRepo } from "../../server/repos/documentExtracts.js";
import { sql } from "../../server/db/executor.js";

/** Records statements and replays canned recordsets, longest needle first. */
function scriptedExecutor(recordsets = {}, { rowsAffected = null } = {}) {
  const statements = [];
  const ex = {
    statements,
    async query(text, params) {
      statements.push({ text: text.trim(), params: params || [] });
      const needles = Object.keys(recordsets).sort((a, b) => b.length - a.length);
      for (const needle of needles) {
        if (text.includes(needle)) {
          const rows = recordsets[needle];
          return { recordset: rows, rowsAffected: rowsAffected ?? [rows.length] };
        }
      }
      return { recordset: [], rowsAffected: rowsAffected ?? [0] };
    },
    async tx(fn) { return fn(ex); },
  };
  return ex;
}

const row = (over = {}) => ({
  SourceFileId: 7,
  FileName: "status.pdf",
  Kind: "pdf",
  Title: "Digital Identity Programme",
  PageCount: 3,
  WordCount: 220,
  ExtractJson: JSON.stringify({
    blocks: [], facts: { dates: [], money: [], projectRefs: ["PRJ-1001"] }, summary: [], warnings: [],
  }),
  ExtractedAt: new Date("2026-08-31T10:00:00.000Z"),
  ...over,
});

const doc = (over = {}) => ({
  sourceFileId: 7,
  kind: "pdf",
  title: "Digital Identity Programme",
  pageCount: 3,
  wordCount: 220,
  extract: { blocks: [], facts: { dates: [], money: [], projectRefs: ["PRJ-1001"] }, summary: [], warnings: [] },
  ...over,
});

const paramNamed = (stmt, name) => stmt.params.find((p) => p.name === name);

test("a stored row is mapped into the shape the section builder reads", async () => {
  const ex = scriptedExecutor({ "FROM dbo.DocumentExtract d": [row()] });
  const [stored] = await documentExtractsRepo(ex).list();

  assert.equal(stored.sourceFileId, 7);
  assert.equal(stored.fileName, "status.pdf", "the file name comes from the JOIN, not the extract");
  assert.equal(stored.kind, "pdf");
  assert.equal(stored.title, "Digital Identity Programme");
  assert.equal(stored.pageCount, 3);
  assert.equal(stored.wordCount, 220);
  assert.equal(stored.extractedAt, "2026-08-31T10:00:00.000Z", "a DATETIME2 arrives as a Date, not a string");
  /* Parsed, not handed on as JSON text: everything above the store treats
     `extract` as an object. */
  assert.deepEqual(stored.extract.facts.projectRefs, ["PRJ-1001"]);
});

test("a page-less document reads back as null, not 0", async () => {
  const ex = scriptedExecutor({ "FROM dbo.DocumentExtract d": [row({ Kind: "docx", PageCount: null })] });
  const [stored] = await documentExtractsRepo(ex).list();

  /* Number(null) is 0, which would report a .docx as having no pages rather
     than as having no page count at all. */
  assert.equal(stored.pageCount, null);
});

test("the listing is ordered newest first", async () => {
  const ex = scriptedExecutor({ "FROM dbo.DocumentExtract d": [] });
  await documentExtractsRepo(ex).list();

  assert.match(ex.statements[0].text, /ORDER BY\s+d\.ExtractedAt DESC,\s*d\.DocumentExtractId DESC/,
    "without the identity tiebreak, two extracts in the same millisecond order arbitrarily");
});

test("adding binds every value as a typed parameter and never concatenates one", async () => {
  const ex = scriptedExecutor({ "FROM dbo.DocumentExtract d": [row()] });
  await documentExtractsRepo(ex).add(doc());

  const insert = ex.statements.find((s) => s.text.includes("INSERT INTO dbo.DocumentExtract"));
  assert.ok(insert, "no INSERT was issued");

  assert.equal(paramNamed(insert, "id").value, 7);
  assert.equal(paramNamed(insert, "id").type, sql.BigInt, "SourceFileId is a BIGINT");
  assert.equal(paramNamed(insert, "kind").value, "pdf");
  assert.equal(paramNamed(insert, "kind").type.type, sql.VarChar);
  assert.equal(paramNamed(insert, "kind").type.length, 8, "Kind is VARCHAR(8)");
  assert.equal(paramNamed(insert, "title").type.type, sql.NVarChar);
  assert.equal(paramNamed(insert, "title").type.length, 400, "Title is NVARCHAR(400)");
  assert.equal(paramNamed(insert, "words").value, 220);
  assert.equal(paramNamed(insert, "words").type, sql.Int);

  /* The extract is one JSON document in one NVARCHAR(MAX) column, which is
     what migration 12's comment argues for. */
  assert.equal(paramNamed(insert, "json").type.length, sql.MAX);
  assert.deepEqual(JSON.parse(paramNamed(insert, "json").value), doc().extract);

  /* A title is text lifted out of an uploaded document. Interpolated instead
     of bound, it would appear in the statement itself. */
  assert.ok(!insert.text.includes("Digital Identity Programme"),
    "a value was concatenated into the SQL rather than bound");
});

test("a page-less document binds NULL rather than being dropped or zeroed", async () => {
  const ex = scriptedExecutor({ "FROM dbo.DocumentExtract d": [row({ PageCount: null })] });
  await documentExtractsRepo(ex).add(doc({ kind: "docx", pageCount: null }));

  const insert = ex.statements.find((s) => s.text.includes("INSERT INTO dbo.DocumentExtract"));
  const pages = paramNamed(insert, "pages");
  assert.ok(pages, "@pages must still be bound, or the INSERT has an unbound parameter");
  assert.equal(pages.value, null, "PageCount is nullable precisely so this stays a gap");
  assert.equal(pages.type, sql.Int);
});

test("the extract time is the database's clock, never the caller's", async () => {
  const ex = scriptedExecutor({ "FROM dbo.DocumentExtract d": [row()] });
  await documentExtractsRepo(ex).add(doc());

  const insert = ex.statements.find((s) => s.text.includes("INSERT INTO dbo.DocumentExtract"));
  assert.match(insert.text, /SYSUTCDATETIME\(\)/);
  assert.equal(paramNamed(insert, "extractedAt"), undefined,
    "a bound timestamp would be whichever app server happened to handle the upload");
});

test("a second import inserts nothing and returns the extract already stored", async () => {
  /* The canned row is what the database holds from the FIRST import. The
     INSERT's WHERE NOT EXISTS makes the second one a no-op; `add` must then
     report that row rather than echoing back what it was handed. */
  const ex = scriptedExecutor({ "FROM dbo.DocumentExtract d": [row()] });
  const stored = await documentExtractsRepo(ex).add(doc({ title: "Renamed", wordCount: 999 }));

  const insert = ex.statements.find((s) => s.text.includes("INSERT INTO dbo.DocumentExtract"));
  assert.match(insert.text, /WHERE NOT EXISTS/, "nothing stops a duplicate row without this");
  assert.match(insert.text, /WITH \(HOLDLOCK\)/, "two uploads in flight would both see no row and both insert");

  assert.equal(stored.title, "Digital Identity Programme", "add returned its input instead of reading back");
  assert.equal(stored.wordCount, 220);
  assert.equal(stored.extractedAt, "2026-08-31T10:00:00.000Z", "the first import's stamp must survive");
});

test("removing reports whether a row was actually removed", async () => {
  const hit = scriptedExecutor({}, { rowsAffected: [1] });
  assert.equal(await documentExtractsRepo(hit).remove(7), true);

  const miss = scriptedExecutor({}, { rowsAffected: [0] });
  assert.equal(await documentExtractsRepo(miss).remove(7), false);

  /* A driver that reports no rowsAffected at all must read as "nothing was
     removed" -- not crash, and not "yes". */
  const silent = scriptedExecutor({}, { rowsAffected: [] });
  assert.equal(await documentExtractsRepo(silent).remove(7), false);

  const del = hit.statements[0];
  assert.match(del.text, /DELETE FROM dbo\.DocumentExtract WHERE SourceFileId = @id/);
  assert.equal(paramNamed(del, "id").value, 7);
  assert.equal(paramNamed(del, "id").type, sql.BigInt);
});
