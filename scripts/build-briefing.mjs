/**
 * Build the CIO theme-selection briefing as one self-contained HTML file.
 *
 * Screenshots are read from docs/screenshots and embedded as data URIs, so the
 * finished file opens from an email attachment or a shared drive with no
 * server, no internet, and no assets folder.
 *
 *   node scripts/build-briefing.mjs
 *
 * Re-shoot the screenshots first (server running on :8123):
 *   for t in obsidian platinum sapphire emerald; do
 *     chrome --headless=new --force-prefers-reduced-motion \
 *       --window-size=1680,1580 --screenshot=docs/screenshots/theme-$t.png \
 *       "http://localhost:8123/?snapshot=1&theme=$t"
 *   done
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "docs", "screenshots");
const OUTPUT = path.join(ROOT, "GCIO_Theme_Selection_Briefing.html");
const AS_OF = "23 August 2026";

const dataUri = (name) => {
  const file = path.join(SHOTS, name);
  if (!existsSync(file)) {
    console.error(`missing screenshot: ${path.relative(ROOT, file)}`);
    process.exit(1);
  }
  return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
};

/* Every identity is a different reading of the same mandated palette. */
const THEMES = [
  {
    key: "obsidian",
    letter: "A",
    name: "Obsidian",
    tag: "Midnight navy",
    badge: "Current default",
    desc: "Pantone 281 C driven almost to black, lit by the 354 C green and a 375 C highlight. "
      + "A command-centre presence — strongest in low-lit offices and on wall displays, where it reads as calm control.",
    swatches: ["#000d24", "#001a3f", "#00b140", "#97d700", "#eef4ff"],
    mood: "Calm command centre",
    setting: "Low-lit offices, wall displays",
    ground: "Near-black 281 C / 354 C green",
  },
  {
    key: "platinum",
    letter: "B",
    name: "Platinum",
    tag: "Ivory boardroom",
    desc: "Ivory ground with Pantone 281 C as the ink and header band, and a deepened 354 C for accents. "
      + "The print-adjacent formality of a bound board pack — strongest in bright rooms, on projectors, and on paper.",
    swatches: ["#f4f6fb", "#ffffff", "#00205b", "#00913a", "#31507f"],
    mood: "Board-pack formality",
    setting: "Bright rooms, projection, print",
    ground: "Ivory / 281 C ink",
  },
  {
    key: "sapphire",
    letter: "C",
    name: "Sapphire",
    tag: "Navy & gold",
    desc: "Pantone 281 C at full strength with 7408 C gold carrying the accents — ceremonial and sovereign. "
      + "The most brand-forward of the four; it holds institutional weight in stakeholder and government settings.",
    swatches: ["#001336", "#002566", "#f6be00", "#97d700", "#f0f5ff"],
    mood: "Sovereign, ceremonial",
    setting: "Stakeholder & government settings",
    ground: "281 C navy / 7408 C gold",
  },
  {
    key: "emerald",
    letter: "D",
    name: "Emerald",
    tag: "Graphite & lime",
    desc: "The neutral graphite from the secondary set as ground, with 354 C green and a 375 C lime highlight. "
      + "Modern, understated, quietly technical — it signals engineering confidence without raising its voice.",
    swatches: ["#121513", "#1d221f", "#00b140", "#97d700", "#eef4ee"],
    mood: "Modern technical",
    setting: "Day-to-day operations review",
    ground: "Graphite / 354 C green",
  },
];

const SECONDARIES = [
  ["Pantone 638 C", "#00A3E0"],
  ["Pantone 2665 C", "#9063CD"],
  ["Pantone 192 C", "#E40046"],
  ["Pantone 1575 C", "#FF8200"],
  ["Pantone 7408 C", "#F6BE00"],
  ["Neutral grey", "#414141"],
];

