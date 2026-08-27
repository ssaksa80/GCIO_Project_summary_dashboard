# Multi-Format Document Import — Design

**Date:** 2026-08-27
**Status:** Approved for planning
**Supersedes:** nothing. Extends `2026-08-24-backend-production-design.md`.

## Goal

Let a PM upload PDF, Word, plain-text and Markdown documents alongside the
workbooks the dashboard already ingests, extract what is genuinely in them, and
present the result as a sixth section of the CIO briefing rendered in the same
style as the existing five.

## Decisions taken, and why

Four decisions were settled before design and constrain everything below.

**Extraction runs entirely on the machine. No document content leaves the
network.** This is an intranet system with LDAP sign-in holding real portfolio
data. Sending it to an external summarisation API is a data-egress decision the
project has not taken, so the design does not depend on one being taken later.
The cost is accepted and stated plainly in "What summarise means" below: nothing
is written, only selected.

**Imported documents get their own section. They do not become projects.** A PDF
has no health, no budget, no target end date and no milestones. Every one of the
five existing sections is built from those fields. Mapping a document onto a
project row would mean inventing them, which is the fabrication this project has
refused elsewhere (see the degrade-honestly decision in the P2 design). Project
references found in a document are *reported* — never used to attach content to
a project, because a wrong attachment puts misleading evidence under a real
project and is worse than no attachment at all.

**Documents persist exactly as workbooks do.** Original to the vault, SHA-256 to
`dbo.SourceFile`, extract to a new table. They survive restart, they are the same
for every viewer, and they reach the exports. A purge control is included so
demo files can be cleared without hand-editing the database.

**PDF text extraction uses `pdfjs-dist`.** Rationale and the version constraint
are in "PDF" below; both were established by measurement, not assumption.

## What already exists

Three things were found during design that materially reduce scope. They are
recorded here because the plan depends on them.

- **Multi-file upload is already built.** `server/app.js:309` is
  `upload.array("files", 20)` behind `requireRole("pm")`, `multer` limits are
  25 MB per file and 20 files, and `client/src/components/UploadPanel.jsx:54`
  already carries `multiple`. No new upload endpoint and no new UI plumbing is
  needed for multi-select. The only blockers are the `ACCEPT` constant
  (`".xlsx,.xls,.xlsm,.csv"`) and `looksLikeWorkbook`, which rejects any
  extension outside that set.
- **`dbo.SourceFile` is already format-agnostic.** Its columns are `FileName`,
  `Sha256`, `Bytes`, `VaultPath`, `UploadedBy`, `FirstSeenAt`, `LastSeenAt`.
  Nothing in it assumes a workbook, so documents reuse it unchanged, including
  the `MERGE ... WITH (HOLDLOCK)` in `sourceFiles.record()` that already makes
  re-import idempotent.
- **`jszip` is already in the tree, but only transitively.** A `.docx` is a ZIP
  containing `word/document.xml`, so Word support needs no *new* download —
  `jszip@3.10.1` is already there, hoisted from `docx@9.7.1` and `exceljs@4.4.0`
  and deduped. `shared/pptx-lite.mjs` already hand-builds OOXML in this codebase,
  so the technique has precedent here.

  **It must nonetheless be declared as a direct dependency.** It is not in
  `package.json` today. Importing an undeclared transitive package works only
  because npm hoists it, and breaks silently the day either parent drops it or
  bumps to an incompatible major. Adding `"jszip": "^3.10.1"` to `dependencies`
  costs no disk (it is already installed and deduped) and makes the import
  legitimate.

  Note that `docx@9.x` is a **writer** — "Easily generate .docx files" — and
  cannot read Word documents. It is not an option for the `.docx` adapter
  despite the promising name.

## Architecture

```
upload (existing, PM-gated)
  └── per file: dispatch on extension
        ├── workbook  → existing ingest path, unchanged
        └── document  → adapter → normalised text + structure
                          ├── facts    (dates, money, project refs)
                          ├── summary  (extractive sentence selection)
                          └── persist  (vault + SourceFile + DocumentExtract)
                                └── buildDocumentsSection → briefing + exports
```

The workbook path is not touched. A file only enters the document path when its
extension is not a workbook extension, so no existing behaviour changes.

### Module layout

