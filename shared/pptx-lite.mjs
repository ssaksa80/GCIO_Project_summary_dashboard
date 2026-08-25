/**
 * pptx-lite — dependency-free PowerPoint (.pptx) writer.
 *
 * Produces a valid OOXML presentation package with a store-only ZIP writer, so
 * it runs unchanged in the browser (one-click export from the dashboard) and in
 * Node (server-side brief generation). No external libraries, which keeps the
 * standalone demo file self-contained and the server dependency list unchanged.
 *
 * Deck shape:
 *   { title, subtitle, footer, slides: [ Slide ] }
 * Slide:
 *   { eyebrow, title, kpis: [{lab, val, sub}], bullets: [{text, sub, tag, tone}],
 *     cover: true }
 * tone: "good" | "warn" | "bad" | "info" | "neutral"
 */

/* ---------------------------------------------------------------- palette */
/* Brand ratio: 40% Pantone 281 C, 40% 354 C, 15% 375 C, 5% secondaries. */
export const BRAND = {
  p281: "00205B",
  p281dark: "001238",
  p354: "00B140",
  p375: "97D700",
  s638: "00A3E0",
  s2665: "9063CD",
  s192: "E40046",
  s1575: "FF8200",
  s7408: "F6BE00",
  grey: "414141",
  paper: "FFFFFF",
  ink: "10233F",
  ink2: "4A5C74",
};

const TONE = {
  good: BRAND.p354,
  warn: BRAND.s7408,
  bad: BRAND.s192,
  info: BRAND.s638,
  plum: BRAND.s2665,
  neutral: BRAND.grey,
};

/* ------------------------------------------------------------------- zip */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a store-only (uncompressed) ZIP archive.
 * @param {Array<{name: string, data: Uint8Array}>} files
 * @returns {Uint8Array}
 */
export function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const crc = crc32(file.data);
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0x21), // 1980-01-01, fixed for reproducible output
      ...u32(crc), ...u32(file.data.length), ...u32(file.data.length),
      ...u16(nameBytes.length), ...u16(0),
    ];
    chunks.push(Uint8Array.from(local), nameBytes, file.data);
    central.push({ nameBytes, crc, size: file.data.length, offset });
    offset += local.length + nameBytes.length + file.data.length;
  }

  const dir = [];
  for (const e of central) {
    dir.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0x21),
      ...u32(e.crc), ...u32(e.size), ...u32(e.size),
      ...u16(e.nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(e.offset),
      ...Array.from(e.nameBytes)
    );
  }
  const dirBytes = Uint8Array.from(dir);
  const end = Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(dirBytes.length), ...u32(offset), ...u16(0),
  ]);

  let total = dirBytes.length + end.length;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  out.set(dirBytes, pos); pos += dirBytes.length;
  out.set(end, pos);
  return out;
}

/* ------------------------------------------------------------------ ooxml */
const EMU = 914400;
const SLIDE_W = Math.round(13.333 * EMU);
const SLIDE_H = 7.5 * EMU;

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** One text run paragraph. */
function para(text, { size = 1400, bold = false, color = BRAND.ink, spcBef = 0, italic = false } = {}) {
  return (
    `<a:p><a:pPr${spcBef ? `><a:spcBef><a:spcPts val="${spcBef}"/></a:spcBef></a:pPr` : "/"}>` +
    `<a:r><a:rPr lang="en-US" sz="${size}" b="${bold ? 1 : 0}" i="${italic ? 1 : 0}" dirty="0">` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` +
    `<a:latin typeface="Arial"/><a:cs typeface="Arial"/></a:rPr>` +
    `<a:t>${esc(text)}</a:t></a:r></a:p>`
  );
}

function textBox(id, name, x, y, w, h, paragraphs, { anchor = "t", noWrap = false } = {}) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="${noWrap ? "none" : "square"}" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}"><a:normAutofit/></a:bodyPr>` +
    `<a:lstStyle/>${paragraphs || para("")}</p:txBody></p:sp>`
  );
}

