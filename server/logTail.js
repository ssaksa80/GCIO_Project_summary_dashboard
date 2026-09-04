/**
 * The tail of a service log, for the admin console's Logs screen.
 *
 * The service wrapper writes stdout and stderr to files that rotate at a size
 * threshold, so they reach tens of megabytes between rotations. Reading one
 * whole to show the last hundred lines would allocate the entire file, stall
 * the request, and on a large log risk the process. This reads from the END.
 *
 * The files also contain NUL bytes: the wrapper writes UTF-16LE while the app
 * writes UTF-8, so a naive read produces text with a NUL between every
 * character that renders as blank in a browser and matches no search. Stripping
 * them is what makes the screen legible at all, and it is why "just cat the
 * file" was never enough.
 */
import fs from "node:fs";
import path from "node:path";

/** Where the wrapper puts them, relative to the install directory. */
const LOG_FILES = {
  out: "service-out.log",
  err: "service-err.log",
  deploy: "deploy.log",
};

export const LOG_NAMES = Object.keys(LOG_FILES);

/**
 * @param {{which: string, lines: number, dir?: string}} opts
 * @returns {Promise<{which: string, file: string|null, exists: boolean, sizeBytes: number|null,
 *   modifiedAt: string|null, lines: string[], truncated: boolean, available: string[]}>}
 */
export async function readServiceLog({ which = "out", lines = 300, dir } = {}) {
  const name = LOG_FILES[which] ? which : "out";
  /* Default relative to the app root's parent, which is the install directory
     on a bundle layout (<install>/app -> <install>/logs). A dev checkout has no
     logs/ and the screen says so rather than erroring. */
  const base = dir || path.resolve(process.cwd(), "logs");
  const file = path.join(base, LOG_FILES[name]);

  const result = {
    which: name, file, exists: false, sizeBytes: null, modifiedAt: null,
    lines: [], truncated: false, available: LOG_NAMES,
  };

  let stat;
  try { stat = await fs.promises.stat(file); }
  catch { return result; }

  result.exists = true;
  result.sizeBytes = stat.size;
  result.modifiedAt = stat.mtime.toISOString();
  if (stat.size === 0) return result;

  /* Read a window from the end rather than the whole file. 512 KB holds far
     more than 2000 lines of this application's output; if it does not, the
     result is flagged truncated rather than silently short. */
  const WINDOW = 512 * 1024;
  const start = Math.max(0, stat.size - WINDOW);
  const fh = await fs.promises.open(file, "r");
  let buf;
  try {
    buf = Buffer.alloc(Math.min(WINDOW, stat.size));
    await fh.read(buf, 0, buf.length, start);
  } finally {
    await fh.close();
  }

  /* NULs out, CR out, then split. The wrapper's UTF-16LE and the app's UTF-8
     are interleaved in one file; dropping the NUL bytes is what turns that
     into readable text. */
  const text = buf.toString("utf8").replace(/\0/g, "").replace(/\r/g, "");
  const all = text.split("\n");
  /* A window that did not start at byte 0 almost certainly begins mid-line. */
  if (start > 0 && all.length) all.shift();

  const wanted = Math.max(1, Math.min(2000, Number(lines) || 300));
  result.truncated = start > 0 || all.length > wanted;
  result.lines = all.filter((l) => l.length).slice(-wanted);
  return result;
}
