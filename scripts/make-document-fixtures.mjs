/**
 * Generates the committed document fixtures. Run once; commit the output.
 *
 * PDFs are printed by headless Chrome because that is what real PDFs look
 * like -- subset fonts and compressed content streams -- which is exactly the
 * case a hand-rolled extractor fails on and pdfjs handles.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/documents");
const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const REPORT = `<html><body style="font-family:Georgia,serif">
<h1>Digital Identity Programme &mdash; Status Report</h1>
<p>Reporting period: 1 July 2026 to 31 July 2026. Owner: Directorate of Digital Services.</p>
<h2>Risks</h2>
<p>The vendor integration milestone for PRJ-1001 slipped by three weeks. Budget consumed
to date is SAR 4,250,000 of an approved SAR 6,000,000.</p>
<h2>Decisions required</h2>
<p>Approve the revised go-live date of 15 November 2026.</p>
<table border="1"><tr><th>Milestone</th><th>Due</th><th>Status</th></tr>
<tr><td>Pilot onboarding</td><td>2026-09-30</td><td>Amber</td></tr></table>
</body></html>`;

/* A 1x1 red PNG, scaled to fill the page: a PDF with pixels and no text layer. */
const SCAN = `<html><body style="margin:0">
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
     style="width:100%;height:400px">
</body></html>`;

const exe = CANDIDATES.find((p) => fs.existsSync(p));
if (!exe) {
  console.error("No Chrome or Edge found. Install one, or edit CANDIDATES.");
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox"] });
for (const [name, html] of [["status-report.pdf", REPORT], ["scanned.pdf", SCAN]]) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: path.join(OUT, name), format: "A4", printBackground: true });
  await page.close();
  console.log(`wrote ${name}`);
}
await browser.close();

/* Not a PDF at all, but named like one: the corrupt-input case. */
fs.writeFileSync(path.join(OUT, "corrupt.pdf"), Buffer.from("%PDF-1.7\nthis is not a pdf body\n"));
console.log("wrote corrupt.pdf");

fs.writeFileSync(path.join(OUT, "status-report.md"),
  "# Digital Identity Programme\n\nThe milestone for PRJ-1001 slipped. " +
  "Budget consumed is SAR 4,250,000 by 2026-09-30.\n");
console.log("wrote status-report.md");