Each adapter is its own file with one responsibility, one format, and the same
return shape, so a format can be added or fixed without reading the others.

| File | Responsibility |
| --- | --- |
| `server/documents/extract.js` | Dispatch by extension; own the `ExtractedDocument` contract; never parse anything itself |
| `server/documents/adapters/text.js` | `.txt`, `.md` — decode, normalise line endings |
| `server/documents/adapters/docx.js` | `.docx` — unzip via `jszip`, read `word/document.xml`, `<w:t>` runs into `<w:p>` paragraphs |
| `server/documents/adapters/pdf.js` | `.pdf` — lazy-import `pdfjs-dist`, `getTextContent()` per page |
| `server/documents/facts.js` | Dates, currency amounts, `PRJ-\d+` references, with surrounding context |
| `server/documents/summarise.js` | Extractive sentence scoring and selection |
| `server/repos/documentExtracts.js` | Read/write `dbo.DocumentExtract`; delete for purge |
| `server/sections.js` | Add `buildDocumentsSection`; extend `SECTION_TITLES` |
| `client/src/components/DocumentsSection.jsx` | Render the section using existing section primitives |

### The `ExtractedDocument` contract

Every adapter returns this shape. Nothing downstream knows which format it came
from, which is what keeps `extract.js` and the section builder free of per-format
branching.

```js
{
  kind: "pdf" | "docx" | "text",
  title: string,          // first heading, else filename without extension
  blocks: [               // reading order, always present, may be empty
    { type: "heading" | "paragraph", text: string, page: number|null, level: number|null }
  ],
  pageCount: number|null, // null where the format has no pages
  wordCount: number,
  warnings: string[],     // e.g. "no text layer — this looks like a scan"
}
```

`page` is `null` for `.docx`, `.txt` and `.md`, which have no page concept before
rendering. Provenance for those formats is the nearest preceding heading, carried
in `blocks`, not a page number. The section renderer must handle a null page
rather than printing "page null".

## What "summarise" means here

This is the part most likely to be misread later, so it is stated exactly.

There is no LLM. **Nothing is written.** The summary is *extractive*: it selects
sentences that are already in the document and quotes them verbatim, each one
carrying the page or heading it came from so a reader can go and check it.

Sentences are scored on four signals, summed:

1. **Domain vocabulary the app already owns** — the RAG words, project status
   values, milestone status values and compliance status values already defined
   in `server/ingest.js`. A sentence containing "amber", "slipped", "overdue" or
   "at risk" scores. This reuses the vocabulary rather than inventing a second,
   divergent one.
2. **Presence of a date or a currency amount**, since a status document's load-
   bearing sentences usually carry one.
3. **Position** — first sentence under a heading scores above the fifth.
4. **Length band** — very short fragments and very long run-ons both score down.

Top *N* per document, capped, preserving document order rather than score order
so the result reads as a document rather than a ranked list.

`facts` runs separately and is not prose: ISO-normalised dates with the phrase
they appeared in, currency amounts with their context, and `PRJ-\d+` matches.

**Honest limitation, to be carried into the UI copy:** on a document with no
clear prose structure this surfaces and organises rather than genuinely
condensing. The section labels the content "Extracted from the document", not
"Summary", so a reader is never told a machine understood the document.

## PDF

The only format needing a real dependency decision. All figures below were
measured on this machine against a PDF printed by headless Chrome, which embeds
subset fonts — the case hand-rolled extractors fail on.

| Configuration | Result | Installed size | Module load |
| --- | --- | --- | --- |
| `pdfjs-dist@6` | works | 71 MB | 655 ms |
| `pdfjs-dist@6 --omit=optional` | **fails** — `ReferenceError: DOMMatrix is not defined` at module load | 35 MB | n/a |
| `pdfjs-dist@4` | works | 73 MB | 994 ms |
| **`pdfjs-dist@4 --omit=optional`** | **works** | **37 MB** | **69 ms** |

**Decision: pin `pdfjs-dist@^4.10` and install with `--omit=optional`.**

v6 hard-requires the `@napi-rs/canvas` optional dependency even for text-only
extraction, so the flag breaks it. v4 degrades correctly without canvas. The
37 MB is `@napi-rs/canvas-win32-x64-msvc` (37 MB of the 73 MB) not being
installed; text extraction never needs a canvas.