function rect(id, x, y, w, h, fill, { line = null, radius = false } = {}) {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Rect ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>` +
    `<a:prstGeom prst="${radius ? "roundRect" : "rect"}">` +
    (radius ? '<a:avLst><a:gd name="adj" fmla="val 12000"/></a:avLst>' : "<a:avLst/>") +
    "</a:prstGeom>" +
    `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` +
    (line ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>` : "<a:ln><a:noFill/></a:ln>") +
    `</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
  );
}

/* ------------------------------------------------------------ measuring */
/*
 * PowerPoint wraps text itself, but the writer has to know how tall a run will
 * end up before it can place the next one — otherwise a two-line bullet is
 * drawn over the row beneath it. These are conservative Arial estimates: they
 * over-count slightly, which costs a little whitespace and never overlaps.
 */
const PT_PER_INCH = 72;

/** Average glyph advance as a fraction of point size (Arial, mixed case). */
const CHAR_RATIO = 0.52;
const BOLD_RATIO = 0.56;

/** Estimated wrapped line count for `text` inside `widthIn` inches. */
function lineCount(text, widthIn, sizeHundredths, bold = false) {
  const body = String(text || "");
  if (!body) return 0;
  const sizePt = sizeHundredths / 100;
  const charsPerLine = Math.max(6, Math.floor((widthIn * PT_PER_INCH) / (sizePt * (bold ? BOLD_RATIO : CHAR_RATIO))));
  let lines = 0;
  for (const paragraph of body.split("\n")) {
    lines += Math.max(1, Math.ceil(paragraph.length / charsPerLine));
  }
  return lines;
}

/** Height in inches of `lines` lines at the given size, including leading. */
function textHeight(lines, sizeHundredths) {
  return (lines * (sizeHundredths / 100) * 1.22) / PT_PER_INCH;
}

/** Uppercase bold glyphs run wider than the mixed-case average. */
const CAPS_RATIO = 0.70;

/** Pill width in inches for a tag label, which is always drawn uppercase. */
function tagWidth(label, sizeHundredths = 800) {
  const sizePt = sizeHundredths / 100;
  return (String(label).length * sizePt * CAPS_RATIO) / PT_PER_INCH + 0.22;
}

/** Render one slide's shape tree. */
function slideXml(slide, index, deck) {
  const shapes = [];
  let id = 2;
  const next = () => (id += 1);

  if (slide.cover) {
    shapes.push(rect(next(), 0, 0, SLIDE_W, SLIDE_H, BRAND.p281dark));
    shapes.push(rect(next(), 0, SLIDE_H - 0.28 * EMU, SLIDE_W, 0.28 * EMU, BRAND.p354));
    shapes.push(rect(next(), 0.9 * EMU, 2.05 * EMU, 0.9 * EMU, 0.06 * EMU, BRAND.p375));
    shapes.push(textBox(next(), "eyebrow", 0.9 * EMU, 1.55 * EMU, 10 * EMU, 0.4 * EMU,
      para(slide.eyebrow || "GCIO · PROJECT INTELLIGENCE", { size: 1200, bold: true, color: BRAND.p375 })));
    const coverTitleH = textHeight(lineCount(slide.title, 11, 3600, true), 3600);
    shapes.push(textBox(next(), "title", 0.9 * EMU, 2.35 * EMU, 11 * EMU, coverTitleH * EMU,
      para(slide.title, { size: 3600, bold: true, color: "FFFFFF" })));
    if (slide.subtitle) {
      const subH = textHeight(lineCount(slide.subtitle, 11, 1600), 1600);
      /* Same contract as a bullet's .sub below: a line feed only becomes a
         visible line break if it is its own paragraph. One para() call over
         the whole string puts everything in a single <a:t> run, and OOXML
         does not treat an embedded line feed there as a break -- it renders
         the two lines run together with no separating space. */
      const subtitleParas = String(slide.subtitle).split("\n")
        .map((line) => para(line, { size: 1600, color: "B8C8E8" }))
        .join("");
      shapes.push(textBox(next(), "subtitle", 0.9 * EMU, (2.5 + coverTitleH) * EMU, 11 * EMU, subH * EMU,
        subtitleParas));
    }
    if (slide.kpis?.length) {
      const boxW = (11.5 * EMU) / slide.kpis.length - 0.18 * EMU;
      slide.kpis.forEach((k, i) => {
        const x = 0.9 * EMU + i * (boxW + 0.18 * EMU);
        shapes.push(rect(next(), x, 5.05 * EMU, boxW, 1.15 * EMU, "0A2A63", { radius: true }));
        shapes.push(textBox(next(), "kpi-lab", x + 0.2 * EMU, 5.22 * EMU, boxW - 0.4 * EMU, 0.3 * EMU,
          para(String(k.lab).toUpperCase(), { size: 900, bold: true, color: "7F95C4" })));
        const coverValSize = lineCount(k.val, (boxW / EMU) - 0.4, 2000, true) > 1 ? 1500 : 2000;
        shapes.push(textBox(next(), "kpi-val", x + 0.2 * EMU, 5.5 * EMU, boxW - 0.4 * EMU, 0.45 * EMU,
          para(k.val, { size: coverValSize, bold: true, color: "FFFFFF" })));
        if (k.sub) {
          shapes.push(textBox(next(), "kpi-sub", x + 0.2 * EMU, 5.92 * EMU, boxW - 0.4 * EMU, 0.3 * EMU,
            para(k.sub, { size: 900, color: "B8C8E8" })));
        }
      });
    }
  } else {
    /* content slide */
    shapes.push(rect(next(), 0, 0, SLIDE_W, SLIDE_H, "FFFFFF"));
    shapes.push(rect(next(), 0, 0, SLIDE_W, 1.05 * EMU, BRAND.p281));
    shapes.push(rect(next(), 0, 1.05 * EMU, SLIDE_W, 0.06 * EMU, BRAND.p354));
    if (slide.eyebrow) {
      shapes.push(textBox(next(), "eyebrow", 0.55 * EMU, 0.22 * EMU, 10 * EMU, 0.28 * EMU,
        para(slide.eyebrow.toUpperCase(), { size: 900, bold: true, color: BRAND.p375 })));
    }
    shapes.push(textBox(next(), "title", 0.55 * EMU, 0.5 * EMU, 11.4 * EMU, 0.46 * EMU,
      para(slide.title, { size: 2200, bold: true, color: "FFFFFF" })));

    let y = 1.45 * EMU;

    if (slide.kpis?.length) {
      const boxW = (12.2 * EMU) / slide.kpis.length - 0.16 * EMU;
      slide.kpis.forEach((k, i) => {
        const x = 0.55 * EMU + i * (boxW + 0.16 * EMU);
        shapes.push(rect(next(), x, y, boxW, 0.85 * EMU, "F1F5FA", { radius: true }));
        shapes.push(textBox(next(), "k", x + 0.16 * EMU, y + 0.11 * EMU, boxW - 0.32 * EMU, 0.22 * EMU,
          para(String(k.lab).toUpperCase(), { size: 800, bold: true, color: BRAND.ink2 })));
        /* Long money values shrink a step rather than spilling out of the tile. */
        const valSize = lineCount(k.val, (boxW / EMU) - 0.32, 1600, true) > 1 ? 1250 : 1600;
        shapes.push(textBox(next(), "k", x + 0.16 * EMU, y + 0.36 * EMU, boxW - 0.32 * EMU, 0.42 * EMU,
          para(k.val, { size: valSize, bold: true, color: BRAND.p281 })));
      });
      y += 1.1 * EMU;
    }

    /* Bullets are measured before they are placed, so a wrapped line pushes
       the next row down instead of being painted over it. Anything that will
       not fit is handed back to the caller for a continuation slide. */
    const titleSize = slide.dense ? 1150 : 1250;
    const subSize = slide.dense ? 950 : 1050;
    const LEFT = 0.55;
    const TEXT_LEFT = 0.78;
    const RIGHT_EDGE = 12.75;
    const BOTTOM_LIMIT = slide.note ? 6.62 : 6.92;

    const bullets = slide.bullets || [];
    const overflow = [];

    for (let i = 0; i < bullets.length; i += 1) {
      const b = bullets[i];
      const tone = TONE[b.tone] || BRAND.p354;
      const tagW = b.tag ? tagWidth(b.tag) : 0;
      const textLeft = TEXT_LEFT + (b.tag ? tagW + 0.14 : 0);
      const titleW = RIGHT_EDGE - textLeft;
      const subW = RIGHT_EDGE - TEXT_LEFT;

      const titleLines = lineCount(b.text, titleW, titleSize, true);
      const subLines = b.sub ? lineCount(b.sub, subW, subSize) : 0;
      const titleH = textHeight(titleLines, titleSize);
      const subH = subLines ? textHeight(subLines, subSize) : 0;
      const rowH = 0.08 + titleH + (subH ? subH + 0.04 : 0) + (slide.dense ? 0.13 : 0.2);

      /* Keep at least one bullet on the slide, even if it is a monster. */
      if (i > 0 && (y / EMU) + rowH > BOTTOM_LIMIT) {
        overflow.push(...bullets.slice(i));
        break;
      }

      shapes.push(rect(next(), LEFT * EMU, y + 0.05 * EMU, 0.055 * EMU, (rowH - 0.14) * EMU, tone));

      if (b.tag) {
        shapes.push(rect(next(), TEXT_LEFT * EMU, y + 0.03 * EMU, tagW * EMU, 0.24 * EMU, tone, { radius: true }));
        shapes.push(textBox(next(), "tag", (TEXT_LEFT + 0.11) * EMU, y + 0.03 * EMU, (tagW - 0.22) * EMU, 0.24 * EMU,
          para(b.tag.toUpperCase(), { size: 800, bold: true, color: "FFFFFF" }), { anchor: "ctr", noWrap: true }));
      }

      shapes.push(textBox(next(), "b", textLeft * EMU, y + 0.02 * EMU, titleW * EMU, titleH * EMU,
        para(b.text, { size: titleSize, bold: true, color: BRAND.ink })));

      if (b.sub) {
        const subParas = String(b.sub).split("\n")
          .map((line) => para(line, { size: subSize, color: BRAND.ink2 }))
          .join("");
        shapes.push(textBox(next(), "s", TEXT_LEFT * EMU, y + (0.06 + titleH) * EMU, subW * EMU, subH * EMU, subParas));
      }

      y += rowH * EMU;
    }

    if (slide.note) {
      const noteLines = lineCount(slide.note, 12.2, 900);
      const noteH = textHeight(noteLines, 900);
      shapes.push(textBox(next(), "note", 0.55 * EMU, (7.02 - noteH) * EMU, 12.2 * EMU, noteH * EMU,
        para(slide.note, { size: 900, italic: true, color: BRAND.ink2 })));
    }

    slide.__overflow = overflow;
    shapes.push(rect(next(), 0, SLIDE_H - 0.1 * EMU, SLIDE_W, 0.1 * EMU, BRAND.p354));
    shapes.push(textBox(next(), "pg", 12.35 * EMU, 0.55 * EMU, 0.5 * EMU, 0.3 * EMU,
      para(String(index), { size: 1100, bold: true, color: BRAND.p375 })));
  }

  if (deck.footer && !slide.cover) {
    shapes.push(textBox(next(), "footer", 0.55 * EMU, 7.05 * EMU, 8 * EMU, 0.28 * EMU,
      para(deck.footer, { size: 850, color: "8798AD" })));
  }

  return XML +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    shapes.join("") +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

const THEME_XML = XML +
  '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="GCIO Brand">' +
  '<a:themeElements><a:clrScheme name="GCIO">' +
  '<a:dk1><a:srgbClr val="10233F"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="00205B"/></a:dk2><a:lt2><a:srgbClr val="F1F5FA"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="00B140"/></a:accent1><a:accent2><a:srgbClr val="97D700"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="00A3E0"/></a:accent3><a:accent4><a:srgbClr val="9063CD"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="F6BE00"/></a:accent5><a:accent6><a:srgbClr val="E40046"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="00A3E0"/></a:hlink><a:folHlink><a:srgbClr val="9063CD"/></a:folHlink>' +
  '</a:clrScheme><a:fontScheme name="Arial">' +
  '<a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme><a:fmtScheme name="Office">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:fillStyleLst><a:lnStyleLst>' +
  '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
  '</a:lnStyleLst><a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '</a:effectStyleLst><a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '</a:bgFillStyleLst></a:fmtScheme></a:themeElements>' +
  '<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

const MASTER_XML = XML +
  '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
  '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
  '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>' +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
  'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="1400"/></a:lvl1pPr></p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1400"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';

const LAYOUT_XML = XML +
  '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">' +
  '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>' +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

/**
 * Build a .pptx package.
 * @param {{title: string, subtitle?: string, footer?: string, slides: Array}} deck
 * @returns {Uint8Array} pptx bytes
 */
export function buildPptx(deck) {
  const enc = new TextEncoder();
  const files = [];

  /* Lay every slide out first: a slide whose bullets do not fit spills the
     remainder onto a "(cont.)" slide, repeatedly, so nothing is ever hidden
     underneath something else or silently dropped. */
  const expanded = [];
  for (const slide of deck.slides || []) {
    let current = { ...slide };
    let guard = 0;
    for (;;) {
      const xml = slideXml(current, expanded.length + 1, deck);
      expanded.push({ ...current, __xml: xml });
      const leftover = current.__overflow || [];
      if (!leftover.length || guard > 12) break;
      guard += 1;
      current = {
        ...slide,
        title: /\(cont\.\)$/.test(current.title) ? current.title : `${slide.title} (cont.)`,
        kpis: null,
        bullets: leftover,
        __overflow: [],
      };
    }
  }
  const slides = expanded;
  const add = (name, text) => files.push({ name, data: enc.encode(text) });

  const slideOverrides = slides
    .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join("");

  add("[Content_Types].xml", XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    slideOverrides + '</Types>');

  add("_rels/.rels", XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>');

  add("docProps/core.xml", XML +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(deck.title)}</dc:title>` +
    '<dc:creator>GCIO Project Intelligence</dc:creator>' +
    '<cp:lastModifiedBy>GCIO Project Intelligence</cp:lastModifiedBy>' +
    '</cp:coreProperties>');

  add("docProps/app.xml", XML +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    `<Application>GCIO Project Intelligence</Application><Slides>${slides.length}</Slides>` +
    '</Properties>');

  const slideRels = slides
    .map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`)
    .join("");
  add("ppt/_rels/presentation.xml.rels", XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    slideRels +
    `<Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>` +
    '</Relationships>');

  const sldIds = slides
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
    .join("");
  add("ppt/presentation.xml", XML +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>` +
    '</p:presentation>');

  add("ppt/theme/theme1.xml", THEME_XML);

  add("ppt/slideMasters/slideMaster1.xml", MASTER_XML);
  add("ppt/slideMasters/_rels/slideMaster1.xml.rels", XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>');

  add("ppt/slideLayouts/slideLayout1.xml", LAYOUT_XML);
  add("ppt/slideLayouts/_rels/slideLayout1.xml.rels", XML +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
    '</Relationships>');

  expanded.forEach((slide, i) => {
    add(`ppt/slides/slide${i + 1}.xml`, slide.__xml);
    add(`ppt/slides/_rels/slide${i + 1}.xml.rels`, XML +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      '</Relationships>');
  });

  return zipStore(files);
}
