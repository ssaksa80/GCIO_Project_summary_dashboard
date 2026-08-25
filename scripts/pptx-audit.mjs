/**
 * Audit a .pptx for text that overflows its box or collides with another box.
 *
 * PowerPoint wraps text at render time, so a writer that mis-estimates height
 * produces slides where sentences sit on top of each other. This re-measures
 * every text shape in the finished file and reports:
 *
 *   OVERFLOW  the text needs more lines than its box has room for
 *   COLLISION two text boxes overlap on screen
 *   LINEFEED  an <a:t> run holds a raw line feed, which OOXML does not treat
 *             as a break -- PowerPoint renders the surrounding lines run
 *             together with no separating space. Geometry cannot catch this:
 *             the box is already sized for the extra line, so nothing overlaps.
 *
 *   node scripts/pptx-audit.mjs exports/deck.pptx
 *
 * Exits non-zero when anything is reported, so it can gate a build.
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const EMU_PER_INCH = 914400;
const PT_PER_INCH = 72;
const CHAR_RATIO = 0.52;
const BOLD_RATIO = 0.56;
/* Allow a little slack: the estimate is deliberately conservative, and a few
   points of overshoot are invisible on a rendered slide. */
const SLACK_IN = 0.06;

/** Minimal reader for the store/deflate entries a .pptx contains. */
function readZip(buffer) {
  const files = new Map();
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("not a zip file");
  const count = buffer.readUInt16LE(end + 10);
  let ptr = buffer.readUInt32LE(end + 16);

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOffset = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString("utf8", ptr + 46, ptr + 46 + nameLen);

    const lnLen = buffer.readUInt16LE(localOffset + 26);
    const leLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lnLen + leLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const attr = (tag, name) => {
  const m = new RegExp(`${name}="(-?\\d+)"`).exec(tag);
  return m ? Number(m[1]) : null;
};

/** Pull every text-bearing shape's box and runs out of one slide's XML. */
function shapesOf(xml) {
  const out = [];
  for (const sp of xml.split("<p:sp>").slice(1)) {
    const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(sp);
    const ext = /<a:ext cx="(-?\d+)" cy="(-?\d+)"\/>/.exec(sp);
    if (!off || !ext) continue;

    const runs = [];
    for (const run of sp.split("<a:r>").slice(1)) {
      const text = /<a:t>([\s\S]*?)<\/a:t>/.exec(run);
      if (!text) continue;
      const rPr = /<a:rPr[^>]*>/.exec(run);
      runs.push({
        text: text[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"),
        size: rPr ? attr(rPr[0], "sz") || 1400 : 1400,
        bold: rPr ? /b="1"/.test(rPr[0]) : false,
      });
    }
    if (!runs.length) continue;

    out.push({
      x: Number(off[1]) / EMU_PER_INCH,
      y: Number(off[2]) / EMU_PER_INCH,
      w: Number(ext[1]) / EMU_PER_INCH,
      h: Number(ext[2]) / EMU_PER_INCH,
      noWrap: /wrap="none"/.test(sp),
      runs,
    });
  }
  return out;
}

/** Height the runs actually need inside the shape's width. */
function neededHeight(shape) {
  let total = 0;
  for (const run of shape.runs) {
    const sizePt = run.size / 100;
    const perLine = Math.max(4, Math.floor((shape.w * PT_PER_INCH) / (sizePt * (run.bold ? BOLD_RATIO : CHAR_RATIO))));
    const lines = shape.noWrap ? 1 : Math.max(1, Math.ceil(run.text.length / perLine));
    total += (lines * sizePt * 1.22) / PT_PER_INCH;
  }
  return total;
}

const overlaps = (a, b) => {
  const ax2 = a.x + a.w;
  const ay2 = a.y + Math.max(a.h, neededHeight(a));
  const bx2 = b.x + b.w;
  const by2 = b.y + Math.max(b.h, neededHeight(b));
  const xOverlap = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const yOverlap = Math.min(ay2, by2) - Math.max(a.y, b.y);
  return xOverlap > 0.05 && yOverlap > 0.04;
};

const label = (shape) => shape.runs.map((r) => r.text).join(" ").slice(0, 58);

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/pptx-audit.mjs <file.pptx>");
  process.exit(2);
}

const zip = readZip(readFileSync(file));
const slideNames = [...zip.keys()]
  .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

let problems = 0;
for (const name of slideNames) {
  const n = name.match(/\d+/)[0];
  const shapes = shapesOf(zip.get(name).toString("utf8"));

  for (const shape of shapes) {
    const need = neededHeight(shape);
    if (need > shape.h + SLACK_IN) {
      problems += 1;
      console.log(`slide ${n}  OVERFLOW   needs ${need.toFixed(2)}in in a ${shape.h.toFixed(2)}in box — "${label(shape)}"`);
    }

    for (const run of shape.runs) {
      if (!run.text.includes("\n")) continue;
      problems += 1;
      console.log(`slide ${n}  LINEFEED   run holds a raw line feed and will render run together — "${label(shape)}"`);
    }
  }

  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      if (!overlaps(shapes[i], shapes[j])) continue;
      problems += 1;
      console.log(`slide ${n}  COLLISION  "${label(shapes[i])}"  ⟷  "${label(shapes[j])}"`);
    }
  }
}

console.log(`\n${slideNames.length} slides audited — ${problems} problem${problems === 1 ? "" : "s"}.`);
process.exit(problems ? 1 : 0);