This degrades safely in the wrong direction: if a deployment forgets the flag it
installs canvas and still works, costing only disk. There is no configuration in
which forgetting the flag breaks the feature.

Three constraints follow, all of which the plan must implement:

- **The import must be lazy** — `await import("pdfjs-dist/legacy/build/pdf.mjs")`
  inside the adapter, on first PDF only. Loading it at boot would put 69 ms
  (v4-no-canvas) to 655 ms (v6) into process start, which is exactly the kind of
  boot-time cost that produced the false slow-parse warning fixed in `4013ff6`.
- **Its warnings go to stdout, not stderr** — `Cannot polyfill DOMMatrix` and
  friends print via `console.warn` at module load and would pollute the log.
  They must be captured and routed through the app logger, or suppressed.
- **Teardown must call `loadingTask.destroy()`**, not `doc.destroy()` — the
  latter does not exist. An undestroyed loading task keeps a worker alive and
  stops Node exiting, the same class of defect as the puppeteer teardown fixed
  during P4.

**Known limitation: PDF tables flatten to lines.** The probe returned
`Milestone Due Status` followed by `Pilot onboarding 2026-09-30 Amber`. No
reliable table structure can be recovered from PDF, so the design does not
promise any. Tables from `.xlsx` remain structured because they come through the
existing `exceljs` path.

**Scanned PDFs are out of scope.** A scan is an image; text needs OCR. A PDF
whose text layer yields effectively nothing must produce the warning
`no text layer — this looks like a scan` and be stored with that warning
visible, never silently stored as an empty extract.

## Persistence

### Migration 12

```sql
IF OBJECT_ID('dbo.DocumentExtract', 'U') IS NULL
CREATE TABLE dbo.DocumentExtract (
  DocumentExtractId BIGINT IDENTITY(1,1) PRIMARY KEY,
  SourceFileId      BIGINT         NOT NULL
    REFERENCES dbo.SourceFile (SourceFileId),
  Kind              VARCHAR(8)     NOT NULL,   -- pdf | docx | text
  Title             NVARCHAR(400)  NOT NULL,
  PageCount         INT            NULL,
  WordCount         INT            NOT NULL,
  ExtractJson       NVARCHAR(MAX)  NOT NULL,   -- blocks, facts, summary, warnings
  ExtractedAt       DATETIME2(3)   NOT NULL
);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_DocumentExtract_SourceFile')
  CREATE UNIQUE INDEX UX_DocumentExtract_SourceFile
    ON dbo.DocumentExtract (SourceFileId);
```

`PageCount` is nullable because `.docx` and `.txt` have no pages — a zero would
be a lie. The unique index on `SourceFileId` makes re-import idempotent at the
database level rather than relying on the caller to check first, matching how
`UX_SourceFile_Name_Sha` is used today.

`ExtractJson` holds the whole extract as one document rather than being
normalised into block and fact tables. This is deliberate: nothing queries
*across* documents by block or fact, the extract is always read whole to render
one section, and a schema change to the extract shape then costs no migration.
If cross-document querying is ever wanted, that is the point to normalise.

### Idempotency

The existing `sourceFiles.record()` MERGE returns `$action`. An identical file
re-uploaded produces `UPDATE` (LastSeenAt bumped) rather than `INSERT`, and the
unique index means the extract is not rewritten. Re-import of an unchanged
document is therefore a no-op, consistent with workbook behaviour.

### Purge

`DELETE /api/documents/:sourceFileId`, PM-gated, removes the `DocumentExtract`
row and the `SourceFile` row, and deletes the vault copy. The UI exposes it per
document in the Documents section. This exists so testing with demo files does
not require hand-editing the database.

## Presentation

`buildDocumentsSection(extracts)` returns the same node shape the other five
section builders return, and `SECTION_TITLES` gains a sixth entry, `"Documents"`.

### Document nodes must not carry `id` or `projectId`

`annotateChanges` walks every node in the built sections and annotates any that
has `node.projectId || node.id` matching a known project. Its own doc comment
(`server/sections.js:507`) warns that this rests on a convention nothing
enforces — that such a field always names *the project*, never the item's own
identity — and that a future builder surfacing an item's own id under one of
those names would be silently misannotated with a project's change.

This design is that future builder, so the constraint is explicit rather than
incidental: **document nodes key on `documentId`.** Never `id`, never
`projectId`, including for React keys in `DocumentsSection.jsx`.

