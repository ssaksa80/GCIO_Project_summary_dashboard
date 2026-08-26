/** Capture GCIO dashboard screenshots for QA + the CIO theme demo. */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import { findBrowser } from "../test/ui/harness.mjs";

const OUT = process.argv[2] || "./screens";
fs.mkdirSync(OUT, { recursive: true });

const THEMES = ["obsidian", "platinum", "sapphire", "emerald"];
const BASE = "http://localhost:8123";

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: "new",
  args: ["--hide-scrollbars", "--force-device-scale-factor=2"],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });

  for (const theme of THEMES) {
    await page.evaluateOnNewDocument((t) => localStorage.setItem("gcio-theme", t), theme);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".grid-charts", { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 900)); // fonts + charts settle
    await page.screenshot({ path: `${OUT}/theme-${theme}.png` });
    console.log(`shot: theme-${theme}.png`);

    if (theme === "obsidian") {
      // full-page hero of the default theme
      await page.screenshot({ path: `${OUT}/theme-${theme}-full.png`, fullPage: true });
      console.log("shot: theme-obsidian-full.png");

      // drill-down drawer: open the first attention item
      await page.click(".attention-row");
      await page.waitForSelector(".drawer .meta-grid", { timeout: 10000 });
      await new Promise((r) => setTimeout(r, 500));
      await page.screenshot({ path: `${OUT}/drilldown.png` });
      console.log("shot: drilldown.png");
      await page.keyboard.press("Escape");
    }
    if (theme === "platinum") {
      await page.click(".attention-row");
      await page.waitForSelector(".drawer .meta-grid", { timeout: 10000 });
      await new Promise((r) => setTimeout(r, 500));
      await page.screenshot({ path: `${OUT}/drilldown-platinum.png` });
      console.log("shot: drilldown-platinum.png");
      await page.keyboard.press("Escape");
    }
  }
} finally {
  await browser.close();
}
console.log("done");
