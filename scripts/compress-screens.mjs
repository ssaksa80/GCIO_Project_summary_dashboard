/** Re-encode capture PNGs to 1600px-wide JPEGs for the demo page. */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { findBrowser } from "../test/ui/harness.mjs";

const DIR = process.argv[2];
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".png"));

const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: "new",
});
const page = await browser.newPage();

for (const f of files) {
  const b64 = fs.readFileSync(path.join(DIR, f)).toString("base64");
  const jpeg = await page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${data}`; });
    const w = 1600;
    const h = Math.round((img.height / img.width) * w);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.86);
  }, b64);
  const out = path.join(DIR, f.replace(".png", ".jpg"));
  fs.writeFileSync(out, Buffer.from(jpeg.split(",")[1], "base64"));
  console.log(`${f} -> ${path.basename(out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
}
await browser.close();
