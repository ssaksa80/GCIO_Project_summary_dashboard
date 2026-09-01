/**
 * Extractive summary: selection, not authorship.
 *
 * There is no language model here and none is wanted -- document content must
 * not leave this network. So nothing is written. Sentences already in the
 * document are scored, the best are kept verbatim, and each carries the page
 * or heading it came from so a reader can go and check it.
 *
 * The vocabulary below is the vocabulary server/ingest.js already recognises --
 * health (HEALTHS, HEALTH_ALIASES), project status (STATUSES, STATUS_ALIASES),
 * milestone status (MILESTONE_STATUS_ALIASES) and compliance
 * (POSTURE_STATUSES) -- written the way a document writes it rather than the
 * way a spreadsheet cell does. Ingest squashes a cell to "onhold" before
 * matching it, so prose needs "hold"; ingest never sees "at risk" spelt with a
 * space, so prose needs both spellings. A second, divergent list of "important
 * words" would drift from the terms the rest of the dashboard reasons about.
 *
 * Those constants are not exported from ingest.js and this module deliberately
 * does not reach into it: nothing about summarising a document should be able
 * to change how a workbook is parsed.
 *
 * Honest limitation: on a document with no prose structure this surfaces and
 * orders rather than condenses. The UI says "Extracted from the document", not
 * "Summary", so nobody is told a machine understood it.
 */

const SIGNAL = new Set([
  /* Health: HEALTHS and HEALTH_ALIASES. */
  "red", "amber", "green", "critical",
  "atrisk", "at-risk", "offtrack", "off-track",
  /* Project status: STATUSES and STATUS_ALIASES. "hold" as well as "on-hold",
     because a document writes "on hold" and the tokeniser below sees that as
     two words, neither of which is "on-hold". */
  "completed", "cancelled", "hold", "on-hold",
  /* Milestone status: the Overdue aliases, which are what a status report
     actually says when a date has moved. */
  "milestone", "overdue", "slipped", "slippage", "delayed", "late", "missed",
  /* Compliance: POSTURE_STATUSES. */
  "compliant", "non-compliant", "partial",
  /* Risks, decisions and money -- the columns the workbook already carries
     (risk severity, decisionRequired/openQuestion, budget and spend). */
  "risk", "risks", "issue", "issues", "blocked", "blocker",
  "decision", "decisions", "approve", "approval",
  "budget", "spend", "overspend", "forecast",
]);

const HAS_FIGURE = /\b\d{4}-\d{2}-\d{2}\b|\b(SAR|USD|EUR|GBP)\s?[\d,]+|\b\d{1,2}\s+[A-Za-z]+\s+\d{4}\b/;

/* The same definition of a word every adapter uses for wordCount. The signal
   tokeniser below cannot do this job: it matches [a-z-]+, so the hyphens in
   "2026-11-15" would count as two words and a date would pad a sentence past
   the short end of the length band. */
const countWords = (text) => (text.match(/\S+/g) || []).length;

/* Split on sentence enders followed by whitespace. Deliberately simple: an
   abbreviation may split a sentence early, which costs a slightly clipped
   quote and never a wrong one. */
const sentencesOf = (text) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

function score(sentence, indexInBlock) {
  let n = 0;
  const words = sentence.toLowerCase().match(/[a-z-]+/g) || [];
  for (const w of words) if (SIGNAL.has(w)) n += 2;
  if (HAS_FIGURE.test(sentence)) n += 2;
  if (indexInBlock === 0) n += 1;
  /* A fragment is too short to stand alone as a quote and a run-on is too long
     to read in a briefing; both are worse evidence than a plain sentence. */
  const count = countWords(sentence);
  if (count < 4 || count > 60) n -= 2;
  return n;
}

/**
 * @param {object[]} blocks ExtractedDocument.blocks
 * @param {{max?: number}} [options]
 * @returns {{text: string, page: number|null, heading: string|null, score: number}[]}
 */
export function summariseDocument(blocks, { max = 6 } = {}) {
  const candidates = [];
  let heading = null;
  let order = 0;

  for (const block of blocks) {
    /* A heading is a label for what follows, not a sentence to quote. */
    if (block.type === "heading") { heading = block.text; continue; }
    const sentences = sentencesOf(block.text);
    for (let i = 0; i < sentences.length; i++) {
      candidates.push({
        text: sentences[i],
        page: block.page,
        heading,
        score: score(sentences[i], i),
        order: order++,
      });
    }
  }

  return candidates
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    /* Back into document order: a briefing reads as a document, not a chart. */
    .sort((a, b) => a.order - b.order)
    .map(({ text, page, heading: h, score: s }) => ({ text, page, heading: h, score: s }));
}
