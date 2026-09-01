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
