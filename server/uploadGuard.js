/**
 * An upload must be what its extension claims.
 *
 * Extension checks alone let a renamed executable land in the watched folder,
 * where a person might later double-click it. Checking the leading bytes costs
 * nothing and closes that path.
 */
import path from "node:path";

const ZIP = [0x50, 0x4b, 0x03, 0x04];       // .xlsx / .xlsm / .docx are ZIP containers
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0];      // legacy .xls
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

const startsWith = (buf, sig) => sig.every((byte, i) => buf[i] === byte);

/**
 * @param {Buffer} buffer file contents
 * @param {string} filename original name
 * @returns {{ok: boolean, reason?: string}}
 */
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
    if (ok) return { ok: true };
    const kind = ext === ".docx" ? "document" : "workbook";
    return { ok: false, reason: `not a real ${ext} — the contents are not a ${kind}` };
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
