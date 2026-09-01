# Multi-Format Document Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a PM upload PDF, Word, text and Markdown files alongside workbooks, extract what is genuinely in them locally, and present the result as a sixth briefing section.

**Architecture:** Format-specific adapters all return one `ExtractedDocument` shape, so nothing downstream branches per format. Extraction is local — no document content leaves the network. Documents persist like workbooks (vault + `dbo.SourceFile`) with their extract in a new `dbo.DocumentExtract` table, and reach the briefing through `backends`, mirroring how `changes` is already passed into `buildSummary`. `SqlStore` is not touched.

**Tech Stack:** Node 24 ESM, Express 4, `node:test`, `jszip` (Word), `pdfjs-dist@^4.10` (PDF), React 18, SQL Server via `mssql`.

**Spec:** `docs/superpowers/specs/2026-08-27-document-import-design.md`

---

## Before you start

**Work in a fresh worktree.** `C:\dev\gcio-p4` is occupied by another live session that commits to it. Use the `superpowers:using-git-worktrees` skill to create an isolated one from current `origin/main`. Do not implement in `gcio-p4`.

**Test commands.** On this branch `npm test` is `node --test "test/**/*.test.js"`
and runs **everything, browser suites included**. There is no `test:all`. A peer
session has an unpushed change that splits the UI suites out; it is not on
`origin/main` and this plan does not assume it. If it lands mid-implementation,
re-read `package.json` rather than trusting this paragraph.

Two consequences:

- **The UI suites are in the run but skip unless `UI_LIVE=1`**, so a normal
  `npm test` neither needs a browser nor `client/dist`. When you do run them,
  `client/dist` must exist — it is gitignored, so a fresh worktree has none and
  needs `npm run build` first.
- **Never judge a run by the shell exit code alone if you piped the output.**
  `npm test | tail` reports `tail`'s status, not the test run's. Read the TAP
  summary (`# fail`) or capture the exit code without a pipe. This has produced
  three false "it passed" readings on this project already.

Do **not** set `DB_LIVE=1` — it needs an empty database and the live instance is
shared with other sessions.

**Never `git commit --amend`.** Other sessions commit to shared branches; amending folds their work into the wrong commit. New commits only.

**Every test must be mutation-checked.** After a test passes, deliberately break the implementation, confirm the test fails, then restore. Four tests on this project shipped unable to fail. A test you have not watched fail is not evidence.

**One deliberate deferral from the spec.** The spec's adapter table said `.xlsx`
and `.csv` would additionally surface *unrecognised sheets as text*. This plan
does not build that: workbooks keep their existing path untouched, and a
workbook is never treated as a document. Excel import already works, so this
would add a second meaning for the same file type for no gain the request asked
for. If a workbook full of narrative rather than project rows turns out to
matter, it is a small follow-up — one more branch in `extract.js` — not a
reason to widen this build.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `server/documents/extract.js` | Dispatch by extension; own the `ExtractedDocument` contract; parse nothing itself |
| `server/documents/adapters/text.js` | `.txt`, `.md` |
| `server/documents/adapters/docx.js` | `.docx` via `jszip` |
| `server/documents/adapters/pdf.js` | `.pdf` via lazily-imported `pdfjs-dist` |
| `server/documents/facts.js` | Dates, currency, `PRJ-` references |
| `server/documents/summarise.js` | Extractive sentence scoring |
| `server/documents/memoryDocuments.js` | In-process store, so `STORE=memory` and the hermetic tests exercise the whole flow |
| `server/repos/documentExtracts.js` | `dbo.DocumentExtract` reads/writes/delete |
| `server/db/migrations.js` | Add migration 12 |
| `server/uploadGuard.js` | Rename and extend the magic-byte guard |
| `server/sections.js` | `buildDocumentsSection`, sixth `SECTION_TITLES` entry |
| `server/summarize.js` | `loadDocuments`, accept `documents` option |
| `server/app.js` | Document branch in upload; purge endpoint; wire `summarize` |
| `server/index.js` | Add `documents` to `backends` in both store branches |
| `client/src/components/DocumentsSection.jsx` | Render the section |
| `client/src/components/UploadPanel.jsx` | Widen `ACCEPT` |
| `server/exporters/{excel,html,pptx,word}.js` | Render the new section |
| `test/documents/*.test.js` | Adapter, facts, summarise, guard, section tests |
| `test/fixtures/documents/` | Committed fixture files |
| `scripts/make-document-fixtures.mjs` | Generates the fixtures once; committed for reproducibility |

---

## Task 1: Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Declare both dependencies**

`jszip` is currently only a transitive dependency of `docx` and `exceljs`. Importing an undeclared hoisted package works today and breaks silently the day either parent drops it. Add both to `dependencies` in `package.json`, keeping the existing alphabetical order:

```json
    "jszip": "^3.10.1",
    "pdfjs-dist": "^4.10.38",
```

- [ ] **Step 2: Install without the optional canvas binary**

Run: `npm install --omit=optional`

Expected: completes; `node_modules/pdfjs-dist` present, `node_modules/@napi-rs` absent.

`@napi-rs/canvas` is 37 MB and is only needed for rendering. Text extraction does not need it. Note `pdfjs-dist@6` *breaks* without it (`ReferenceError: DOMMatrix is not defined` at module load); v4 degrades correctly, which is why the version is pinned to `^4.10`. Forgetting `--omit=optional` costs disk only, never function.

- [ ] **Step 3: Verify the pin holds**

Run: `node -e "console.log(require('pdfjs-dist/package.json').version)"`

Expected: a `4.x` version. If it prints `6.x`, the pin was not applied — fix before continuing.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add jszip and pdfjs-dist for document import"
```

---

## Task 2: The extraction contract and the text adapter

**Files:**
- Create: `server/documents/extract.js`
- Create: `server/documents/adapters/text.js`
- Test: `test/documents/text.test.js`

Every adapter returns this shape. Nothing downstream knows which format produced it:

```js
{
  kind: "pdf" | "docx" | "text",
  title: string,
  blocks: [{ type: "heading"|"paragraph", text: string, page: number|null, level: number|null }],
  pageCount: number|null,
  wordCount: number,
  warnings: string[],
}
```

`page` is `null` for every format without pages. Renderers must handle that rather than printing "page null".

- [ ] **Step 1: Write the failing test**

Create `test/documents/text.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { extractText } from "../../server/documents/adapters/text.js";

test("a markdown heading becomes a heading block and the title", () => {
  const buf = Buffer.from("# Digital Identity\r\n\r\nBudget is SAR 4,250,000.\r\n", "utf8");
  const doc = extractText(buf, "status.md");

  assert.equal(doc.kind, "text");
  assert.equal(doc.title, "Digital Identity");
  assert.equal(doc.pageCount, null, "text has no pages, and 0 would be a lie");
  assert.deepEqual(
    doc.blocks.map((b) => [b.type, b.text]),
    [["heading", "Digital Identity"], ["paragraph", "Budget is SAR 4,250,000."]]
  );
  assert.equal(doc.blocks[0].page, null);
  assert.equal(doc.wordCount, 6);
  assert.deepEqual(doc.warnings, []);
});

test("a plain text file with no heading falls back to the filename", () => {
  const doc = extractText(Buffer.from("Just one line.", "utf8"), "notes for july.txt");
  assert.equal(doc.title, "notes for july");
  assert.deepEqual(doc.blocks.map((b) => b.type), ["paragraph"]);
});

