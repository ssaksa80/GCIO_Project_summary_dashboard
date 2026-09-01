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
