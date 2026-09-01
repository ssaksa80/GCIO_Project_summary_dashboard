import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { extractDocument, DOCUMENT_EXTENSIONS } from "../../server/documents/extract.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/documents");
const read = (name) => fs.readFileSync(path.join(FIX, name));

/* No .docx fixture on disk, and none is wanted: the dispatcher only has to be
   caught handing the bytes to the docx adapter, so the smallest thing that
   adapter will read is enough. */
const minimalDocx = () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>` +
    `<w:p><w:r><w:t>The vendor slipped.</w:t></w:r></w:p>` +
    `</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
};

test("DOCUMENT_EXTENSIONS is the whole list an upload may be accepted on", () => {
  assert.deepEqual([...DOCUMENT_EXTENSIONS].sort(), [".docx", ".md", ".pdf", ".txt"]);
});

test("nothing DOCUMENT_EXTENSIONS advertises falls through to the refusal", async () => {
  /* The Set and the switch are two lists, and two lists drift. Garbage bytes
     are enough to tell them apart: an adapter that was reached complains about
     the bytes, and only an extension that was never dispatched at all comes
     back refused as unsupported. */
  for (const ext of DOCUMENT_EXTENSIONS) {
    let message = null;
    try {
      await extractDocument(Buffer.from("nonsense"), `sample${ext}`);
    } catch (err) {
      message = err.message;
    }
    if (message !== null) {
      assert.doesNotMatch(message, /not a supported document type/,
        `${ext} is advertised as supported but nothing dispatches it`);
    }
  }
});

test("text and markdown route to the text adapter", async () => {
  for (const name of ["a.md", "a.txt"]) {
    const doc = await extractDocument(Buffer.from("# Title\n\nBody."), name);
    assert.equal(doc.kind, "text", `${name} must reach the text adapter`);
    assert.equal(doc.title, "Title");
  }
});

test("a .docx routes to the docx adapter", async () => {
  const doc = await extractDocument(await minimalDocx(), "report.docx");
  assert.equal(doc.kind, "docx");
  assert.deepEqual(doc.blocks.map((b) => b.text), ["The vendor slipped."]);
});

test("a .pdf routes to the pdf adapter", async () => {
  const doc = await extractDocument(read("status-report.pdf"), "status-report.pdf");
  assert.equal(doc.kind, "pdf");
  assert.equal(doc.pageCount, 1);
});

test("the extension is matched case-insensitively", async () => {
  const doc = await extractDocument(Buffer.from("Body."), "SHOUTING.TXT");
  assert.equal(doc.kind, "text",
    "Windows hands over uppercase extensions and it is the same file either way");
});

test("an unsupported extension is refused by name", async () => {
  await assert.rejects(
    () => extractDocument(Buffer.from("x"), "picture.png"),
    /\.png/,
    "the refusal must name the extension so the caller can report it"
  );
});

test("a filename with no extension is refused, and says what would have worked", async () => {
  await assert.rejects(
    () => extractDocument(Buffer.from("x"), "README"),
    /\.pdf \.docx \.txt \.md/,
    "with no extension to name, the refusal must at least list the ones that work"
  );
});

test("extraction is a promise even for the synchronous text adapter", () => {
  /* extractText returns its document outright; extractDocx and extractPdf
     return promises. No caller should ever have to know which -- one `await`
     has to be right for every format, or every call site grows a branch. */
  const returned = extractDocument(Buffer.from("Body."), "a.txt");
  assert.equal(typeof returned?.then, "function",
    "extractDocument must hand back a promise whatever the adapter underneath does");
  return returned;
});
