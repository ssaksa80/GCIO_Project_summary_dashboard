import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/documents");
const read = (name) => fs.readFileSync(path.join(FIX, name));

/* Watch what actually gets loaded, then import the adapter dynamically so the
   hook is already in place -- a static import would be hoisted above it.
   This is what makes the laziness test below unfoolable: it does not ask the
   adapter whether it loaded pdfjs, it watches whether it did. */
const loadedModules = [];
registerHooks({
  load(url, context, nextLoad) {
    loadedModules.push(url);
    return nextLoad(url, context);
  },
});

const { extractPdf, pdfjsLoaded } = await import("../../server/documents/adapters/pdf.js");

const pdfjsModuleCount = () => loadedModules.filter((url) => url.includes("pdfjs-dist")).length;

/* Snapshot now, at import time: every test in this file runs after this point,
   and the first extraction anywhere in it loads pdfjs process-wide. Taking the
   reading here is what keeps the laziness test independent of test order. */
const pdfjsModulesAtImport = pdfjsModuleCount();
const seamAtImport = pdfjsLoaded();

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

test("pdfjs is not loaded until a PDF is actually extracted", async () => {
  assert.equal(pdfjsModulesAtImport, 0,
    "importing the adapter must not pull pdfjs-dist into the module graph");
  assert.equal(seamAtImport, false, "and pdfjsLoaded() must agree that it has not");

  await extractPdf(read("status-report.pdf"), "status-report.pdf");

  /* The other half of the claim: a seam wired to nothing, or an adapter that
     never loads pdfjs at all, would satisfy the assertions above. */
  assert.ok(pdfjsModuleCount() > 0, "extracting must load pdfjs-dist");
  assert.equal(pdfjsLoaded(), true, "and pdfjsLoaded() must report it");
});

test("the loading task is torn down after the text is out", async () => {
  /* The plan expected an undestroyed task to hang the run, so that skipping
     teardown would fail loudly by itself. It does not: measured on v4 in Node,
     the worker is a fake one on this thread and leaves no handle behind, so a
     missing destroy() is invisible -- exactly the shape of an assertion that
     cannot fail. Watch the call instead. PDFDocumentLoadingTask is not
     exported, so the prototype comes off a throwaway task. */
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  /* No verbosity option here on purpose: pdfjs applies it to a global, so
     setting it once would leave every later parse quiet and make the
     suppression test below pass no matter what the adapter does. */
  const throwaway = lib.getDocument({ data: new Uint8Array(read("scanned.pdf")) });
  throwaway.promise.catch(() => {});
  const taskPrototype = Object.getPrototypeOf(throwaway);
  const realDestroy = taskPrototype.destroy;
  await realDestroy.call(throwaway).catch(() => {});

  let destroys = 0;
  taskPrototype.destroy = function (...args) {
    destroys++;
    return realDestroy.apply(this, args);
  };
  try {
    await extractPdf(read("status-report.pdf"), "status-report.pdf");
  } finally {
    taskPrototype.destroy = realDestroy;
  }

  assert.equal(destroys, 1, "every extraction must destroy the loading task it opened");
});

test("pdfjs's own warnings stay out of the service log", async () => {
  /* The corrupt fixture makes pdfjs print "Warning: Indexing all PDF objects",
     and a canvas-free install prints "Cannot polyfill `DOMMatrix`" while the
     module evaluates. Both go through pdfjs's warn(), which is implemented
     with console.log -- so unsuppressed they land in the service log looking
     like the service's own complaint about a file it handled correctly. */
  const realLog = console.log;
  const printed = [];
  console.log = (...args) => { printed.push(args.join(" ")); };
  try {
    await assert.rejects(() => extractPdf(read("corrupt.pdf"), "corrupt.pdf"));
  } finally {
    console.log = realLog;
  }

  assert.deepEqual(printed, [], `pdfjs printed: ${printed.join(" | ")}`);
});
