/**
 * The Documents section, carried into all four exports.
 *
 * These tests read the bytes each exporter actually produced — the HTML
 * string, the docx's word/document.xml, the workbook read back through
 * ExcelJS, the deck's slide XML — because the only pre-existing coverage of
 * these four builders is in test/api/app.test.js, which asserts an HTTP 200
 * and a Content-Type and nothing whatsoever about what is inside the file.
 * A section could be deleted from every exporter and that suite would stay
 * green, so every assertion here is written to fail if the section were
 * silently dropped, rendered when unavailable, or made to cite a page that
 * does not exist.
 */
import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import ExcelJS from "exceljs";

import { Store } from "../../server/store.js";
import { ingestDirectory } from "../../server/ingest.js";
import { buildSummary } from "../../server/summarize.js";
import { buildDocumentsSection } from "../../server/sections.js";
import { buildHtml } from "../../server/exporters/html.js";
import { buildWord } from "../../server/exporters/word.js";
import { buildExcel } from "../../server/exporters/excel.js";
import { buildPptxDeck } from "../../server/exporters/pptx.js";

/* ------------------------------------------------------------------ */
/* Fixtures — store rows, the shape buildDocumentsSection consumes.     */
/* ------------------------------------------------------------------ */

/* A PDF: real pages, so a real page citation is available. */
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
    summary: [{ text: "The milestone slipped by six weeks.", page: 1, heading: "Risks", score: 4 }],
    warnings: [],
  },
};

/* A Word file: no pages exist before something renders it, so pageCount and
   every sentence's page are null. Nothing may print a number for these. */
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

/* A scan: nothing came out of it, and it said so. Empty summary, non-empty
   warnings — the case where a document is easiest to accidentally drop. */