const FEATURES = [
  ["Live 24×7 ingestion", "Drop Excel files — single or bulk, .xlsx/.xls/.csv — into a watched folder or upload in-app; every open screen updates within a second."],
  ["Intelligent Excel reading", "Column headers, RAG values, date formats and money notation are matched across differently-authored workbooks."],
  ["The CIO's four sections", "Successes, then Questions/Risks/Issues, then Priorities, then Roadmap — on screen and in every export, in that order."],
  ["Questions that find themselves", "Questions come from the workbook where PMs write them, and are derived from portfolio state where they do not."],
  ["Full project drill-down", "Owner, sponsor, approval-to-forecast dates, budget burn, milestone timeline, risk register, update feed, and the parent→child chain."],
  ["One-click exports", "PowerPoint deck, styled Excel workbook, Word briefing, or a self-contained HTML brief — all in the same four-section order."],
];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const optionBlock = (t) => `
  <section class="option">
    <div class="opt-head">
      <span class="opt-letter">${t.letter}</span>
      <span class="opt-name">${esc(t.name)}</span>
      <span class="opt-tag">${esc(t.tag)}</span>
      ${t.badge ? `<span class="badge">${esc(t.badge)}</span>` : ""}
    </div>
    <p class="opt-desc">${esc(t.desc)}</p>
    <div class="swatches" aria-hidden="true">
      ${t.swatches.map((c) => `<span class="sw" style="background:${c}"></span>`).join("")}
    </div>
    <button type="button" class="shot" data-zoom="${t.key}">
      <img src="${dataUri(`theme-${t.key}.png`)}" alt="${esc(t.name)} — dashboard in the ${esc(t.tag.toLowerCase())} identity">
    </button>
    <p class="shot-note">${t.letter} · ${esc(t.name)} — sections 1 and 2 of the live dashboard. Click to view full size.</p>
  </section>`;

