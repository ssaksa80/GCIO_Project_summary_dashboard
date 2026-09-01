/**
 * PDF, via pdfjs-dist -- the reference implementation.
 *
 * Pinned to v4. v6 hard-requires the @napi-rs/canvas optional dependency even
 * for text-only extraction and dies at module load with "DOMMatrix is not
 * defined"; v4 warns and carries on, so the install stays usable whether or
 * not the 37 MB canvas binary came along.
 *
 * The import is lazy on purpose: loading pdfjs costs 69 ms without canvas and
 * up to 655 ms with it, and spending that at boot of a service that may never
 * be sent a PDF is the same shape of problem as the false cold-start
 * slow-parse warning fixed in 4013ff6. pdfjsLoaded() exists so a test can hold
 * that to account -- nothing else about this module's behaviour would change
 * if the import were quietly hoisted.
 *
 * Known and accepted: table structure does not survive. A table comes back as
 * "Milestone Due Status" then "Pilot onboarding 2026-09-30 Amber". PDF has no
 * table semantics to recover, so this pipeline does not promise any.
 * Structured tables come from .xlsx, which keeps its own path.
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
  /* On a canvas-free install pdfjs prints "Cannot polyfill `DOMMatrix`" and
     two siblings while the module evaluates -- expected there, and noise in
     the service log. They go through pdfjs's own warn(), which is written with
     console.log, not console.warn: silencing console.warn alone (as an earlier
     draft of this did) suppresses nothing at all. console.warn is swapped too
     only so a future version that switches does not quietly start leaking. */
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } finally {
    console.log = realLog;
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
    /* Parsing prints too -- a damaged file draws "Warning: Indexing all PDF
       objects" out of that same console.log. Turning pdfjs's own verbosity
       down stops it at the source, which beats blanking console.log across an
       await: this runs in a live service, and whatever else logs during those
       milliseconds is not ours to swallow. */
    verbosity: lib.VerbosityLevel.ERRORS,
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

  const pageCount = doc.numPages;
  const blocks = [];
  try {
    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();

      /* pdfjs hands back positioned fragments, not lines. hasEOL is where it
         saw the line end, so a block here is a line of the page -- the
         smallest unit the format actually supports. */
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
    /* loadingTask.destroy(), NOT doc.destroy() -- that method does not exist.
       Measured on v4 in Node: the fake worker runs on this thread, so skipping
       this does NOT hold the event loop open, contrary to what the plan
       predicted. It still frees the transport and cancels outstanding page
       work, and it is the only teardown pdfjs offers, so it stays -- and the
       test asserts the call rather than an exit that would never hang. */
    await task.destroy().catch(() => {});
  }

  return {
    kind: "pdf",
    title: blocks.length ? blocks[0].text : path.basename(filename, path.extname(filename)),
    blocks,
    pageCount,
    wordCount: blocks.reduce((n, b) => n + countWords(b.text), 0),
    warnings: blocks.length ? [] : ["no text layer — this looks like a scan"],
  };
}
