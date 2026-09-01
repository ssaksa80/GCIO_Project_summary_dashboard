import test from "node:test";
import assert from "node:assert/strict";
import { summariseDocument } from "../../server/documents/summarise.js";

const blocks = [
  { type: "heading", text: "Status", page: 1, level: 1 },
  { type: "paragraph", text: "This document was prepared by the team.", page: 1, level: null },
  { type: "paragraph", text: "The integration milestone is amber and slipped to 2026-11-15.", page: 1, level: null },
  { type: "paragraph", text: "Spend reached SAR 4,250,000 against an approved budget.", page: 2, level: null },
];

test("selected sentences are verbatim from the document", () => {
  const picked = summariseDocument(blocks, { max: 2 });
  assert.equal(picked.length, 2, "a fixture that selects nothing proves nothing about verbatimness");
  const source = blocks.map((b) => b.text).join(" ");
  for (const s of picked) {
    assert.ok(source.includes(s.text), `"${s.text}" is not verbatim from the document`);
  }
});

test("sentences carrying risk vocabulary and figures outrank filler", () => {
  const picked = summariseDocument(blocks, { max: 2 });
  const text = picked.map((s) => s.text).join(" ");
  assert.match(text, /amber and slipped/);
  assert.doesNotMatch(text, /prepared by the team/,
    "filler must lose to a sentence carrying status vocabulary and a date");

  /* Vocabulary alone, on a document with no figure in it at all. Without this
     the assertions above are carried entirely by HAS_FIGURE and the whole
     vocabulary could be emptied with nothing noticing. */
  const noFigures = summariseDocument([
    { type: "paragraph", text: "This document was prepared by the team.", page: 1, level: null },
    { type: "paragraph", text: "The integration milestone is amber and has slipped.", page: 1, level: null },
  ], { max: 1 });
  assert.deepEqual(noFigures.map((s) => s.text), ["The integration milestone is amber and has slipped."]);
});

test("each selection carries the page and the heading it came from", () => {
  const headed = [
    { type: "paragraph", text: "The integration milestone is amber and slipped to 2026-11-15.", page: 1, level: null },
    { type: "heading", text: "Decisions required", page: 2, level: 2 },
    { type: "paragraph", text: "Approve the revised budget of SAR 6,000,000.", page: 2, level: null },
  ];
  const picked = summariseDocument(headed, { max: 3 });

  assert.equal(picked.length, 2, "a heading labels what follows; it is not a sentence to quote");
  assert.equal(picked[0].page, 1);
  assert.equal(picked[0].heading, null, "text before the first heading has no heading, and inventing one would misattribute it");
  assert.equal(picked[1].page, 2);
  assert.equal(picked[1].heading, "Decisions required");
});

test("results keep document order, not score order", () => {
  const picked = summariseDocument(blocks, { max: 3 });
  assert.equal(picked.length, 3);

  /* Not page order: on a one-page document every page is equal and comparing
     pages would assert nothing. Compare against where each sentence actually
     sits in the source. */
  const prose = blocks.filter((b) => b.type === "paragraph").map((b) => b.text);
  const positions = picked.map((s) => prose.findIndex((t) => t.includes(s.text)));
  assert.ok(positions.every((p) => p >= 0), "every selection must be traceable to a block");
  assert.deepEqual(positions, [0, 1, 2]);

  /* And the highest scorer must NOT be first, or document order and score
     order would be indistinguishable here. */
  assert.equal(Math.max(...picked.map((s) => s.score)), picked[1].score,
    "the best-scoring sentence is the middle one, so first-by-score would be visible");
  assert.match(picked[0].text, /prepared by the team/);
});

test("document order still holds when nothing has a page (text and Word)", () => {
  const paged = blocks.map((b) => ({ ...b, page: null }));
  const picked = summariseDocument(paged, { max: 2 });

  assert.deepEqual(picked.map((s) => s.page), [null, null],
    "a text or Word document has no pages, and 0 would be a lie");
  assert.deepEqual(picked.map((s) => s.text), [paged[2].text, paged[3].text]);
});

test("a document with no prose yields nothing rather than padding", () => {
  assert.deepEqual(summariseDocument([], { max: 3 }), []);
});

test("a fragment loses to a whole sentence saying the same thing", () => {
  const fragment = "Amber risk.";
  assert.ok(fragment.split(/\s+/).length < 4, "the fixture must actually sit below the band");

  const picked = summariseDocument([
    { type: "paragraph", text: fragment, page: 1, level: null },
    { type: "paragraph", text: "The delivery milestone is late.", page: 1, level: null },
  ], { max: 1 });

  assert.deepEqual(picked.map((s) => s.text), ["The delivery milestone is late."],
    "two signal words in a two-word stub must not outrank a readable sentence");
});

test("a run-on loses to a sentence short enough to read", () => {
  const rambling =
    "The programme is amber because the vendor has still not confirmed the integration plan " +
    "and the team continues to wait for an answer ".repeat(6) +
    "which is why the milestone slipped.";
  assert.ok(rambling.split(/\s+/).length > 60, "the fixture must actually sit above the band");

  const picked = summariseDocument([
    { type: "paragraph", text: rambling, page: 1, level: null },
    { type: "paragraph", text: "The budget forecast is SAR 4,250,000.", page: 1, level: null },
  ], { max: 1 });

  assert.deepEqual(picked.map((s) => s.text), ["The budget forecast is SAR 4,250,000."],
    "a paragraph-long sentence is not a quotable one however much vocabulary it carries");
});

test("a sentence carrying a figure outranks the same claim without one", () => {
  const picked = summariseDocument([
    { type: "paragraph", text: "The budget position is being reviewed by finance.", page: 1, level: null },
    { type: "paragraph", text: "The budget position is SAR 4,250,000 as at 2026-09-30.", page: 1, level: null },
  ], { max: 1 });

  assert.deepEqual(picked.map((s) => s.text), ["The budget position is SAR 4,250,000 as at 2026-09-30."]);
});

test("the workbook's own status words count, spelt the way prose spells them", () => {
  /* "on hold" and "missed" are ingest's own On Hold and Overdue vocabulary.
     Filler is first so that a set which does not recognise them would win the
     tie on document order and this test would notice. */
  const picked = summariseDocument([
    { type: "paragraph", text: "The team met again to review the document.", page: 1, level: null },
    { type: "paragraph", text: "The programme was put on hold in July.", page: 1, level: null },
    { type: "paragraph", text: "The vendor missed the go-live date.", page: 1, level: null },
  ], { max: 2 });

  assert.deepEqual(picked.map((s) => s.text), [
    "The programme was put on hold in July.",
    "The vendor missed the go-live date.",
  ]);
});

test("fragments that score nothing are dropped rather than padding the result", () => {
  const picked = summariseDocument(
    [{ type: "paragraph", text: "The integration milestone slipped. Ok. Fine.", page: 1, level: null }],
    { max: 6 },
  );
  assert.deepEqual(picked.map((s) => s.text), ["The integration milestone slipped."],
    "max is a ceiling, not a quota to fill");
});
