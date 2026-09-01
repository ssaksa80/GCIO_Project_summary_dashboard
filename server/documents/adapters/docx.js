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
