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