const scannedDoc = {
  sourceFileId: 12,
  fileName: "scan.pdf",
  kind: "pdf",
  title: "Board Pack Scan",
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

const ALL_DOCS = [pdfDoc, wordDoc, scannedDoc];
const SCAN_WARNING = "no text layer — this looks like a scan";

/* One ingested portfolio, shared: the exporters need a whole realistic
   summary around the section under test, not a stub. */
const store = new Store();
ingestDirectory(store, "sample-data");

function payloadWith(documents) {
  const summary = buildSummary(store, "weekly", "2026-08-24", { documents });
  return {
    summary,
    projects: store.all().slice(0, 5),
    detailProjects: [],
    meta: { currency: "AED", demoMode: false, projectCount: store.projectCount },
    images: [],
    generatedBy: "GCIO Project Intelligence",
    asOf: "2026-08-31",
  };
}

/** The same payload, but with the section marked unavailable while still
    carrying every document. Rendering this proves nothing unless the
    documents are present: an exporter that ignores `available` would then
    print them, which is exactly the mistake being pinned. */
function unavailablePayload() {
  const p = payloadWith(ALL_DOCS);
  p.summary.sections.documents = {
    ...buildDocumentsSection(ALL_DOCS),
    available: false,
    headline: "No documents have been imported yet.",
  };
  return p;
}

/* ------------------------------------------------------------------ */
/* Shared claims                                                       */
/* ------------------------------------------------------------------ */

/**
 * No export may cite a page that does not exist.
 *
 * Both halves are load-bearing. Dropping the null guard around a page yields
 * "page 0" (num(null) is 0), which the second regex would never see; leaving
 * the raw value in yields "page null", which the first would never see.
 * @param {string} text rendered output, as text
 * @param {string} where exporter name, for the failure message
 * @param {number} expected how many real page citations the fixtures justify
 */
function assertNoInventedPages(text, where, expected) {
  assert.ok(
    !/page\s*[:,]?\s*(null|undefined|nan)\b/i.test(text),
    `${where} printed a page for a document that has none`
  );
  assert.ok(
    !/\b(0|null|undefined|NaN)\s+pages?\b/i.test(text),
    `${where} printed a page count for a document that has none`
  );
  const cited = text.match(/page\s+\d+/gi) || [];
  assert.equal(
    cited.length, expected,
    `${where} cited ${cited.length} page numbers, expected ${expected} — ${JSON.stringify(cited)}`
  );
  for (const c of cited) {
    assert.ok(Number(c.match(/\d+/)[0]) > 0, `${where} cited "${c}", which is not a real page`);
  }
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

test("the HTML brief carries every imported document, its sentences and its provenance", () => {
  const html = buildHtml(payloadWith(ALL_DOCS));

  assert.match(html, />Documents</, "the section heading is missing");
  assert.ok(html.includes("3 documents imported."), "the headline is missing");

  /* The PDF: title, file, page count, sentence, and a real citation. */
  assert.ok(html.includes("Digital Identity Programme"), "the PDF's title is missing");
  assert.ok(html.includes("status.pdf"), "the PDF's file name is missing");
  assert.ok(html.includes("3 pages"), "the PDF's page count is missing");
  assert.ok(html.includes("The milestone slipped by six weeks."), "the extracted sentence is missing");
  assert.ok(html.includes("Risks, page 1"), "the sentence lost its provenance");
  assert.ok(html.includes("PRJ-1001"), "the project reference is missing");

  /* The Word file: present, and cited without a page. */
  assert.ok(html.includes("Programme Plan"), "the Word document is missing");
  assert.ok(html.includes("Phase two begins in October."), "the Word document's sentence is missing");

  /* The scan: no sentences at all, but it must still be visible with its
     warning — the alternative reads as "this was never imported". */
  assert.ok(html.includes("Board Pack Scan"), "a document with no extracted text vanished");
  assert.ok(html.includes(SCAN_WARNING), "the scan's warning is missing");

  /* Selected, not written — the heading may never say "Summary". */
  assert.ok(html.includes("Extracted from the document"), "the sentences lost their heading");
});

test("the HTML brief never invents a page for a document that has none", () => {
  const html = buildHtml(payloadWith(ALL_DOCS));
  /* Exactly one: only the PDF's sentence has a page. */
  assertNoInventedPages(html, "html.js", 1);
});

test("an unavailable Documents section prints nothing in the HTML brief", () => {
  const html = buildHtml(unavailablePayload());
  assert.ok(!html.includes("Digital Identity Programme"), "a document was printed while unavailable");
  assert.ok(!html.includes("Extracted from the document"), "the section rendered while unavailable");
  assert.ok(!html.includes(SCAN_WARNING), "a warning was printed while unavailable");
  /* And the rest of the brief is untouched — this is a section going quiet,
     not the export falling over. */
  assert.match(html, /Security Posture|Key Performance Indicators/);
});

/* ------------------------------------------------------------------ */
/* Word                                                                */
/* ------------------------------------------------------------------ */

/** Every run of visible text in a .docx, in order. */
async function docxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file("word/document.xml").async("string");
  return [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
    .map((m) => m[1]
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"))
    .join("\n");
}

test("the Word brief carries every imported document, its sentences and its provenance", async () => {
  const text = await docxText(await buildWord(payloadWith(ALL_DOCS)));

  assert.ok(text.includes("6 · Documents"), "the section heading is missing");
  assert.ok(text.includes("3 documents imported."), "the headline is missing");

  assert.ok(text.includes("Digital Identity Programme"), "the PDF's title is missing");
  assert.ok(text.includes("status.pdf · pdf · 3 pages · 220 words · imported 31 Aug 2026"),
    "the PDF's metadata line is missing or wrong");
  assert.ok(text.includes("The milestone slipped by six weeks."), "the extracted sentence is missing");
  assert.ok(text.includes("— Risks, page 1"), "the sentence lost its provenance");
  assert.ok(text.includes("Mentions: PRJ-1001 (reported, not linked)"), "the project reference is missing");

  assert.ok(text.includes("Programme Plan"), "the Word document is missing");
  assert.ok(text.includes("Phase two begins in October."), "the Word document's sentence is missing");
  assert.ok(text.includes("— document"), "the pageless sentence lost its provenance entirely");

  assert.ok(text.includes("Board Pack Scan"), "a document with no extracted text vanished");
  assert.ok(text.includes(SCAN_WARNING), "the scan's warning is missing");

  /* Verbatim, not merely case-insensitively: this exporter's sectionLabel
     helper uppercases everything it is given, and routing the heading
     through it would put "EXTRACTED FROM THE DOCUMENT" in front of a reader.
     The wording is a claim about provenance and is pinned as written — and
     it may never be "Summary", which would claim authorship. */
  assert.ok(text.includes("Extracted from the document"), "the sentences lost their heading");
  assert.ok(!/^Summary$/m.test(text), "the sentences were labelled as a summary");
});

test("the Word brief never invents a page for a document that has none", async () => {
  const text = await docxText(await buildWord(payloadWith(ALL_DOCS)));
  assertNoInventedPages(text, "word.js", 1);
});

test("an unavailable Documents section prints nothing in the Word brief", async () => {
  const text = await docxText(await buildWord(unavailablePayload()));
  assert.ok(!text.includes("Digital Identity Programme"), "a document was printed while unavailable");
  assert.ok(!text.includes("6 · Documents"), "the section rendered while unavailable");
  assert.ok(!text.includes(SCAN_WARNING), "a warning was printed while unavailable");
  assert.ok(text.includes("Key Performance Indicators"), "the rest of the brief did not survive");
});

/* ------------------------------------------------------------------ */
/* Excel                                                               */
/* ------------------------------------------------------------------ */

async function workbookFrom(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

/** The sheet's data rows (below the banner and the header) as plain arrays. */
function dataRows(ws) {
  const out = [];
  ws.eachRow((row, n) => {
    if (n <= 2) return;
    out.push(row.values.slice(1).map((v) => (v === undefined ? "" : v)));
  });
  return out;
}

test("the workbook gets one row per extracted sentence, not one cell per document", async () => {
  const wb = await workbookFrom(await buildExcel(payloadWith(ALL_DOCS)));
  const ws = wb.getWorksheet("6 Documents");
  assert.ok(ws, "the Documents sheet is missing from the workbook");

  assert.deepEqual(ws.getRow(2).values.slice(1),
    ["Document", "File", "Page", "Heading", "Extracted sentence", "Warnings"]);

  const rows = dataRows(ws);
  /* One sentence from the PDF, one from the Word file, and one row for the
     scan that yielded none — three rows, not three cells of glued text. */
  assert.equal(rows.length, 3, `expected a row per sentence, got ${JSON.stringify(rows)}`);

  const pdfRow = rows.find((r) => r[4] === "The milestone slipped by six weeks.");
  assert.ok(pdfRow, "the PDF's sentence is not a row of its own");
  assert.equal(pdfRow[0], "Digital Identity Programme");
  assert.equal(pdfRow[1], "status.pdf");
  assert.strictEqual(pdfRow[2], 1, "the page must be a real number so the column sorts");
  assert.equal(pdfRow[3], "Risks");

  const wordRow = rows.find((r) => r[4] === "Phase two begins in October.");
  assert.ok(wordRow, "the Word document's sentence is not a row of its own");
  assert.equal(wordRow[0], "Programme Plan");

  const scanRow = rows.find((r) => r[0] === "Board Pack Scan");
  assert.ok(scanRow, "a document with no extracted text vanished from the workbook");
  assert.match(String(scanRow[5]), /no text layer/, "the scan's warning is missing");
});

test("the workbook never invents a page for a document that has none", async () => {
  const wb = await workbookFrom(await buildExcel(payloadWith(ALL_DOCS)));
  const ws = wb.getWorksheet("6 Documents");
  const rows = dataRows(ws);

  const wordRow = rows.find((r) => r[4] === "Phase two begins in October.");
  const page = wordRow[2];
  assert.notStrictEqual(page, 0, "a pageless document was given page 0");
  assert.notStrictEqual(page, null, "a pageless document was given a null page cell");
  assert.ok(!/^(null|undefined|nan)$/i.test(String(page)),
    `a pageless document was given the page "${page}"`);

  /* And the whole sheet, read as text, contains no invented citation. */
  const text = rows.map((r) => r.join(" | ")).join("\n");
  assertNoInventedPages(text, "excel.js", 0);
});

test("an unavailable Documents section adds no sheet to the workbook", async () => {
  const wb = await workbookFrom(await buildExcel(unavailablePayload()));
  assert.equal(wb.getWorksheet("6 Documents"), undefined,
    "the Documents sheet was added while unavailable");
  const text = wb.worksheets.flatMap((ws) => dataRows(ws).map((r) => r.join(" "))).join("\n");
  assert.ok(!text.includes("Digital Identity Programme"), "a document was written while unavailable");
  assert.ok(wb.getWorksheet("Portfolio"), "the rest of the workbook did not survive");
});

/* ------------------------------------------------------------------ */
/* PowerPoint                                                          */
/* ------------------------------------------------------------------ */

async function slideXmls(bytes) {
  const zip = await JSZip.loadAsync(Buffer.from(bytes));
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return Promise.all(names.map((n) => zip.file(n).async("string")));
}

/** Every <a:t> run in a slide, decoded. */
function runsOf(xml) {
  return [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"));
}

test("the deck carries a Documents slide with the sentences and their provenance", async () => {
  const xmls = await slideXmls(buildPptxDeck(payloadWith(ALL_DOCS)));
  const slide = xmls.find((x) => runsOf(x).includes("Documents"));
  assert.ok(slide, "there is no Documents slide in the deck");

  const runs = runsOf(slide);
  const text = runs.join("\n");

  assert.ok(runs.includes("Digital Identity Programme"), "the PDF's title is missing");
  assert.ok(text.includes("The milestone slipped by six weeks."), "the extracted sentence is missing");
  assert.ok(runs.includes("Extracted from the document:"), "the sentences lost their heading");

  assert.ok(runs.includes("Programme Plan"), "the Word document is missing");
  assert.ok(text.includes("Phase two begins in October."), "the Word document's sentence is missing");

  assert.ok(runs.includes("Board Pack Scan"), "a document with no extracted text vanished");
  assert.ok(text.includes(SCAN_WARNING), "the scan's warning is missing");
});

test("the deck puts provenance on its own line, which OOXML only honours as its own run", async () => {
  /* A line feed inside a single <a:t> is ignored by OOXML: PowerPoint runs
     the two lines together with no separating space, and no geometry check
     can see it because the box was already sized for the extra line. This is
     the failure scripts/pptx-audit.mjs calls LINEFEED, asserted here so it
     gates the suite and not only a hand-run script. */
  const xmls = await slideXmls(buildPptxDeck(payloadWith(ALL_DOCS)));
  for (const [i, xml] of xmls.entries()) {
    for (const run of runsOf(xml)) {
      assert.ok(!run.includes("\n"),
        `slide ${i + 1} holds a raw line feed inside one <a:t>: ${JSON.stringify(run)}`);
    }
  }

  /* And the provenance really is a separate run sitting under its sentence. */
  const slide = xmls.find((x) => runsOf(x).includes("Documents"));
  const runs = runsOf(slide);
  const quote = runs.findIndex((r) => r.includes("The milestone slipped by six weeks."));
  assert.ok(quote >= 0, "the extracted sentence is missing");
  assert.equal(runs[quote + 1], "— Risks, page 1",
    "provenance is not the run immediately after its sentence");
});

test("the deck never invents a page for a document that has none", async () => {
  const xmls = await slideXmls(buildPptxDeck(payloadWith(ALL_DOCS)));
  const slide = xmls.find((x) => runsOf(x).includes("Documents"));
  assertNoInventedPages(runsOf(slide).join("\n"), "pptx.js", 1);
});

test("an unavailable Documents section adds no slide to the deck", async () => {
  const xmls = await slideXmls(buildPptxDeck(unavailablePayload()));
  const text = xmls.map((x) => runsOf(x).join("\n")).join("\n");
  assert.ok(!text.includes("Digital Identity Programme"), "a document was printed while unavailable");
  assert.ok(!text.includes("Extracted from the document"), "the section rendered while unavailable");
  assert.ok(!text.includes(SCAN_WARNING), "a warning was printed while unavailable");
  assert.ok(text.includes("Priorities"), "the rest of the deck did not survive");
});