const html = `<title>GCIO Theme Selection</title>
<style>
  :root {
    --paper: #f6f6f2; --card: #fdfdfb; --well: #edeee8;
    --ink: #14160f; --ink2: #545a4b; --muted: #878d7c;
    --hairline: rgba(20, 22, 14, 0.12);
    --accent: #00205b; --gold: #7a6a1f; --good: #007a2c;
    --shadow: 0 10px 30px rgba(20, 22, 14, 0.09);
    --ui-font: Arial, Helvetica, "Liberation Sans", sans-serif;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper: #0b0f14; --card: #131820; --well: #1a2029;
      --ink: #eef1f6; --ink2: #b1b9c5; --muted: #7e8794;
      --hairline: rgba(255, 255, 255, 0.11);
      --accent: #7fb0ff; --gold: #d8bd5e; --good: #35c26a;
      --shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
      color-scheme: dark;
    }
  }
  :root[data-theme="dark"] {
    --paper: #0b0f14; --card: #131820; --well: #1a2029;
    --ink: #eef1f6; --ink2: #b1b9c5; --muted: #7e8794;
    --hairline: rgba(255, 255, 255, 0.11);
    --accent: #7fb0ff; --gold: #d8bd5e; --good: #35c26a;
    --shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
    color-scheme: dark;
  }
  :root[data-font="arial"] { --ui-font: Arial, Helvetica, "Liberation Sans", sans-serif; }
  :root[data-font="aptos"] { --ui-font: Aptos, "Aptos Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font-family: var(--ui-font); font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 54px 28px 80px; }

  .masthead { border-bottom: 1px solid var(--hairline); padding-bottom: 26px; margin-bottom: 38px; }
  .eyebrow { font-size: 11.5px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--gold); margin: 0 0 14px; }
  h1 { font-size: clamp(28px, 5vw, 40px); font-weight: 700; line-height: 1.14; margin: 0 0 14px; text-wrap: balance; letter-spacing: -0.01em; }
  .lede { max-width: 64ch; color: var(--ink2); margin: 0; }
  .lede b { color: var(--ink); font-weight: 700; }
  .meta-line { display: flex; gap: 22px; flex-wrap: wrap; margin-top: 18px; font-size: 12.5px; color: var(--muted); }

  h2 { font-size: 23px; font-weight: 700; margin: 50px 0 8px; letter-spacing: -0.01em; }
  .sub { color: var(--ink2); margin: 0 0 20px; max-width: 70ch; }

  .option { background: var(--card); border: 1px solid var(--hairline); border-radius: 14px; box-shadow: var(--shadow); padding: 24px 26px; margin-bottom: 24px; }
  .opt-head { display: flex; align-items: baseline; gap: 13px; flex-wrap: wrap; margin-bottom: 4px; }
  .opt-letter { font-weight: 700; font-size: 14px; color: var(--gold); border: 1px solid var(--hairline); border-radius: 8px; padding: 2px 10px; background: var(--well); }
  .opt-name { font-size: 21px; font-weight: 700; }
  .opt-tag { font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .badge { margin-left: auto; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--good); border: 1px solid color-mix(in srgb, var(--good) 45%, transparent); background: color-mix(in srgb, var(--good) 9%, transparent); border-radius: 999px; padding: 3px 11px; }
  .opt-desc { color: var(--ink2); margin: 6px 0 15px; max-width: 76ch; }
  .swatches { display: flex; gap: 6px; margin-bottom: 15px; }
  .sw { width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--hairline); }

  .shot { border-radius: 10px; overflow: hidden; border: 1px solid var(--hairline); cursor: zoom-in; display: block; padding: 0; width: 100%; background: none; }
  .shot img { width: 100%; display: block; }
  .shot-note { font-size: 12px; color: var(--muted); margin-top: 10px; }

  .traits { overflow-x: auto; margin-top: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; min-width: 640px; }
  th { text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); padding: 10px 14px; border-bottom: 1px solid var(--hairline); }
  td { padding: 11px 14px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
  td:first-child { font-weight: 700; white-space: nowrap; }

  .same-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 18px; }
  .same-card { background: var(--card); border: 1px solid var(--hairline); border-radius: 12px; padding: 16px 18px; }
  .same-card h3 { margin: 0 0 6px; font-size: 14px; font-weight: 700; }
  .same-card p { margin: 0; font-size: 13px; color: var(--ink2); }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 760px) { .two-col { grid-template-columns: 1fr; } }
  .two-col figure { margin: 0; }
  .two-col figcaption { font-size: 12.5px; color: var(--muted); margin-top: 8px; }

  .ratio-bar { display: flex; height: 46px; border-radius: 10px; overflow: hidden; border: 1px solid var(--hairline); margin: 18px 0 8px; }
  .ratio-bar span { display: flex; align-items: center; justify-content: center; font-size: 11.5px; font-weight: 700; letter-spacing: .04em; }
  .ratio-key { display: flex; gap: 18px; flex-wrap: wrap; font-size: 12.5px; color: var(--ink2); margin-bottom: 20px; }
  .ratio-key i { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 6px; border: 1px solid var(--hairline); font-style: normal; }
  .pal-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .pal-chip { background: var(--card); border: 1px solid var(--hairline); border-radius: 12px; overflow: hidden; }
  .pal-chip .cap { height: 52px; }
  .pal-chip .lab { padding: 10px 12px; font-size: 12px; }
  .pal-chip .lab b { display: block; font-size: 13px; }
  .pal-chip .lab code { font-size: 11.5px; color: var(--muted); }

  .fonts { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 18px; }
  @media (max-width: 760px) { .fonts { grid-template-columns: 1fr; } }
  .font-card { background: var(--card); border: 1px solid var(--hairline); border-radius: 14px; box-shadow: var(--shadow); padding: 20px 22px; text-align: left; cursor: pointer; width: 100%; color: inherit; display: block; }
  .font-card[aria-pressed="true"] { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent), var(--shadow); }
  .fc-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 9px; }
  .fc-letter { font-weight: 700; font-size: 14px; color: var(--gold); border: 1px solid var(--hairline); border-radius: 8px; padding: 2px 10px; background: var(--well); }
  .fc-name { font-size: 19px; font-weight: 700; }
  .fc-tag { font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .fc-desc { color: var(--ink2); font-size: 13.5px; margin: 0 0 13px; }
  .specimen { background: var(--well); border: 1px solid var(--hairline); border-radius: 10px; padding: 15px 17px; }
  .sp-big { font-size: 25px; font-weight: 700; line-height: 1.16; }
  .sp-mid { font-size: 14px; color: var(--ink2); margin-top: 6px; }
  .sp-num { font-size: 15px; margin-top: 9px; font-variant-numeric: tabular-nums; }
  .sp-arial { font-family: Arial, Helvetica, "Liberation Sans", sans-serif; }
  .sp-aptos { font-family: Aptos, "Aptos Display", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
  .font-live { font-size: 12.5px; color: var(--ink2); margin-top: 10px; }
  .font-live b { color: var(--ink); font-weight: 700; }
  .note { font-size: 12px; color: var(--muted); margin-top: 12px; max-width: 76ch; }

  .respond { margin-top: 52px; border: 1px solid color-mix(in srgb, var(--gold) 55%, transparent); background: color-mix(in srgb, var(--gold) 7%, transparent); border-radius: 14px; padding: 22px 26px; }
  .respond h2 { margin-top: 0; }
  .respond p { color: var(--ink2); max-width: 72ch; }
  .options-line { font-weight: 700; color: var(--ink); }

  footer { margin-top: 44px; padding-top: 18px; border-top: 1px solid var(--hairline); font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; }

  dialog { border: none; border-radius: 12px; padding: 0; max-width: min(96vw, 1600px); width: 96vw; background: var(--card); box-shadow: 0 30px 90px rgba(0,0,0,.5); }
  dialog::backdrop { background: rgba(8, 9, 12, 0.74); backdrop-filter: blur(4px); }
  dialog img { width: 100%; display: block; border-radius: 12px; }
  dialog .close { position: absolute; top: 10px; right: 10px; border: none; background: rgba(0,0,0,.55); color: #fff; width: 34px; height: 34px; border-radius: 9px; font-size: 15px; cursor: pointer; }
  button:focus-visible, .shot:focus-visible, .font-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

<div class="wrap">
  <header class="masthead">
    <p class="eyebrow">GCIO · Project Intelligence — Executive Briefing</p>
    <h1>Four looks for the portfolio dashboard. One decision.</h1>
    <p class="lede">
      The CIO dashboard is <b>built and running</b>: 24×7 Excel ingestion, daily-to-yearly executive summaries,
      full project drill-down, and boardroom-grade exports — all presented in your reading order:
      <b>Successes</b>, then <b>Questions, Risks &amp; Issues</b>, then <b>Priorities</b>, then <b>Roadmap</b>.
      What remains is a taste decision. All four identities below are built from the mandated brand palette,
      are <b>live in the product today</b>, and are switchable at any time; the one you choose becomes the default
      for every screen.
    </p>
    <div class="meta-line">
      <span><b>59-project</b> demonstration portfolio</span>
      <span>As of <b>${AS_OF}</b></span>
      <span>Identical data &amp; features in every option</span>
      <span>Click any screenshot to view it full-size</span>
    </div>
  </header>

  <h2>The options</h2>
  <p class="sub">Each is a complete identity — ground, accent and mood — drawn from the same mandated palette and
  the same accessibility-checked chart colours, so the numbers read identically in all four.</p>

${THEMES.map(optionBlock).join("\n")}

  <h2>At a glance</h2>
  <div class="traits">
    <table>
      <thead><tr><th>Option</th><th>Mood</th><th>Strongest setting</th><th>Ground / accent</th></tr></thead>
      <tbody>
        ${THEMES.map((t) => `<tr><td>${t.letter} · ${esc(t.name)}</td><td>${esc(t.mood)}</td><td>${esc(t.setting)}</td><td>${esc(t.ground)}</td></tr>`).join("\n        ")}
      </tbody>
    </table>
  </div>

  <h2>Identical in every option</h2>
  <p class="sub">The theme changes the dress, never the substance. Every option ships with:</p>
  <div class="same-grid">
    ${FEATURES.map(([h, p]) => `<div class="same-card"><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`).join("\n    ")}
  </div>

  <h2>The drill-down, in two of the options</h2>
  <p class="sub">Selecting any project opens its complete record — the same depth in all four identities.</p>
  <div class="two-col">
    <figure>
      <button type="button" class="shot" data-zoom="drill-obsidian">
        <img src="${dataUri("drill-obsidian.png")}" alt="Project record in the Obsidian identity">
      </button>
      <figcaption>A · Obsidian — project record, schedule analytics and timeline</figcaption>
    </figure>
    <figure>
      <button type="button" class="shot" data-zoom="drill-platinum">
        <img src="${dataUri("drill-platinum.png")}" alt="The same project record in the Platinum identity">
      </button>
      <figcaption>B · Platinum — the same record in the ivory identity</figcaption>
    </figure>
  </div>

  <h2>The typeface</h2>
  <p class="sub">A second, independent choice: the font the dashboard sets its interface, tables and exports in.
  Both are corporate-standard and already on every managed Windows desktop. Click a card to apply it to this page
  and read the difference.</p>
  <div class="fonts">
    <button type="button" class="font-card" data-font-pick="arial" aria-pressed="false">
      <span class="fc-head"><span class="fc-letter">1</span><span class="fc-name">Arial</span>
      <span class="fc-tag">Universal standard</span></span>
      <p class="fc-desc">The safest possible choice — present on every Windows, macOS, iOS, Android and Linux machine,
      and in every version of Office. Neutral, familiar, and identical everywhere the briefing is opened.</p>
      <div class="specimen sp-arial">
        <div class="sp-big">Portfolio health at a glance</div>
        <div class="sp-mid">Legacy Data Migration Factory — Red — 54 days past target</div>
        <div class="sp-num">AED 436.5M committed · 61% consumed · 59 projects</div>
      </div>
    </button>
    <button type="button" class="font-card" data-font-pick="aptos" aria-pressed="false">
      <span class="fc-head"><span class="fc-letter">2</span><span class="fc-name">Aptos</span>
      <span class="fc-tag">Microsoft 365 default</span></span>
      <p class="fc-desc">Microsoft's current default across Office and Windows — a contemporary grotesque with a taller
      x-height and cleaner figures. Matches documents authored in current Word, Excel and PowerPoint out of the box.</p>
      <div class="specimen sp-aptos">
        <div class="sp-big">Portfolio health at a glance</div>
        <div class="sp-mid">Legacy Data Migration Factory — Red — 54 days past target</div>
        <div class="sp-num">AED 436.5M committed · 61% consumed · 59 projects</div>
      </div>
    </button>
  </div>
  <p class="font-live">Currently previewing: <b id="font-current">the briefing default</b>.
    <button type="button" id="font-reset" style="background:none;border:none;color:var(--accent);cursor:pointer;font:inherit;padding:0;text-decoration:underline">Reset</button></p>
  <p class="note">Aptos ships with Microsoft 365 and recent Windows builds; on a machine without it the dashboard falls
  back to Segoe UI automatically, so the Aptos specimen may render as Segoe UI on older desktops. Arial has no such
  caveat. Whichever is chosen applies to the interface and to the PowerPoint, Word, Excel and HTML exports.</p>

  <h2>The brand palette</h2>
  <p class="sub">The mandated mix, applied across every option: <b>40% Pantone 281 C</b>, <b>40% Pantone 354 C</b> and
  <b>15% Pantone 375 C</b>, with the remaining <b>5%</b> drawn from the secondary set. Proportions govern surface area —
  grounds, headers and primary fills carry the 281/354 weight, 375 C lifts highlights, and the secondaries appear only
  as accents, categorical chart series and status marks.</p>

  <div class="ratio-bar" role="img" aria-label="Palette proportions: 40 percent Pantone 281 C, 40 percent Pantone 354 C, 15 percent Pantone 375 C, 5 percent secondary colours">
    <span style="flex:40;background:#00205B;color:#fff">281 C · 40%</span>
    <span style="flex:40;background:#00B140;color:#04220f">354 C · 40%</span>
    <span style="flex:15;background:#97D700;color:#1d2b00">375 C · 15%</span>
    <span style="flex:5;background:linear-gradient(90deg,#00A3E0,#9063CD,#E40046,#FF8200,#F6BE00,#414141)"></span>
  </div>
  <div class="ratio-key">
    <span><i style="background:#00205B"></i>Grounds, headers, primary surfaces</span>
    <span><i style="background:#00B140"></i>Accents &amp; positive states</span>
    <span><i style="background:#97D700"></i>Highlights &amp; emphasis</span>
    <span><i style="background:linear-gradient(90deg,#00A3E0,#E40046,#F6BE00)"></i>5% secondary — status &amp; series</span>
  </div>

  <h3 style="font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin:22px 0 10px">Secondary set — the final 5%</h3>
  <div class="pal-grid">
    ${SECONDARIES.map(([n, hex]) => `<div class="pal-chip"><div class="cap" style="background:${hex}"></div><div class="lab"><b>${esc(n)}</b><code>${hex === "#414141" ? "rgb(65, 65, 65) · #414141" : `≈ ${hex}`}</code></div></div>`).join("\n    ")}
  </div>
  <p class="note">Hex values are screen approximations of the coated Pantone references — print work should use the
  Pantone inks directly. The series order keeps adjacent chart colours distinguishable under colour-vision deficiency.</p>

  <section class="respond">
    <h2>How to decide</h2>
    <p>Every option is live now — the dashboard's top bar switches between them instantly, so they can be compared
    side-by-side in the product before deciding. The chosen option becomes the default identity for all users;
    individuals keep the ability to switch unless we lock it.</p>
    <p class="options-line">Reply with a letter and a number — theme A · Obsidian, B · Platinum, C · Sapphire or
    D · Emerald, plus typeface 1 · Arial or 2 · Aptos. For example: <b>C1</b>.</p>
  </section>

  <footer>
    <span>GCIO Project Intelligence · theme selection briefing</span>
    <span>Demonstration data — not actual portfolio figures</span>
  </footer>
</div>

<dialog id="zoom" aria-label="Full-size screenshot">
  <button class="close" id="zoom-close" aria-label="Close">✕</button>
  <img id="zoom-img" src="" alt="Full-size screenshot">
</dialog>

<script>
  const dlg = document.getElementById("zoom");
  const zoomImg = document.getElementById("zoom-img");
  document.querySelectorAll("[data-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => {
      zoomImg.src = btn.querySelector("img").src;
      dlg.showModal();
    });
  });
  document.getElementById("zoom-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

  const NAMES = { arial: "Arial", aptos: "Aptos" };
  const label = document.getElementById("font-current");
  const cards = document.querySelectorAll("[data-font-pick]");
  function applyFont(f) {
    if (f) document.documentElement.setAttribute("data-font", f);
    else document.documentElement.removeAttribute("data-font");
    label.textContent = f ? NAMES[f] : "the briefing default";
    cards.forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.fontPick === f)));
  }
  cards.forEach((c) => c.addEventListener("click", () => applyFont(c.dataset.fontPick)));
  document.getElementById("font-reset").addEventListener("click", () => applyFont(null));
</script>
`;

writeFileSync(OUTPUT, html);
console.log(`built ${path.relative(ROOT, OUTPUT)} — ${(html.length / 1048576).toFixed(2)} MB, ${THEMES.length} themes + 2 drill-downs embedded`);
