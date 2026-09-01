import test from "node:test";
import assert from "node:assert/strict";
import { extractFacts } from "../../server/documents/facts.js";

const blocks = [
  { type: "paragraph", text: "PRJ-1001 slipped. Go-live moved to 15 November 2026.", page: 1, level: null },
  { type: "paragraph", text: "Spend is SAR 4,250,000 against 2026-09-30.", page: 2, level: null },
];

test("dates are normalised to ISO and keep the phrase they came from", () => {
  const facts = extractFacts(blocks);
  const iso = facts.dates.map((d) => d.iso);
  assert.ok(iso.includes("2026-11-15"), `expected 2026-11-15 in ${iso}`);
  assert.ok(iso.includes("2026-09-30"), `expected 2026-09-30 in ${iso}`);
  assert.match(facts.dates.find((d) => d.iso === "2026-11-15").context, /Go-live moved/);
});

test("currency amounts are captured with their page", () => {
  const facts = extractFacts(blocks);
  assert.deepEqual(facts.money.map((m) => [m.text, m.page]), [["SAR 4,250,000", 2]]);
});

test("project references are reported, never resolved to a project", () => {
  const facts = extractFacts(blocks);
  assert.deepEqual(facts.projectRefs, ["PRJ-1001"]);
  assert.equal(typeof facts.projectRefs[0], "string",
    "a reference is a string, not a link -- attaching is out of scope by design");
  assert.equal(facts.projectRefs[0].projectId, undefined);
});

test("the same reference written twice is reported once", () => {
  const facts = extractFacts([
    { type: "paragraph", text: "PRJ-1001 slipped; PRJ-2002 is on track.", page: 1, level: null },
    { type: "paragraph", text: "PRJ-1001 needs a decision.", page: 2, level: null },
  ]);
  assert.deepEqual(facts.projectRefs, ["PRJ-1001", "PRJ-2002"],
    "a reference repeated across pages is one reference, not two");
});

test("a document with no pages carries page null, and never a page 0", () => {
  /* .docx and .txt have no pages before rendering, so every block arrives with
     page: null. A 0 here would read as a real page number in the briefing. */
  const facts = extractFacts([
    { type: "paragraph", text: "Approved SAR 6,000,000 on 2026-11-15.", page: null, level: null },
  ]);
  assert.equal(facts.dates.length, 1);
  assert.equal(facts.dates[0].page, null);
  assert.equal(facts.money.length, 1);
  assert.equal(facts.money[0].page, null);
});

test("a number-word-year run that is not a date is not treated as one", () => {
  const facts = extractFacts([{ type: "paragraph", text: "Slipped 3 weeks 2026.", page: 1, level: null }]);
  assert.deepEqual(facts.dates, []);
});

test("a document with no facts yields empty arrays, not nulls", () => {
  const facts = extractFacts([{ type: "paragraph", text: "Nothing here.", page: 1, level: null }]);
  assert.deepEqual(facts, { dates: [], money: [], projectRefs: [] });
});
