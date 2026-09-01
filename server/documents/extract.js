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
 *
 * Async whatever is underneath: extractText is synchronous and the other two
 * are not, and a caller that had to know which would be branching on format
 * again -- the one thing this file exists to stop.
 */
import path from "node:path";
import { extractText } from "./adapters/text.js";
import { extractDocx } from "./adapters/docx.js";
import { extractPdf } from "./adapters/pdf.js";

/* The upload route screens on this before reading a byte, so it has to stay in
   step with the switch below -- the test walks it and checks every member
   actually reaches an adapter. */
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
      /* Names the extension, because the upload route quotes this straight
         back at whoever picked the file: "that" only when there was none. */
      throw new Error(`${ext || "that"} is not a supported document type (use .pdf .docx .txt .md)`);
  }
}