This is pinned by test: build a Documents section, run `annotateChanges` over it
with a changes map whose key equals a document's identifier, and assert no
document node gained a `change` property. Mutation-check it by renaming
`documentId` to `id` and confirming the test fails.

Documents therefore have no version history in this design, which is a
deliberate scope boundary, not an omission.

Each document renders as: title, source filename, kind, page or word count,
extracted facts, then the selected sentences with their provenance, then any
warnings. Rendering reuses the existing section components so the brand palette,
print styles and accessibility work all apply without duplication.

All four exporters — `server/exporters/excel.js`, `html.js`, `pptx.js`,
`word.js` — walk section data, so each needs a small addition to render the new
node type. There is no PDF exporter; PDF output is browser print of the HTML
export.

## Upload guard

`looksLikeWorkbook` is renamed to `looksLikeSupportedFile` and extended. The
existing magic-byte checks are kept exactly as they are and the new ones follow
the same principle — an upload must be what its extension claims:

- `.pdf` → must start with `%PDF-`
- `.docx` → ZIP magic (`50 4B 03 04`), same as `.xlsx`
- `.txt`, `.md` → no NUL byte in the first 512 bytes, same rule already used for `.csv`

The rename touches one call site (`server/app.js:316`). `ACCEPT` in
`UploadPanel.jsx:4` gains `.pdf,.docx,.txt,.md`.

## Error handling

**One bad file must not fail the batch.** The upload endpoint already loops over
`req.files`. Each file's extraction is independently caught; a failure records a
per-file error and the remaining files still import. The response reports
per-file outcome, which the UI lists.

Failure modes and required behaviour:

| Case | Behaviour |
| --- | --- |
| Corrupt or truncated file | Per-file error, batch continues |
| Scanned PDF, no text layer | Imports with the `no text layer` warning shown |
| Encrypted PDF | Per-file error naming encryption as the cause |
| `.docx` with no `word/document.xml` | Per-file error, batch continues |
| Extension/content mismatch | Rejected by the upload guard before extraction |
| Empty extraction from a valid file | Imports, warning shown, no fabricated summary |

## Testing

Adapter unit tests run against committed fixture files, generated once and
checked in so the suite is hermetic and does not depend on a browser being
present.

- One fixture per format, plus: a scanned PDF (must warn, not silently empty),
  an encrypted PDF, a corrupt `.docx`, an empty `.txt`, and a PDF with a table
  (asserting the *documented* flattened behaviour, so the limitation is pinned
  rather than discovered later).
- Batch behaviour: a mixed upload of one good and one corrupt file imports the
  good one and reports the bad one.
- Idempotency: importing the same document twice leaves one `SourceFile` row,
  one `DocumentExtract` row, and does not change `ExtractedAt`.
- Purge: delete removes both rows and the vault copy.
- Lazy import: asserted by requiring the app and checking `pdfjs-dist` is absent
  from the module registry until a PDF is imported.

**Every assertion is mutation-checked.** Four tests on this project have shipped
in a state where they could not fail. A test is not accepted until the
implementation has been deliberately broken and the test has been observed
failing.

## Out of scope

Named explicitly so the plan does not drift into them:

- OCR of scanned documents.
- Attaching documents to projects, or any project matching beyond *reporting*
  the references found.
- Version history or change tracking for documents.
- Abstractive summarisation, which requires an LLM and was ruled out.
- Table structure recovery from PDF.
- Watching the drop folder for documents. Documents arrive by upload only in
  this phase; the folder watcher continues to accept workbooks alone.

## Risks

**The 37 MB dependency.** `pdfjs-dist` is the largest thing added to this
project. It is the reference implementation and the alternative — a hand-rolled
extractor — fails on subset fonts, which real government PDFs use. Accepted, with
the install flag documented in the runbook.

**Extractive summarisation may disappoint.** On a well-structured status report
it works well. On a dense unstructured document it will read as a list of
sentences. Mitigated by labelling honestly rather than by overclaiming, but the
possibility that the output is judged thin is real and is not an implementation
defect.

**Scope of the section is fixed.** Documents deliberately do not participate in
change tracking, trends or project linkage. If those are wanted, they are a
later phase built on this foundation, not additions to it.
