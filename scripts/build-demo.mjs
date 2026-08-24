/**
 * Build the standalone demo file.
 *
 * The demo has to work from a file:// path with no server, so it cannot import
 * modules. This inlines shared/pptx-lite.mjs (the same engine the server uses)
 * into the page, keeping one source of truth for the PowerPoint output.
 *
 *   node scripts/build-demo.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "demo", "demo-source.html");
const ENGINE = path.join(ROOT, "shared", "pptx-lite.mjs");
const OUTPUT = path.join(ROOT, "GCIO_Dashboard_Redesign_Demo.html");
const MARKER = "/* __PPTX_ENGINE__ */";

const engine = readFileSync(ENGINE, "utf8")
  .replace(/^export const /gm, "const ")
  .replace(/^export function /gm, "function ");

const source = readFileSync(SOURCE, "utf8");
if (!source.includes(MARKER)) {
  console.error(`demo source is missing the ${MARKER} marker`);
  process.exit(1);
}

const out = source.replace(MARKER, engine);
writeFileSync(OUTPUT, out);
console.log(`built ${path.relative(ROOT, OUTPUT)} — ${(out.length / 1024).toFixed(1)} kB (engine inlined: ${(engine.length / 1024).toFixed(1)} kB)`);
