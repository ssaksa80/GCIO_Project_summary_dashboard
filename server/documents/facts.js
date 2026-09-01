/**
 * The parts of a document that can be read off it without interpretation.
 *
 * Deliberately narrow. Anything that would need judgement -- who owns this,
 * is it going well, which project is it really about -- is not here, because
 * this pipeline has no model that could answer it and a plausible guess is
 * worse than an absence. Project references are reported as the strings they
 * are and never resolved to a project: a wrong attachment puts misleading
 * evidence under a real project.
 *
 * `page` is carried through exactly as the block gave it, which for .docx and
 * .txt is null. It is never defaulted to a number -- a 0 would read as a real
 * page in the briefing.
 */
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const LONG_DATE = /\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/g;
const MONEY = /\b(SAR|USD|EUR|GBP)\s?([\d,]+(?:\.\d{2})?)\b/g;
const PROJECT_REF = /\bPRJ-\d+\b/g;

const pad = (n) => String(n).padStart(2, "0");

/**
 * @param {object[]} blocks ExtractedDocument.blocks
 * @returns {{dates: object[], money: object[], projectRefs: string[]}}
 */
export function extractFacts(blocks) {
  const dates = [];
  const money = [];
  const refs = new Set();

  for (const block of blocks) {
    const { text, page } = block;

    for (const m of text.matchAll(ISO_DATE)) {
      dates.push({ iso: m[0], text: m[0], page, context: text });
    }

    for (const m of text.matchAll(LONG_DATE)) {
      const month = MONTHS[m[2].toLowerCase()];
      if (!month) continue;               // "3 weeks 2026" is not a date
      const iso = `${m[3]}-${pad(month)}-${pad(Number(m[1]))}`;
      dates.push({ iso, text: m[0], page, context: text });
    }

    for (const m of text.matchAll(MONEY)) {
      money.push({ text: `${m[1]} ${m[2]}`, currency: m[1], amount: m[2], page });
    }

    /* A Set, so a reference repeated across a document is one reference. */
    for (const m of text.matchAll(PROJECT_REF)) refs.add(m[0]);
  }

  return { dates, money, projectRefs: [...refs] };
}