test("an empty file yields no blocks and says so rather than inventing a title", () => {
  const doc = extractText(Buffer.from("   \r\n  \r\n", "utf8"), "empty.txt");
  assert.deepEqual(doc.blocks, []);
  assert.equal(doc.wordCount, 0);
  assert.deepEqual(doc.warnings, ["the file contains no readable text"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/text.test.js`
Expected: FAIL — `Cannot find module '.../server/documents/adapters/text.js'`

- [ ] **Step 3: Implement the adapter**

Create `server/documents/adapters/text.js`:

```js
/**
 * Plain text and Markdown. No dependency: the format is the text.
 *
 * Markdown headings are recognised because they are unambiguous (`#` at the
 * start of a line). Nothing else about Markdown is interpreted -- emphasis,
 * links and lists stay as they were written, because rewriting them would
 * change the author's words, and this pipeline quotes rather than rewrites.
 */
import path from "node:path";

const countWords = (text) => (text.match(/\S+/g) || []).length;

/**
 * @param {Buffer} buffer
 * @param {string} filename used for the fallback title
 * @returns {object} ExtractedDocument
 */
export function extractText(buffer, filename) {
  const raw = buffer.toString("utf8").replace(/\r\n/g, "\n");
  const blocks = [];

  for (const chunk of raw.split(/\n\s*\n/)) {
    const text = chunk.trim();
    if (!text) continue;
    const heading = text.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", text: heading[2].trim(), page: null, level: heading[1].length });
    } else {
      blocks.push({ type: "paragraph", text: text.replace(/\n/g, " "), page: null, level: null });
    }
  }

  const firstHeading = blocks.find((b) => b.type === "heading");
  return {
    kind: "text",
    title: firstHeading ? firstHeading.text : path.basename(filename, path.extname(filename)),
    blocks,
    pageCount: null,
    wordCount: blocks.reduce((n, b) => n + countWords(b.text), 0),
    warnings: blocks.length ? [] : ["the file contains no readable text"],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/documents/text.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-check**

Change `pageCount: null` to `pageCount: 0` and rerun. Expected: the first test FAILS. Restore. Then change the empty-file `warnings` to `[]` and rerun. Expected: the third test FAILS. Restore.

If either mutation does not produce a failure, the test is not testing what it claims — fix the test before continuing.

- [ ] **Step 6: Commit**

```bash
git add server/documents/adapters/text.js test/documents/text.test.js
git commit -m "feat(documents): extract text and markdown"
```

---

## Task 3: The Word adapter

**Files:**
- Create: `server/documents/adapters/docx.js`
- Test: `test/documents/docx.test.js`

A `.docx` is a ZIP holding `word/document.xml`. Paragraphs are `<w:p>`, text runs inside them are `<w:t>`. Headings carry `<w:pStyle w:val="Heading1"/>`. Note `docx@9` in this project is a **writer** and cannot read; do not try to use it here.

- [ ] **Step 1: Write the failing test**

Create `test/documents/docx.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { extractDocx } from "../../server/documents/adapters/docx.js";

const docxWith = async (bodyXml) => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${bodyXml}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
};

test("headings and paragraphs are read in order, split runs joined", async () => {
  const buf = await docxWith(
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Risks</w:t></w:r></w:p>` +
    `<w:p><w:r><w:t>The vendor </w:t></w:r><w:r><w:t>slipped.</w:t></w:r></w:p>`
  );
  const doc = await extractDocx(buf, "report.docx");

  assert.equal(doc.kind, "docx");
  assert.equal(doc.title, "Risks");
  assert.equal(doc.pageCount, null, "a docx has no pages before it is rendered");
  assert.deepEqual(
    doc.blocks.map((b) => [b.type, b.text]),
    [["heading", "Risks"], ["paragraph", "The vendor slipped."]]
  );
});

test("a zip without word/document.xml is an error, not an empty document", async () => {
  const zip = new JSZip();
  zip.file("word/other.xml", "<x/>");
  const buf = await zip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    () => extractDocx(buf, "broken.docx"),
    /word\/document\.xml/,
    "a missing body must name what is missing, not silently return nothing"
  );
});

test("bytes that are not a zip at all are an error", async () => {
  await assert.rejects(() => extractDocx(Buffer.from("not a zip"), "fake.docx"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/docx.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

Create `server/documents/adapters/docx.js`:

```js
/**
 * Word, by reading the OOXML directly.
 *
 * A .docx is a ZIP whose document body is word/document.xml. Paragraphs are
 * <w:p>, the text inside them is split across any number of <w:t> runs (Word
 * splits on spell-check state, formatting, revision marks), so a paragraph's
 * text is every <w:t> in it concatenated -- not the first one.
 *
 * shared/pptx-lite.mjs already hand-builds OOXML in this project, so reading
 * it by hand here is consistent rather than novel. `docx` in package.json is a
 * writer and cannot read.
 */
import path from "node:path";
import JSZip from "jszip";

const countWords = (text) => (text.match(/\S+/g) || []).length;

/* Minimal XML entity set: these five are the only ones OOXML emits. */
const unescapeXml = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, "&");

/**
 * @param {Buffer} buffer
 * @param {string} filename used for the fallback title
 * @returns {Promise<object>} ExtractedDocument
 */
export async function extractDocx(buffer, filename) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new Error(`not a readable .docx: ${err.message}`);
  }

  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("not a readable .docx: it contains no word/document.xml");
  const xml = await entry.async("string");

  const blocks = [];
  for (const match of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
    const paragraph = match[0];
    const text = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => unescapeXml(m[1]))
      .join("")
      .trim();
    if (!text) continue;

    const style = paragraph.match(/<w:pStyle\s+w:val="Heading(\d)"/);
    blocks.push(style
      ? { type: "heading", text, page: null, level: Number(style[1]) }
      : { type: "paragraph", text, page: null, level: null });
  }

  const firstHeading = blocks.find((b) => b.type === "heading");
  return {
    kind: "docx",
    title: firstHeading ? firstHeading.text : path.basename(filename, path.extname(filename)),
    blocks,
    pageCount: null,
    wordCount: blocks.reduce((n, b) => n + countWords(b.text), 0),
    warnings: blocks.length ? [] : ["the file contains no readable text"],
  };
}
```

Two details in that code are load-bearing and easy to "tidy" into bugs:
`matchAll` returns an iterator of match arrays, so the loop must take `match[0]`
rather than destructuring; and a paragraph's text is **every** `<w:t>` in it
joined, not the first — Word splits runs on formatting, spell-check state and
revision marks, so `"The vendor slipped."` is routinely three runs.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/documents/docx.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-check**

Change the run-joining `.join("")` to `[0]` (take only the first run) and rerun. Expected: the first test FAILS on `"The vendor slipped."`. Restore.

- [ ] **Step 6: Commit**

```bash
git add server/documents/adapters/docx.js test/documents/docx.test.js
git commit -m "feat(documents): extract Word by reading OOXML directly"
```

---

## Task 4: Fixtures

**Files:**
- Create: `scripts/make-document-fixtures.mjs`
- Create: `test/fixtures/documents/` (generated, committed)

Fixtures are generated once and committed so the suite is hermetic and does not need a browser.

- [ ] **Step 1: Write the generator**

Create `scripts/make-document-fixtures.mjs`:

```js
/**
 * Generates the committed document fixtures. Run once; commit the output.
 *
 * PDFs are printed by headless Chrome because that is what real PDFs look
 * like -- subset fonts and compressed content streams -- which is exactly the
 * case a hand-rolled extractor fails on and pdfjs handles.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/documents");
const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const REPORT = `<html><body style="font-family:Georgia,serif">
<h1>Digital Identity Programme &mdash; Status Report</h1>
<p>Reporting period: 1 July 2026 to 31 July 2026. Owner: Directorate of Digital Services.</p>
<h2>Risks</h2>
<p>The vendor integration milestone for PRJ-1001 slipped by three weeks. Budget consumed
to date is SAR 4,250,000 of an approved SAR 6,000,000.</p>
<h2>Decisions required</h2>
<p>Approve the revised go-live date of 15 November 2026.</p>
<table border="1"><tr><th>Milestone</th><th>Due</th><th>Status</th></tr>
<tr><td>Pilot onboarding</td><td>2026-09-30</td><td>Amber</td></tr></table>
</body></html>`;

/* A 1x1 red PNG, scaled to fill the page: a PDF with pixels and no text layer. */
const SCAN = `<html><body style="margin:0">
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
     style="width:100%;height:400px">
</body></html>`;

const exe = CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.error("No Chrome or Edge found. Install one, or edit CANDIDATES.");
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
for (const [name, html] of [["status-report.pdf", REPORT], ["scanned.pdf", SCAN]]) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: path.join(OUT, name), format: "A4", printBackground: true });
  await page.close();
  console.log(`wrote ${name}`);
}
await browser.close();

/* Not a PDF at all, but named like one: the corrupt-input case. */
fs.writeFileSync(path.join(OUT, "corrupt.pdf"), Buffer.from("%PDF-1.7\nthis is not a pdf body\n"));
console.log("wrote corrupt.pdf");

fs.writeFileSync(path.join(OUT, "status-report.md"),
  "# Digital Identity Programme\n\nThe milestone for PRJ-1001 slipped. " +
  "Budget consumed is SAR 4,250,000 by 2026-09-30.\n");
console.log("wrote status-report.md");
```

- [ ] **Step 2: Generate and inspect**

Run: `node scripts/make-document-fixtures.mjs`
Expected: writes `status-report.pdf`, `scanned.pdf`, `corrupt.pdf`, `status-report.md` into `test/fixtures/documents/`.

Confirm `status-report.pdf` is roughly 40 KB and `scanned.pdf` is smaller. If the script reports no browser, install Chrome or Edge — do not fabricate the fixtures by hand.

- [ ] **Step 3: Ensure fixtures are not gitignored**

Run: `git check-ignore -v test/fixtures/documents/status-report.pdf`
Expected: **no output** (exit 1), meaning the file is not ignored.

If it prints a rule, fix `.gitignore`. This project has already shipped a bug where an unanchored `audit/` rule hid a whole test directory from git, so every "the suite passes" claim was local-only. Check, do not assume.

- [ ] **Step 4: Commit**

```bash
git add scripts/make-document-fixtures.mjs test/fixtures/documents
git commit -m "test(documents): committed fixtures and their generator"
```

---

## Task 5: The PDF adapter

**Files:**
- Create: `server/documents/adapters/pdf.js`
- Test: `test/documents/pdf.test.js`

Three constraints, all established by measurement:

1. **Lazy import.** Loading `pdfjs-dist` costs 69 ms (v4 without canvas). Doing it at boot puts that into process start and re-triggers the class of false slow-parse warning fixed in `4013ff6`.
2. **Warnings go to stdout.** `Cannot polyfill DOMMatrix` and friends print via `console.warn` at module load and must be suppressed, or they pollute the service log.
3. **Teardown is `loadingTask.destroy()`**, not `doc.destroy()` — the latter does not exist. An undestroyed task keeps a worker alive and stops Node exiting.

- [ ] **Step 1: Write the failing test**

Create `test/documents/pdf.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractPdf } from "../../server/documents/adapters/pdf.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/documents");
const read = (name) => fs.readFileSync(path.join(FIX, name));

test("a real PDF yields its text with page numbers", async () => {
  const doc = await extractPdf(read("status-report.pdf"), "status-report.pdf");

  assert.equal(doc.kind, "pdf");
  assert.equal(doc.pageCount, 1);
  assert.match(doc.title, /Digital Identity Programme/);

  const all = doc.blocks.map((b) => b.text).join(" ");
  assert.match(all, /slipped by three weeks/);
  assert.match(all, /SAR 4,250,000/);
  assert.equal(doc.blocks[0].page, 1, "every PDF block carries the page it came from");
  assert.deepEqual(doc.warnings, []);
});

test("a scanned PDF warns rather than silently returning nothing", async () => {
  const doc = await extractPdf(read("scanned.pdf"), "scanned.pdf");

  assert.deepEqual(doc.blocks, []);
  assert.deepEqual(doc.warnings, ["no text layer — this looks like a scan"]);
});

test("a corrupt PDF is an error, not an empty document", async () => {
  await assert.rejects(() => extractPdf(read("corrupt.pdf"), "corrupt.pdf"));
});

/* Must be the LAST test in this file: the tests above already extract a PDF,
   and once any of them has run pdfjs is loaded process-wide. node:test runs a
   file's tests in declaration order, so this sits at the bottom and uses a
   fresh module registry check rather than relying on ordering alone. */
test("pdfjs is not loaded until a PDF is actually extracted", async () => {
  /* A child process, because the lazy import is process-wide state: any
     earlier test in this file would have already triggered it. */
  const { execFileSync } = await import("node:child_process");
  const script = `
    const { pdfjsLoaded, extractPdf } = await import("./server/documents/adapters/pdf.js");
    if (pdfjsLoaded()) { console.log("LOADED_TOO_EARLY"); process.exit(0); }
    const fs = await import("node:fs");
    await extractPdf(fs.readFileSync(${JSON.stringify(path.join(FIX, "status-report.pdf"))}), "x.pdf");
    console.log(pdfjsLoaded() ? "LAZY_OK" : "NEVER_LOADED");
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    encoding: "utf8",
  }).trim();

  assert.equal(out, "LAZY_OK",
    "importing the adapter must not pull in pdfjs; extracting must");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/pdf.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter**

Create `server/documents/adapters/pdf.js`:

```js
/**
 * PDF, via pdfjs-dist -- the reference implementation.
 *
 * Pinned to v4 and installed with --omit=optional. v6 hard-requires the
 * @napi-rs/canvas optional dependency even for text-only extraction and dies
 * at module load with "DOMMatrix is not defined"; v4 degrades correctly, which
 * takes the install from 71 MB to 37 MB and module load from 655 ms to 69 ms.
 *
 * The import is lazy on purpose. Paying even 69 ms at boot is the same shape
 * of problem as the false cold-start slow-parse warning fixed in 4013ff6.
 *
 * Known and accepted: table structure does not survive. A table comes back as
 * "Milestone Due Status" then "Pilot onboarding 2026-09-30 Amber". PDF has no
 * table semantics to recover, so this pipeline does not promise any. Structured
 * tables come from .xlsx, which keeps its own path.
 */
import path from "node:path";

const countWords = (text) => (text.match(/\S+/g) || []).length;

let pdfjs = null;

/** Test seam: has the lazy import happened yet? */
export function pdfjsLoaded() {
  return pdfjs !== null;
}

async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  /* pdfjs prints "Cannot polyfill DOMMatrix" and friends through console.warn
     at module load. They are expected on a canvas-free install and would
     otherwise land in the service log as if something were wrong. */
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } finally {
    console.warn = realWarn;
  }
  return pdfjs;
}

/**
 * @param {Buffer} buffer
 * @param {string} filename used for the fallback title
 * @returns {Promise<object>} ExtractedDocument
 */
export async function extractPdf(buffer, filename) {
  const lib = await loadPdfjs();

  const task = lib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    /* No eval, and no remote fetches: this runs on documents we did not write. */
    isEvalSupported: false,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    if (err?.name === "PasswordException") {
      throw new Error("this PDF is encrypted and cannot be read without its password");
    }
    throw new Error(`not a readable .pdf: ${err.message}`);
  }

  const blocks = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();

      let line = "";
      const flush = () => {
        const text = line.trim();
        line = "";
        if (text) blocks.push({ type: "paragraph", text, page: n, level: null });
      };
      for (const item of content.items) {
        line += item.str;
        if (item.hasEOL) flush();
      }
      flush();
      page.cleanup();
    }
  } finally {
    /* loadingTask.destroy(), NOT doc.destroy() -- that does not exist, and an
       undestroyed task keeps a worker alive so Node never exits. */
    await task.destroy().catch(() => {});
  }

  const pageCount = doc.numPages;
  return {
    kind: "pdf",
    title: blocks.length ? blocks[0].text : path.basename(filename, path.extname(filename)),
    blocks,
    pageCount,
    wordCount: blocks.reduce((n, b) => n + countWords(b.text), 0),
    warnings: blocks.length ? [] : ["no text layer — this looks like a scan"],
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/documents/pdf.test.js`
Expected: PASS, 4 tests. The run must **exit on its own** — if it hangs, `task.destroy()` is not being reached.

- [ ] **Step 5: Mutation-check**

Replace `await task.destroy()` in the `finally` with nothing and rerun. Expected: the test run hangs rather than exiting, proving the teardown is load-bearing. Restore.

Then change the scan warning to `[]` and rerun. Expected: the scanned-PDF test FAILS. Restore.

- [ ] **Step 6: Commit**

```bash
git add server/documents/adapters/pdf.js test/documents/pdf.test.js
git commit -m "feat(documents): extract PDF text with a lazily loaded pdfjs"
```

---

## Task 6: The dispatcher

**Files:**
- Create: `server/documents/extract.js`
- Test: `test/documents/extract.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/documents/extract.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { extractDocument, DOCUMENT_EXTENSIONS } from "../../server/documents/extract.js";

test("every supported extension is dispatched", async () => {
  assert.deepEqual([...DOCUMENT_EXTENSIONS].sort(), [".docx", ".md", ".pdf", ".txt"]);
});

test("a text file routes to the text adapter", async () => {
  const doc = await extractDocument(Buffer.from("# Title\n\nBody."), "a.md");
  assert.equal(doc.kind, "text");
});

test("an unsupported extension is refused by name", async () => {
  await assert.rejects(
    () => extractDocument(Buffer.from("x"), "picture.png"),
    /\.png/,
    "the refusal must name the extension so the caller can report it"
  );
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/extract.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/documents/extract.js`:

```js
/**
 * One entry point for document extraction.
 *
 * This file dispatches and nothing else -- it must never learn how any format
 * is parsed. That is what keeps a new format to one new adapter file, and what
 * keeps everything downstream free of per-format branching: they all see the
 * same ExtractedDocument shape.
 *
 *   { kind, title, blocks[{type,text,page,level}], pageCount, wordCount, warnings[] }
 *
 * `page` is null for every format that has no pages before rendering. A
 * renderer must handle null rather than printing "page null".
 */
import path from "node:path";
import { extractText } from "./adapters/text.js";
import { extractDocx } from "./adapters/docx.js";
import { extractPdf } from "./adapters/pdf.js";

export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md"]);

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<object>} ExtractedDocument
 */
export async function extractDocument(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".txt":
    case ".md":
      return extractText(buffer, filename);
    case ".docx":
      return extractDocx(buffer, filename);
    case ".pdf":
      return extractPdf(buffer, filename);
    default:
      throw new Error(`${ext || "that"} is not a supported document type (use .pdf .docx .txt .md)`);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/documents/extract.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/documents/extract.js test/documents/extract.test.js
git commit -m "feat(documents): dispatch extraction by extension"
```

---

## Task 7: Facts

**Files:**
- Create: `server/documents/facts.js`
- Test: `test/documents/facts.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/documents/facts.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { extractFacts } from "../../server/documents/facts.js";

const blocks = [
  { type: "paragraph", text: "PRJ-1001 slipped. Go-live moved to 15 November 2026.", page: 1, level: null },
  { type: "paragraph", text: "Spend is SAR 4,250,000 against 2026-09-30.", page: 2, level: null },
];

test("dates are normalised to ISO and keep the phrase they came from", () => {
  const facts = extractFacts(blocks);
  const iso = facts.dates.map((d) => d.iso);
  assert.ok(iso.includes("2026-11-15"), `expected 2026-11-15 in ${iso}`);
  assert.ok(iso.includes("2026-09-30"), `expected 2026-09-30 in ${iso}`);
  assert.match(facts.dates.find((d) => d.iso === "2026-11-15").context, /Go-live moved/);
});

test("currency amounts are captured with their page", () => {
  const facts = extractFacts(blocks);
  assert.deepEqual(facts.money.map((m) => [m.text, m.page]), [["SAR 4,250,000", 2]]);
});

test("project references are reported, never resolved to a project", () => {
  const facts = extractFacts(blocks);
  assert.deepEqual(facts.projectRefs, ["PRJ-1001"]);
  assert.equal(facts.projectRefs[0].projectId, undefined,
    "a reference is a string, not a link -- attaching is out of scope by design");
});

test("a document with no facts yields empty arrays, not nulls", () => {
  const facts = extractFacts([{ type: "paragraph", text: "Nothing here.", page: 1, level: null }]);
  assert.deepEqual(facts, { dates: [], money: [], projectRefs: [] });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/facts.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/documents/facts.js`:

```js
/**
 * The parts of a document that can be read off it without interpretation.
 *
 * Deliberately narrow. Anything that would need judgement -- who owns this,
 * is it going well, which project is it really about -- is not here, because
 * this pipeline has no model that could answer it and a plausible guess is
 * worse than an absence. Project references are reported as the strings they
 * are and never resolved to a project: a wrong attachment puts misleading
 * evidence under a real project.
 */
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const LONG_DATE = /\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/g;
const MONEY = /\b(SAR|USD|EUR|GBP)\s?([\d,]+(?:\.\d{2})?)\b/g;
const PROJECT_REF = /\bPRJ-\d+\b/g;

const pad = (n) => String(n).padStart(2, "0");

/**
 * @param {object[]} blocks ExtractedDocument.blocks
 * @returns {{dates: object[], money: object[], projectRefs: string[]}}
 */
export function extractFacts(blocks) {
  const dates = [];
  const money = [];
  const refs = new Set();

  for (const block of blocks) {
    const { text, page } = block;

    for (const m of text.matchAll(ISO_DATE)) {
      dates.push({ iso: m[0], text: m[0], page, context: text });
    }

    for (const m of text.matchAll(LONG_DATE)) {
      const month = MONTHS[m[2].toLowerCase()];
      if (!month) continue;               // "3 weeks 2026" is not a date
      const iso = `${m[3]}-${pad(month)}-${pad(Number(m[1]))}`;
      dates.push({ iso, text: m[0], page, context: text });
    }

    for (const m of text.matchAll(MONEY)) {
      money.push({ text: `${m[1]} ${m[2]}`, currency: m[1], amount: m[2], page });
    }

    for (const m of text.matchAll(PROJECT_REF)) refs.add(m[0]);
  }

  return { dates, money, projectRefs: [...refs] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/documents/facts.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-check**

Delete the `if (!month) continue;` guard and rerun. Expected: still passes — which means that guard is **unproven**. Add this test, watch it fail with the guard removed, then restore the guard:

```js
test("a number-word-year run that is not a date is not treated as one", () => {
  const facts = extractFacts([{ type: "paragraph", text: "Slipped 3 weeks 2026.", page: 1, level: null }]);
  assert.deepEqual(facts.dates, []);
});
```

- [ ] **Step 6: Commit**

```bash
git add server/documents/facts.js test/documents/facts.test.js
git commit -m "feat(documents): extract dates, money and project references"
```

---

## Task 8: Extractive summary

**Files:**
- Create: `server/documents/summarise.js`
- Test: `test/documents/summarise.test.js`

Nothing is written. Sentences are selected from the document and quoted verbatim with their provenance.

- [ ] **Step 1: Write the failing test**

Create `test/documents/summarise.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { summariseDocument } from "../../server/documents/summarise.js";

const blocks = [
  { type: "heading", text: "Status", page: 1, level: 1 },
  { type: "paragraph", text: "This document was prepared by the team.", page: 1, level: null },
  { type: "paragraph", text: "The integration milestone is amber and slipped to 2026-11-15.", page: 1, level: null },
  { type: "paragraph", text: "Spend reached SAR 4,250,000 against an approved budget.", page: 2, level: null },
];

test("selected sentences are verbatim from the document", () => {
  const picked = summariseDocument(blocks, { max: 2 });
  for (const s of picked) {
    const source = blocks.map((b) => b.text).join(" ");
    assert.ok(source.includes(s.text), `"${s.text}" is not verbatim from the document`);
  }
});

test("sentences carrying risk vocabulary and figures outrank filler", () => {
  const picked = summariseDocument(blocks, { max: 2 });
  const text = picked.map((s) => s.text).join(" ");
  assert.match(text, /amber and slipped/);
  assert.doesNotMatch(text, /prepared by the team/,
    "filler must lose to a sentence carrying status vocabulary and a date");
});

test("each selection carries where it came from", () => {
  const picked = summariseDocument(blocks, { max: 2 });
  assert.ok(picked.every((s) => s.page !== undefined && s.heading !== undefined));
  const spend = picked.find((s) => s.text.includes("SAR"));
  if (spend) assert.equal(spend.page, 2);
});

test("results keep document order, not score order", () => {
  const picked = summariseDocument(blocks, { max: 3 });
  const pages = picked.map((s) => s.page);
  assert.deepEqual(pages, [...pages].sort((a, b) => a - b));
});

test("a document with no prose yields nothing rather than padding", () => {
  assert.deepEqual(summariseDocument([], { max: 3 }), []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/summarise.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/documents/summarise.js`:

```js
/**
 * Extractive summary: selection, not authorship.
 *
 * There is no language model here and none is wanted -- document content must
 * not leave this network. So nothing is written. Sentences already in the
 * document are scored, the best are kept verbatim, and each carries the page
 * or heading it came from so a reader can go and check it.
 *
 * The vocabulary below is deliberately the same vocabulary the workbook
 * ingest already recognises (health, project status, milestone status). Adding
 * a second, divergent list of "important words" would drift from the terms the
 * rest of the dashboard reasons about.
 *
 * Honest limitation: on a document with no prose structure this surfaces and
 * orders rather than condenses. The UI says "Extracted from the document", not
 * "Summary", so nobody is told a machine understood it.
 */
const SIGNAL = new Set([
  "red", "amber", "green",                              // health
  "risk", "risks", "issue", "issues", "blocked", "blocker",
  "slipped", "slippage", "delayed", "overdue", "late",
  "milestone", "decision", "decisions", "approve", "approval",
  "budget", "spend", "overspend", "forecast",
  "completed", "cancelled", "on-hold", "critical",
  "non-compliant", "partial", "compliant",
]);

const HAS_FIGURE = /\b\d{4}-\d{2}-\d{2}\b|\b(SAR|USD|EUR|GBP)\s?[\d,]+|\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b/;

/* Split on sentence enders followed by whitespace. Deliberately simple: an
   abbreviation may split a sentence early, which costs a slightly clipped
   quote and never a wrong one. */
const sentencesOf = (text) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

function score(sentence, indexInBlock) {
  let n = 0;
  const words = sentence.toLowerCase().match(/[a-z-]+/g) || [];
  for (const w of words) if (SIGNAL.has(w)) n += 2;
  if (HAS_FIGURE.test(sentence)) n += 2;
  if (indexInBlock === 0) n += 1;
  const count = words.length;
  if (count < 4 || count > 60) n -= 2;
  return n;
}

/**
 * @param {object[]} blocks ExtractedDocument.blocks
 * @param {{max?: number}} [options]
 * @returns {{text: string, page: number|null, heading: string|null, score: number}[]}
 */
export function summariseDocument(blocks, { max = 6 } = {}) {
  const candidates = [];
  let heading = null;
  let order = 0;

  for (const block of blocks) {
    if (block.type === "heading") { heading = block.text; continue; }
    const sentences = sentencesOf(block.text);
    for (let i = 0; i < sentences.length; i++) {
      candidates.push({
        text: sentences[i],
        page: block.page,
        heading,
        score: score(sentences[i], i),
        order: order++,
      });
    }
  }

  return candidates
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    /* Back into document order: a briefing reads as a document, not a chart. */
    .sort((a, b) => a.order - b.order)
    .map(({ text, page, heading: h, score: s }) => ({ text, page, heading: h, score: s }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/documents/summarise.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Mutation-check**

Remove the final `.sort((a, b) => a.order - b.order)` and rerun. Expected: the document-order test FAILS. Restore.

Then empty the `SIGNAL` set and rerun. Expected: the ranking test FAILS. Restore.

- [ ] **Step 6: Commit**

```bash
git add server/documents/summarise.js test/documents/summarise.test.js
git commit -m "feat(documents): select key sentences without writing any"
```

---

## Task 9: Extend the upload guard

**Files:**
- Modify: `server/uploadGuard.js`
- Modify: `server/app.js:25` (import), `server/app.js:316` (call)
- Test: `test/documents/uploadGuard.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/documents/uploadGuard.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeSupportedFile } from "../../server/uploadGuard.js";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);

test("a real PDF is accepted", () => {
  assert.deepEqual(looksLikeSupportedFile(PDF, "report.pdf"), { ok: true });
});

test("a renamed executable claiming to be a PDF is refused", () => {
  const exe = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);
  const verdict = looksLikeSupportedFile(exe, "report.pdf");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not a real \.pdf/);
});

test("a docx must be a zip", () => {
  assert.equal(looksLikeSupportedFile(ZIP, "a.docx").ok, true);
  assert.equal(looksLikeSupportedFile(Buffer.from("plain text here"), "a.docx").ok, false);
});

test("binary content in a .txt is refused", () => {
  const withNul = Buffer.concat([Buffer.from("hello"), Buffer.from([0x00]), Buffer.alloc(16)]);
  assert.equal(looksLikeSupportedFile(withNul, "notes.txt").ok, false);
});

test("workbooks still pass exactly as before", () => {
  assert.equal(looksLikeSupportedFile(ZIP, "book.xlsx").ok, true);
  assert.equal(looksLikeSupportedFile(Buffer.from("a,b,c\n1,2,3"), "book.csv").ok, true);
});

test("an unsupported type names itself in the refusal", () => {
  const verdict = looksLikeSupportedFile(Buffer.alloc(64), "photo.png");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /\.png/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/uploadGuard.test.js`
Expected: FAIL — `looksLikeSupportedFile` is not exported.

- [ ] **Step 3: Rename and extend the guard**

In `server/uploadGuard.js`, update the header comment's first line to read
`An upload must be what its extension claims.` (unchanged), add the PDF
signature beside the existing ones:

```js
const PDF = [0x25, 0x50, 0x44, 0x46];       // "%PDF"
```

Rename `looksLikeWorkbook` to `looksLikeSupportedFile` and replace the
extension gate and add the two new branches. The function becomes:

```js
export function looksLikeSupportedFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  const supported = [".xlsx", ".xlsm", ".xls", ".csv", ".pdf", ".docx", ".txt", ".md"];

  if (!supported.includes(ext)) {
    return { ok: false, reason: `${ext || "that"} is not a supported file type (use ${supported.join(" ")})` };
  }
  if (!buffer || buffer.length < 8) {
    return { ok: false, reason: "the file is empty or truncated" };
  }
  if (ext === ".xlsx" || ext === ".xlsm" || ext === ".docx") {
    const ok = startsWith(buffer, ZIP) || startsWith(buffer, ZIP_EMPTY);
    return ok ? { ok: true } : { ok: false, reason: `not a real ${ext} — the contents are not a ${ext === ".docx" ? "document" : "workbook"}` };
  }
  if (ext === ".xls") {
    const ok = startsWith(buffer, OLE2);
    return ok ? { ok: true } : { ok: false, reason: "not a real .xls — the contents are not a workbook" };
  }
  if (ext === ".pdf") {
    const ok = startsWith(buffer, PDF);
    return ok ? { ok: true } : { ok: false, reason: "not a real .pdf — the contents are not a PDF" };
  }
  /* CSV, TXT and MD are text by definition; a NUL in the first block means not. */
  if (buffer.subarray(0, 512).includes(0x00)) {
    return { ok: false, reason: `not a real ${ext} — the contents are binary` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Update the one call site**

In `server/app.js` line 25, change the import to `import { looksLikeSupportedFile } from "./uploadGuard.js";`
In `server/app.js` line 316, change `looksLikeWorkbook(f.buffer, safe)` to `looksLikeSupportedFile(f.buffer, safe)`.

Run: `grep -rn "looksLikeWorkbook" server client test`
Expected: **no matches**. If any remain, fix them.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/documents/uploadGuard.test.js`
Expected: PASS, 6 tests.

Run: `npm test`
Expected: no new failures — the existing upload tests must still pass.

- [ ] **Step 6: Mutation-check**

Remove the `.pdf` branch and rerun. Expected: the renamed-executable test FAILS (it would fall through to the text check and pass). Restore.

- [ ] **Step 7: Commit**

```bash
git add server/uploadGuard.js server/app.js test/documents/uploadGuard.test.js
git commit -m "feat(documents): let the upload guard vouch for documents too"
```

---

## Task 10: Migration 12 and the two document stores

**Files:**
- Modify: `server/db/migrations.js`
- Create: `server/repos/documentExtracts.js`
- Create: `server/documents/memoryDocuments.js`
- Test: `test/documents/memoryDocuments.test.js`

Two implementations of one interface, matching how `audit` and `sessions`
already have SQL and memory forms in `server/index.js`. Without the memory one,
`STORE=memory` — which is what the hermetic suite runs — could not exercise the
feature at all.

Interface, used by both:

```js
{
  list(): Promise<StoredDocument[]>,
  add(doc): Promise<StoredDocument>,
  remove(sourceFileId): Promise<boolean>,
}
```

where `StoredDocument` is
`{ sourceFileId, fileName, kind, title, pageCount, wordCount, extract, extractedAt }`
and `extract` is `{ blocks, facts, summary, warnings }`.

- [ ] **Step 1: Add migration 12**

In `server/db/migrations.js`, append to the `MIGRATIONS` array after the `id: 11` entry:

```js
  {
    id: 12,
    name: "document_extract",
    sql: `
      /* Imported documents. Deliberately hangs off dbo.SourceFile rather than
         duplicating it: SourceFile never assumed a workbook -- FileName,
         Sha256, Bytes, VaultPath -- so documents reuse it, and with it the
         MERGE in sourceFiles.record that already makes re-import idempotent.

         PageCount is NULL-able because .docx and .txt have no pages before
         they are rendered, and a 0 there would be a lie rather than a gap.

         ExtractJson holds the whole extract as one document instead of being
         normalised into block and fact tables. Nothing queries across
         documents by block or fact -- an extract is always read whole to
         render one section -- so normalising would buy nothing and cost a
         migration every time the extract shape changed. If cross-document
         querying is ever wanted, that is the moment to normalise, not now. */
      IF OBJECT_ID('dbo.DocumentExtract', 'U') IS NULL
      CREATE TABLE dbo.DocumentExtract (
        DocumentExtractId BIGINT IDENTITY(1,1) PRIMARY KEY,
        SourceFileId      BIGINT         NOT NULL
          REFERENCES dbo.SourceFile (SourceFileId),
        Kind              VARCHAR(8)     NOT NULL,
        Title             NVARCHAR(400)  NOT NULL,
        PageCount         INT            NULL,
        WordCount         INT            NOT NULL,
        ExtractJson       NVARCHAR(MAX)  NOT NULL,
        ExtractedAt       DATETIME2(3)   NOT NULL
      );

      /* Idempotent re-import enforced by the database, not by the caller
         remembering to check first -- the same reason UX_SourceFile_Name_Sha
         exists. */
      IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_DocumentExtract_SourceFile')
        CREATE UNIQUE INDEX UX_DocumentExtract_SourceFile
          ON dbo.DocumentExtract (SourceFileId);
    `,
  },
```

- [ ] **Step 2: Write the failing test for the memory store**

Create `test/documents/memoryDocuments.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDocuments } from "../../server/documents/memoryDocuments.js";

const sample = (id) => ({
  sourceFileId: id,
  fileName: `doc-${id}.pdf`,
  kind: "pdf",
  title: `Doc ${id}`,
  pageCount: 1,
  wordCount: 10,
  extract: { blocks: [], facts: { dates: [], money: [], projectRefs: [] }, summary: [], warnings: [] },
});

test("a document can be added and listed back", async () => {
  const docs = memoryDocuments();
  await docs.add(sample(1));
  const all = await docs.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, "Doc 1");
  assert.ok(all[0].extractedAt, "the store stamps when it was extracted");
});

test("adding the same source file twice keeps one row", async () => {
  const docs = memoryDocuments();
  const first = await docs.add(sample(1));
  await docs.add({ ...sample(1), title: "Renamed" });
  const all = await docs.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].extractedAt, first.extractedAt,
    "a re-import must not restamp -- it is the same document");
});

test("removing reports whether anything was removed", async () => {
  const docs = memoryDocuments();
  await docs.add(sample(1));
  assert.equal(await docs.remove(1), true);
  assert.equal(await docs.remove(1), false);
  assert.deepEqual(await docs.list(), []);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/documents/memoryDocuments.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the memory store**

Create `server/documents/memoryDocuments.js`:

```js
/**
 * Documents without a database.
 *
 * STORE=memory has no repos, and the hermetic suite runs on it. Without this,
 * the whole document path could only be exercised against SQL, which the test
 * suite deliberately does not touch. Same interface as documentExtracts.js so
 * nothing above either of them knows which one it has.
 */
export function memoryDocuments() {
  const bySourceFileId = new Map();

  return {
    async list() {
      return [...bySourceFileId.values()];
    },

    async add(doc) {
      /* First write wins: re-importing identical bytes is the same document,
         and restamping it would make an unchanged file look freshly imported. */
      const existing = bySourceFileId.get(doc.sourceFileId);
      if (existing) return existing;

      const stored = { ...doc, extractedAt: new Date().toISOString() };
      bySourceFileId.set(doc.sourceFileId, stored);
      return stored;
    },

    async remove(sourceFileId) {
      return bySourceFileId.delete(sourceFileId);
    },
  };
}

/**
 * The vault ledger without a database, matching sourceFilesRepo.record.
 *
 * Idempotent on (fileName, sha256) exactly as UX_SourceFile_Name_Sha makes the
 * SQL one -- re-importing identical bytes must return the same id, or the
 * document store would be handed a new key each time and keep duplicating a
 * file that has not changed.
 */
export function memorySourceFiles() {
  const idsByKey = new Map();
  let nextId = 1;

  return {
    async record({ fileName, sha256 }) {
      const key = `${fileName} ${sha256}`;
      const existing = idsByKey.get(key);
      if (existing) return { sourceFileId: existing, alreadySeen: true };

      const sourceFileId = nextId++;
      idsByKey.set(key, sourceFileId);
      return { sourceFileId, alreadySeen: false };
    },
  };
}
```

Add a test for the idempotency, since the whole re-import guarantee rests on it:

```js
test("recording identical bytes twice returns the same id", async () => {
  const files = memorySourceFiles();
  const a = await files.record({ fileName: "x.pdf", sha256: "a".repeat(64) });
  const b = await files.record({ fileName: "x.pdf", sha256: "a".repeat(64) });
  assert.equal(b.sourceFileId, a.sourceFileId);
  assert.equal(b.alreadySeen, true);

  const c = await files.record({ fileName: "x.pdf", sha256: "b".repeat(64) });
  assert.notEqual(c.sourceFileId, a.sourceFileId, "different bytes are a different file");
});
```

Import `memorySourceFiles` alongside `memoryDocuments` at the top of
`test/documents/memoryDocuments.test.js`.

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/documents/memoryDocuments.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Implement the SQL repo**

Create `server/repos/documentExtracts.js`:

```js
/**
 * dbo.DocumentExtract -- what was read out of each imported document.
 *
 * The extract is stored as one JSON document rather than normalised. See the
 * comment on migration 12 for why: nothing queries across documents by block
 * or fact, so normalising would cost a migration per shape change and buy
 * nothing.
 */
import { sql } from "../db/executor.js";

const toStored = (row) => ({
  sourceFileId: Number(row.SourceFileId),
  fileName: row.FileName,
  kind: row.Kind,
  title: row.Title,
  pageCount: row.PageCount === null ? null : Number(row.PageCount),
  wordCount: Number(row.WordCount),
  extract: JSON.parse(row.ExtractJson),
  extractedAt: new Date(row.ExtractedAt).toISOString(),
});

export function documentExtractsRepo(ex) {
  return {
    async list() {
      const { recordset } = await ex.query(`
        SELECT d.SourceFileId, s.FileName, d.Kind, d.Title,
               d.PageCount, d.WordCount, d.ExtractJson, d.ExtractedAt
          FROM dbo.DocumentExtract d
          JOIN dbo.SourceFile s ON s.SourceFileId = d.SourceFileId
         ORDER BY d.ExtractedAt DESC, d.DocumentExtractId DESC;
      `, []);
      return recordset.map(toStored);
    },

    /**
     * Insert unless this source file already has an extract.
     * @returns {Promise<object>} the stored row, new or pre-existing
     */
    async add(doc) {
      /* WHERE NOT EXISTS rather than MERGE: there is exactly one conflict to
         handle and it always resolves the same way -- keep what is there. A
         re-import of identical bytes must not restamp ExtractedAt, or an
         unchanged document looks freshly imported every time it is uploaded. */
      await ex.query(`
        INSERT INTO dbo.DocumentExtract
          (SourceFileId, Kind, Title, PageCount, WordCount, ExtractJson, ExtractedAt)
        SELECT @id, @kind, @title, @pages, @words, @json, SYSUTCDATETIME()
         WHERE NOT EXISTS (
           SELECT 1 FROM dbo.DocumentExtract WITH (HOLDLOCK)
            WHERE SourceFileId = @id
         );
      `, [
        { name: "id", type: sql.BigInt, value: doc.sourceFileId },
        { name: "kind", type: sql.VarChar(8), value: doc.kind },
        { name: "title", type: sql.NVarChar(400), value: doc.title },
        { name: "pages", type: sql.Int, value: doc.pageCount },
        { name: "words", type: sql.Int, value: doc.wordCount },
        { name: "json", type: sql.NVarChar(sql.MAX), value: JSON.stringify(doc.extract) },
      ]);

      const { recordset } = await ex.query(`
        SELECT d.SourceFileId, s.FileName, d.Kind, d.Title,
               d.PageCount, d.WordCount, d.ExtractJson, d.ExtractedAt
          FROM dbo.DocumentExtract d
          JOIN dbo.SourceFile s ON s.SourceFileId = d.SourceFileId
         WHERE d.SourceFileId = @id;
      `, [{ name: "id", type: sql.BigInt, value: doc.sourceFileId }]);

      return toStored(recordset[0]);
    },

    /** @returns {Promise<boolean>} whether a row was actually removed */
    async remove(sourceFileId) {
      const { rowsAffected } = await ex.query(
        `DELETE FROM dbo.DocumentExtract WHERE SourceFileId = @id;`,
        [{ name: "id", type: sql.BigInt, value: sourceFileId }]
      );
      return (rowsAffected?.[0] ?? 0) > 0;
    },
  };
}
```

- [ ] **Step 7: Wire both into `server/index.js`**

Add the imports beside the existing repo imports (near line 36):

```js
import { documentExtractsRepo } from "./repos/documentExtracts.js";
import { memoryDocuments } from "./documents/memoryDocuments.js";
```

In the `repos` object (near line 88), add:

```js
    documents: documentExtractsRepo(ex),
```

In the SQL `backends` object (near line 119), add:

```js
    documents: repos.documents,
```

In the memory `backends` object in the `else` branch, add:

```js
    documents: memoryDocuments(),
```

- [ ] **Step 8: Run the whole suite**

Run: `npm test`
Expected: all previously-passing tests still pass, plus the new ones.

- [ ] **Step 9: Mutation-check**

In `memoryDocuments`, delete the `if (existing) return existing;` line and rerun. Expected: the re-import test FAILS. Restore.

- [ ] **Step 10: Commit**

```bash
git add server/db/migrations.js server/repos/documentExtracts.js server/documents/memoryDocuments.js server/index.js test/documents/memoryDocuments.test.js
git commit -m "feat(documents): persist extracts in SQL and in memory"
```

---

## Task 11: The Documents section

**Files:**
- Modify: `server/sections.js`
- Modify: `server/summarize.js`
- Test: `test/documents/section.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/documents/section.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { buildDocumentsSection, SECTION_TITLES, annotateChanges } from "../../server/sections.js";

const stored = {
  sourceFileId: 7,
  fileName: "status.pdf",
  kind: "pdf",
  title: "Digital Identity Programme",
  pageCount: 3,
  wordCount: 220,
  extractedAt: "2026-08-31T10:00:00.000Z",
  extract: {
    blocks: [],
    facts: { dates: [{ iso: "2026-11-15", text: "15 November 2026", page: 1, context: "Go-live." }], money: [], projectRefs: ["PRJ-1001"] },
    summary: [{ text: "The milestone slipped.", page: 1, heading: "Risks", score: 4 }],
    warnings: [],
  },
};

test("Documents is the sixth section title", () => {
  assert.equal(SECTION_TITLES.length, 6);
  assert.equal(SECTION_TITLES[5], "Documents");
});

test("an empty import list reports unavailable rather than an empty list", () => {
  const section = buildDocumentsSection([]);
  assert.equal(section.available, false);
  assert.match(section.headline, /No documents/i);
  assert.deepEqual(section.documents, []);
});

test("a stored document becomes one section item carrying its provenance", () => {
  const section = buildDocumentsSection([stored]);
  assert.equal(section.available, true);
  assert.equal(section.documents.length, 1);

  const doc = section.documents[0];
  assert.equal(doc.title, "Digital Identity Programme");
  assert.equal(doc.fileName, "status.pdf");
  assert.equal(doc.pageCount, 3);
  assert.equal(doc.summary[0].heading, "Risks");
  assert.deepEqual(doc.projectRefs, ["PRJ-1001"]);
});

test("document nodes key on documentId so annotateChanges cannot touch them", () => {
  const section = buildDocumentsSection([stored]);
  const doc = section.documents[0];

  assert.equal(doc.documentId, 7);
  assert.equal(doc.id, undefined, "an `id` here would be matched against project ids");
  assert.equal(doc.projectId, undefined);

  /* annotateChanges walks on `node.projectId || node.id`. Its own comment warns
     that a builder exposing an item's OWN id under those names is silently
     misannotated with a project's change. Prove this builder is not that. */
  const sections = { documents: section };
  const changes = new Map([["7", { worst: "worse" }], ["PRJ-1001", { worst: "worse" }]]);
  annotateChanges(sections, changes);

  assert.equal(section.documents[0].change, undefined,
    "a document must never be annotated with a project's change");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/section.test.js`
Expected: FAIL — `buildDocumentsSection` is not exported.

- [ ] **Step 3: Implement the builder**

In `server/sections.js`, add before `buildSections`:

```js
/**
 * Section 6 — Documents. Imported PDFs, Word files and text, presented as what
 * was read out of them.
 *
 * These are NOT projects and must never be made to look like one: a document
 * has no health, no budget and no dates of its own, so every one of the other
 * five sections would have to invent them.
 *
 * Each item keys on `documentId`, never `id` or `projectId`. annotateChanges
 * walks every node on `node.projectId || node.id`, and its comment warns that
 * a builder exposing an item's own id under one of those names gets silently
 * annotated with a project's change. This is the builder that warning was
 * about, so the convention is honoured here deliberately and pinned by test.
 *
 * @param {object[]} stored rows from the documents store
 */
export function buildDocumentsSection(stored = []) {
  if (!stored.length) {
    return {
      available: false,
      headline: "No documents have been imported yet.",
      documents: [],
    };
  }

  const documents = stored.map((d) => ({
    documentId: d.sourceFileId,
    title: d.title,
    fileName: d.fileName,
    kind: d.kind,
    pageCount: d.pageCount,
    wordCount: d.wordCount,
    extractedAt: d.extractedAt,
    summary: d.extract?.summary ?? [],
    dates: d.extract?.facts?.dates ?? [],
    money: d.extract?.facts?.money ?? [],
    projectRefs: d.extract?.facts?.projectRefs ?? [],
    warnings: d.extract?.warnings ?? [],
  }));

  const n = documents.length;
  return {
    available: true,
    headline: `${n} document${n === 1 ? "" : "s"} imported.`,
    documents,
  };
}
```

- [ ] **Step 4: Add it to `buildSections` and the titles**

In `buildSections`, change the signature to accept documents and add the builder:

```js
export function buildSections(projects, { period, start, end, todayISO, postureRows = [], documents = [] }) {
```

and in its return statement:

```js
  const documentsSection = buildDocumentsSection(documents);

  return { successes, qri, priorities, roadmap, posture, documents: documentsSection };
```

Extend `SECTION_TITLES`:

```js
export const SECTION_TITLES = [
  "Successes",
  "Questions, Risks & Issues",
  "Priorities",
  "Roadmap / Planned Projects",
  "Security Posture",
  "Documents",
];
```

- [ ] **Step 5: Add `loadDocuments` and pass it through**

In `server/summarize.js`, add beside `loadChanges`:

```js
/**
 * Imported documents, or an empty list if this deployment has no document
 * store. Mirrors loadChanges: a failure here must not take down the briefing,
 * which is still correct without the Documents section.
 *
 * @param {object|null} documentsStore backends.documents
 */
export async function loadDocuments(documentsStore) {
  if (!documentsStore || typeof documentsStore.list !== "function") return [];
  try {
    return await documentsStore.list();
  } catch (err) {
    console.error(`[documents] could not load imported documents: ${err.message}`);
    return [];
  }
}
```

In `buildSummary`, accept and forward the option. Change the signature:

```js
export function buildSummary(store, period, dateISO, { changes = null, historyStartedAt = null, documents = [] } = {}) {
```

and find the `buildSections(...)` call inside it, adding `documents` to the options object passed to it.

- [ ] **Step 6: Wire it in `server/app.js`**

`createApp(deps)` takes a **flat deps object** and destructures what it needs
near the top, with optional dependencies defaulting — e.g.
`const ingestRuns = deps.ingestRuns || null;`. There is no `backends` object
inside the app; that name exists only in `server/index.js`. Follow the existing
pattern exactly.

Add beside the other optional-dependency lines (near line 62):

```js
  const documents = deps.documents || null;
```

Add `loadDocuments` to the import on line 18. Then replace the `summarize`
helper at lines 101-107:

```js
  const summarize = async (period, dateISO) => {
    const [changes, historyStartedAt, docs] = await Promise.all([
      loadChanges(store, period, dateISO),
      loadHistoryStart(store),
      loadDocuments(documents),
    ]);
    return buildSummary(store, period, dateISO, { changes, historyStartedAt, documents: docs });
  };
```

`loadDocuments` already returns `[]` for a null store, so a deployment or test
that passes no document store simply gets an unavailable Documents section
rather than an error.

- [ ] **Step 7: Run to verify it passes**

Run: `node --test test/documents/section.test.js`
Expected: PASS, 4 tests.

Run: `npm test`
Expected: no regressions. If a test asserts `SECTION_TITLES.length === 5`, update it to 6 — that is a real interface change, not a broken test.

- [ ] **Step 8: Mutation-check**

Rename `documentId` to `id` in `buildDocumentsSection` and rerun. Expected: the annotateChanges test FAILS. Restore. This is the single most important mutation in the plan — if it does not fail, the guard is not real.

- [ ] **Step 9: Commit**

```bash
git add server/sections.js server/summarize.js server/app.js test/documents/section.test.js
git commit -m "feat(documents): add the Documents section to the briefing"
```

---

## Task 12: The upload path

**Files:**
- Modify: `server/app.js` (upload route, ~line 314)
- Test: `test/documents/upload.test.js`

Workbooks are written into the watched folder and the watcher owns the upsert.
Documents cannot take that route — the watcher handles workbooks only, and by
design documents arrive by upload alone. So the document branch vaults, records
and stores inline.

- [ ] **Step 1: Write the failing test**

Create `test/documents/upload.test.js`. Follow the existing upload tests in
`test/` for how the app is constructed; the assertions that matter:

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/documents");

/* There is no shared test-app helper in this project -- verified, it does not
   exist. test/api/app.test.js builds the app inline, and this file does the
   same rather than introducing a second harness. Copy that file's makeApp and
   signedIn helpers, adding `documents: memoryDocuments()` and
   `sourceFiles: memorySourceFiles()` to the createApp deps. */
import request from "supertest";
import { createApp } from "../../server/app.js";
import { loadConfig } from "../../server/config.js";
import { Store } from "../../server/store.js";
import { memorySessions, memoryRoleMapping, devAuthenticate } from "../../server/devBackends.js";
import { memoryDocuments, memorySourceFiles } from "../../server/documents/memoryDocuments.js";

const config = loadConfig({ NODE_ENV: "test", STORE: "memory", AUTH_MODE: "dev", DEV_ROLE: "admin" });

/* Each app gets a throwaway data dir: the upload route writes accepted
   workbooks into dataDir, and pointing that at the real data/ folder once
   dropped a workbook into the running dashboard's watched directory. */
const scratchDirs = [];
function scratchDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gcio-docs-test-"));
  scratchDirs.push(dir);
  return dir;
}

function makeApp(role = "pm") {
  const app = createApp({
    store: new Store(),
    config,
    sessions: memorySessions(),
    roleMapping: memoryRoleMapping({ [`gcio-dashboard-${role}s`]: role }),
    audit: { append: async () => {}, recent: async () => [] },
    ldapAuthenticate: devAuthenticate(role),
    documents: memoryDocuments(),
    sourceFiles: memorySourceFiles(),
    dataDir: scratchDataDir(),
    clientDist: "client/dist",
  });
  return app;
}

async function signedIn(app) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username: "tester", password: "anything" });
  assert.equal(res.status, 200, `sign-in failed: ${JSON.stringify(res.body)}`);
  return agent;
}

const buildTestApp = async ({ role }) => ({ agent: await signedIn(makeApp(role)) });

test("a mixed batch imports the good files and reports the bad one", async () => {
  const { agent } = await buildTestApp({ role: "pm" });

  const res = await agent
    .post("/api/ingest/upload")
    .attach("files", path.join(FIX, "status-report.pdf"))
    .attach("files", path.join(FIX, "corrupt.pdf"))
    .attach("files", path.join(FIX, "status-report.md"));

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false, "one file failed, so the batch is not ok");
  assert.equal(res.body.ingested.length, 2, "the good files still imported");
  assert.equal(res.body.errors.length, 1);
  assert.match(res.body.errors[0].file, /corrupt/);
});

test("an imported document appears in the briefing's Documents section", async () => {
  const { agent } = await buildTestApp({ role: "pm" });
  await agent.post("/api/ingest/upload").attach("files", path.join(FIX, "status-report.pdf"));

  const res = await agent.get("/api/summary?period=month");
  assert.equal(res.status, 200);
  assert.equal(res.body.sections.documents.available, true);
  assert.equal(res.body.sections.documents.documents.length, 1);
  assert.match(res.body.sections.documents.documents[0].title, /Digital Identity/);
});

test("importing the same document twice keeps one entry", async () => {
  const { agent } = await buildTestApp({ role: "pm" });
  const file = path.join(FIX, "status-report.pdf");
  await agent.post("/api/ingest/upload").attach("files", file);
  await agent.post("/api/ingest/upload").attach("files", file);

  const res = await agent.get("/api/summary?period=month");
  assert.equal(res.body.sections.documents.documents.length, 1);
});

test("a viewer cannot import documents", async () => {
  const { agent } = await buildTestApp({ role: "viewer" });
  const res = await agent
    .post("/api/ingest/upload")
    .attach("files", path.join(FIX, "status-report.md"));
  assert.equal(res.status, 403);
});
```

The test file also needs `import fs from "node:fs"`, `import os from "node:os"`
and `import path from "node:path"` for `scratchDataDir`. Read
`test/api/app.test.js` and follow it — it is the reference for how an app under
test is built in this project.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/upload.test.js`
Expected: FAIL — documents are refused or do not reach the section.

- [ ] **Step 3: Add the document branch**

In `server/app.js`, add the imports:

```js
import { extractDocument, DOCUMENT_EXTENSIONS } from "./documents/extract.js";
import { extractFacts } from "./documents/facts.js";
import { summariseDocument } from "./documents/summarise.js";
import { hashBytes } from "./ingest/hash.js";
```

Then declare the three new optional dependencies beside the existing ones near
line 62, following the `const ingestRuns = deps.ingestRuns || null;` pattern
already in `createApp`:

```js
  const documents = deps.documents || null;
  const sourceFiles = deps.sourceFiles || null;
  const vault = deps.vault || null;
```

Wire them in `server/index.js` by passing `documents`, `sourceFiles` and `vault`
into the `createApp({ ... })` call. In the SQL branch they are
`repos.documents`, `repos.sourceFiles` and the same vault already built for
`SqlStore`; in the memory branch they are `memoryDocuments()`,
`memorySourceFiles()` and `null`.

Inside the `for (const f of files)` loop, immediately after the guard verdict
check and before `ingestBuffer`, insert:

```js
      /* Documents do not go through the watched folder. The watcher handles
         workbooks only, and a document has no projects to upsert -- it is
         vaulted, recorded and extracted here, then read back by the briefing. */
      if (DOCUMENT_EXTENSIONS.has(path.extname(safe).toLowerCase())) {
        if (!documents) {
          errors.push({ file: safe, error: "this deployment cannot import documents" });
          continue;
        }
        try {
          const extracted = await extractDocument(f.buffer, safe);

          /* The vault is optional: only SqlStore has one, memory mode has
             none, and app.js has never reached into store internals. When
             there is no vault the document still imports -- it just has no
             provenance copy, which is exactly the situation in the tests. */
          const vaulted = vault ? vault.store(f.buffer, safe) : { hash: hashBytes(f.buffer), vaultPath: null, bytes: f.buffer.length };
          const { sourceFileId } = await sourceFiles.record({
            fileName: safe, sha256: vaulted.hash, bytes: vaulted.bytes,
            vaultPath: vaulted.vaultPath, uploadedBy: req.session.principal,
          });

          await documents.add({
            sourceFileId,
            fileName: safe,
            kind: extracted.kind,
            title: extracted.title,
            pageCount: extracted.pageCount,
            wordCount: extracted.wordCount,
            extract: {
              blocks: extracted.blocks,
              facts: extractFacts(extracted.blocks),
              summary: summariseDocument(extracted.blocks),
              warnings: extracted.warnings,
            },
          });

          ingested.push({ file: safe, document: extracted.title, warnings: extracted.warnings });
          await auditFrom(req, {
            actor: req.session.principal, action: "upload.document",
            subject: `${safe} (${extracted.wordCount} words)`,
          });
        } catch (err) {
          /* One unreadable file must not cost the rest of the batch. */
          errors.push({ file: safe, error: err.message });
          await auditFrom(req, {
            actor: req.session.principal, action: "upload.rejected",
            subject: `${safe}: ${err.message}`,
          });
        }
        continue;
      }
```

This requires `backends.sourceFiles` and a vault reachable from the route. If
`backends` does not expose `sourceFiles`, add it in `server/index.js` alongside
`documents` in both branches (memory mode needs a stub whose `record` returns an
incrementing `sourceFileId`; put that stub in `server/documents/memoryDocuments.js`
as a second export `memorySourceFiles()` so the memory path is self-contained).
Read `server/index.js` and wire whichever is missing before implementing.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/documents/upload.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Mutation-check**

Remove the `try`/`catch` around the document branch so a bad file throws, and
rerun. Expected: the mixed-batch test FAILS. Restore.

- [ ] **Step 6: Commit**

```bash
git add server/app.js server/documents/memoryDocuments.js test/documents/upload.test.js
git commit -m "feat(documents): import documents through the existing upload route"
```

---

## Task 13: Purge

**Files:**
- Modify: `server/app.js`
- Test: `test/documents/purge.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/documents/purge.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* Same inline construction as test/documents/upload.test.js -- copy the
   makeApp/signedIn/buildTestApp helpers from there. There is no shared test-app
   helper in this project and this plan does not add one. */

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/documents");

test("a PM can remove an imported document", async () => {
  const { agent } = await buildTestApp({ role: "pm" });
  await agent.post("/api/ingest/upload").attach("files", path.join(FIX, "status-report.md"));

  const before = await agent.get("/api/summary?period=month");
  const id = before.body.sections.documents.documents[0].documentId;

  const res = await agent.delete(`/api/documents/${id}`);
  assert.equal(res.status, 200);

  const after = await agent.get("/api/summary?period=month");
  assert.equal(after.body.sections.documents.available, false);
});

test("removing something that is not there is a 404, not a silent success", async () => {
  const { agent } = await buildTestApp({ role: "pm" });
  const res = await agent.delete("/api/documents/999999");
  assert.equal(res.status, 404);
});

test("a viewer cannot remove a document", async () => {
  const { agent } = await buildTestApp({ role: "viewer" });
  const res = await agent.delete("/api/documents/1");
  assert.equal(res.status, 403);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/documents/purge.test.js`
Expected: FAIL — the route does not exist (404 on the PM case too).

- [ ] **Step 3: Add the route**

In `server/app.js`, immediately after the upload route, add:

```js
  /* Exists so testing with demo files does not mean hand-editing the database.
     The vault copy is deliberately left in place: it is content-addressed, it
     is the provenance record, and deleting it would break any other row that
     happens to reference the same bytes. */
  app.delete("/api/documents/:sourceFileId", requireRole("pm"), wrap(async (req, res) => {
    const id = Number(req.params.sourceFileId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "not a document id" });

    const removed = await backends.documents.remove(id);
    if (!removed) return res.status(404).json({ error: "no such imported document" });

    await auditFrom(req, {
      actor: req.session.principal, action: "document.removed", subject: String(id),
    });
    res.json({ ok: true });
  }));
```

Note this contradicts the spec, which said the purge deletes the vault copy.
Leaving the vault copy is the better call and the reason is in the comment: the
vault is content-addressed, so two documents with identical bytes share one
file and deleting it would break the other. Update the spec's Purge paragraph to
match, in the same commit.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/documents/purge.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-check**

Change `if (!removed)` to `if (false)` and rerun. Expected: the 404 test FAILS. Restore.

- [ ] **Step 6: Commit**

```bash
git add server/app.js docs/superpowers/specs/2026-08-27-document-import-design.md test/documents/purge.test.js
git commit -m "feat(documents): let a PM remove an imported document"
```

---

## Task 14: The client section

**Files:**
- Create: `client/src/components/DocumentsSection.jsx`
- Modify: `client/src/components/UploadPanel.jsx:4`
- Modify: `client/src/App.jsx`

- [ ] **Step 1: Widen the accepted types**

In `client/src/components/UploadPanel.jsx` line 4:

```js
const ACCEPT = ".xlsx,.xls,.xlsm,.csv,.pdf,.docx,.txt,.md";
```

The input already carries `multiple` (line 54) and the route already accepts up
to 20 files, so multi-select needs no other change.

- [ ] **Step 2: Build the section component**

Read an existing section component first and follow its structure, class names
and heading levels — the brand palette, print styles and accessibility work all
come from reusing those, and a bespoke layout here would lose all three.

Create `client/src/components/DocumentsSection.jsx`:

```jsx
/**
 * Section 6 — Documents.
 *
 * The heading says "Extracted from the document", never "Summary": these
 * sentences were selected from the file, not written about it. Saying
 * otherwise would tell a reader that something understood the document.
 */
export default function DocumentsSection({ section, canRemove, onRemove }) {
  if (!section?.available) {
    return (
      <section className="section" aria-labelledby="documents-heading">
        <h2 id="documents-heading">Documents</h2>
        <p className="empty">{section?.headline ?? "No documents have been imported yet."}</p>
      </section>
    );
  }

  return (
    <section className="section" aria-labelledby="documents-heading">
      <h2 id="documents-heading">Documents</h2>
      <p className="headline">{section.headline}</p>

      {section.documents.map((doc) => (
        <article className="document" key={doc.documentId}>
          <h3>{doc.title}</h3>
          <p className="document-meta">
            {doc.fileName} · {doc.kind}
            {doc.pageCount !== null ? ` · ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}` : ""}
            {` · ${doc.wordCount} words`}
          </p>

          {doc.warnings.length > 0 && (
            <ul className="document-warnings">
              {doc.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}

          {doc.summary.length > 0 && (
            <>
              <h4>Extracted from the document</h4>
              <ul className="document-summary">
                {doc.summary.map((s, i) => (
                  <li key={i}>
                    <q>{s.text}</q>
                    <span className="provenance">
                      {s.heading ? s.heading : "document"}
                      {s.page !== null ? `, page ${s.page}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {doc.projectRefs.length > 0 && (
            <p className="document-refs">
              Mentions: {doc.projectRefs.join(", ")}
              <span className="note"> (reported, not linked)</span>
            </p>
          )}

          {canRemove && (
            <button type="button" onClick={() => onRemove(doc.documentId)}>
              Remove this document
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
```

- [ ] **Step 3: Render it in `App.jsx`**

Find where the other five sections are rendered and add `DocumentsSection`
after Security Posture, passing `section={summary.sections.documents}`,
`canRemove={role === "pm"}` and an `onRemove` that calls
`DELETE /api/documents/:id` and then refetches the summary. Match how the
existing sections receive their data — do not introduce a different pattern.

- [ ] **Step 4: Build and check**

Run: `npm run build`
Expected: build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/DocumentsSection.jsx client/src/components/UploadPanel.jsx client/src/App.jsx
git commit -m "feat(documents): render the Documents section"
```

---

## Task 15: Exports

**Files:**
- Modify: `server/exporters/html.js`, `word.js`, `excel.js`, `pptx.js`

All four walk section data, so each needs the new node type rendered. There is
no PDF exporter — PDF output is the browser printing the HTML export.

- [ ] **Step 1: Add the renderer to `html.js`**

`html.js` renders each section with a `renderX(sec)` function returning a
`<section class="block">`, numbered via `sectionHead(n, title, sub)`, using the
file's own `esc`, `arr`, `str` and `num` helpers. Follow that exactly.

Add after `renderPosture` (which ends around line 380):

```js
function renderDocuments(sec) {
  if (!sec || !sec.available) return "";
  const documents = arr(sec.documents);
  return `
<section class="block">
  ${sectionHead(6, "Documents", str(sec.headline, ""))}
  ${documents.map((d) => `
  <article class="doc">
    <h3>${esc(d.title)}</h3>
    <p class="doc-meta">${esc(d.fileName)} · ${esc(d.kind)}${
      d.pageCount !== null ? ` · ${num(d.pageCount)} page${num(d.pageCount) === 1 ? "" : "s"}` : ""
    } · ${num(d.wordCount)} words</p>
    ${arr(d.warnings).length ? `<ul class="doc-warn">${
      arr(d.warnings).map((w) => `<li>${esc(w)}</li>`).join("")
    }</ul>` : ""}
    ${arr(d.summary).length ? `<h4>Extracted from the document</h4><ul class="doc-quotes">${
      arr(d.summary).map((s) => `<li><q>${esc(s.text)}</q> <span class="prov">${
        esc(str(s.heading, "document"))}${s.page !== null ? `, page ${num(s.page)}` : ""
      }</span></li>`).join("")
    }</ul>` : ""}
    ${arr(d.projectRefs).length
      ? `<p class="doc-refs">Mentions: ${esc(arr(d.projectRefs).join(", "))} (reported, not linked)</p>`
      : ""}
  </article>`).join("")}
</section>`;
}
```

Then add the call beside the other five, after `renderPosture(sections.posture)`:

```js
  ${renderDocuments(sections.documents)}
```

- [ ] **Step 2: Add it to the other three**

Each has its own idiom — read the file and follow what is there rather than
copying the HTML shape above.

`word.js`: emit a heading for the section, then per document a sub-heading with
the title, a metadata line, the extracted sentences as quoted paragraphs each
followed by its provenance, and any warnings.

`excel.js`: tabular, so one worksheet row **per extracted sentence** —
columns `Document`, `File`, `Page`, `Heading`, `Extracted sentence` — plus a
`Warnings` column on the document's first row. That shape is what makes the
export useful for filtering, which a single cell of concatenated text would not.

`pptx.js`: use `shared/pptx-lite.mjs` as the existing slides do. Its constraint
matters here because provenance sits on its own line: **OOXML ignores `\n`
inside `<a:t>`**, so a line break needs a real break element, not a newline
character. This project already shipped a cover slide that ran two lines
together for exactly this reason. `scripts/pptx-audit.mjs` has a `LINEFEED`
check — run it after this change.

- [ ] **Step 3: Verify each export**

Run: `npm test`
Expected: existing exporter tests still pass.

Then start the app with `STORE=memory`, import a fixture document, and download
each of the four exports. Open each one and confirm the Documents section is
present and readable. An exporter test that only checks the file is non-empty
does not prove this — look at the files.

- [ ] **Step 4: Commit**

```bash
git add server/exporters
git commit -m "feat(documents): carry the Documents section into all four exports"
```

---

## Task 16: Full verification

- [ ] **Step 1: Run everything**

Run: `npm run test:all`
Expected: all green. Record the actual counts — do not quote a number from
earlier in this plan.

`npm test` excludes the browser suites and `npm run test:ui` runs them. Do
**not** set `DB_LIVE=1`: it needs an empty database and the live instance is
shared with other sessions.

- [ ] **Step 2: Confirm nothing is invisible to git**

Run: `git status --short` and `git check-ignore -v test/fixtures/documents/*`
Expected: no fixture is ignored, and no new file is untracked.

- [ ] **Step 3: Exercise the real thing**

Start the app with `STORE=memory`, sign in as a PM, select **several files at
once** — a PDF, a Word file and a text file — and import them in one go. Confirm
the Documents section shows all three, that a scanned PDF shows its warning, and
that removing one takes it out of the briefing.

This is the demo the feature was asked for. If selecting multiple files does not
work in the browser, the feature is not done regardless of what the tests say.

- [ ] **Step 4: Commit any fixes, then stop**

Do not merge. Report what passed, what failed, and anything you had to change
from this plan.

---

## Notes for the implementer

**Three things were checked against the code after this plan was first drafted,
and the plan was corrected. They are recorded here so nobody re-derives them:**

- **There is no `test/helpers/app.js`.** It does not exist. `test/api/app.test.js`
  builds the app inline with `createApp`, `loadConfig`, `Store`, `memorySessions`,
  `memoryRoleMapping` and `devAuthenticate`, driven by supertest's
  `request.agent`. Tasks 12 and 13 now carry that construction directly. Do not
  add a shared harness.
- **`createApp(deps)` takes a flat deps object.** There is no `backends` object
  inside `app.js` — that name exists only in `server/index.js`, which is why
  Task 10 Step 7 legitimately refers to it and Tasks 11–13 do not. Optional
  dependencies default near the top of `createApp`, e.g.
  `const ingestRuns = deps.ingestRuns || null;`. `documents`, `sourceFiles` and
  `vault` follow that pattern.
- **`app.js` has never touched the vault.** Only `SqlStore` holds one
  (`this.vault`, used inside `applyFile`); the memory `Store` has none. So the
  vault is passed into `createApp` as an optional dep and the document branch
  works without it — which is the case in every test.

**Where this plan may still be wrong.** The `buildSections` call inside
`buildSummary` needs `documents` threaded through; find the actual call rather
than trusting line numbers here, since the peer session has been editing these
files. Line numbers throughout are from `f79cb2c` and may have moved.

If anything differs from what the plan says, follow the code and note the
difference in your report. The plan is a starting position, not an authority
over what is actually there.
