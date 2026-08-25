/**
 * The workbook vault.
 *
 * Every ingested file is copied here before it is parsed, named by content
 * hash. Two reasons, both learned the hard way in systems like this:
 *
 *   - a parser bug is recoverable. Fix the parser, replay the vault, and the
 *     portfolio is rebuilt without asking anyone to re-send last month's files.
 *   - "what did the workbook actually say on the 12th" is answerable.
 *
 * Files are filed by year and month so no single directory grows without
 * bound, and identical bytes are stored once.
 */
import fs from "node:fs";
import path from "node:path";
import { hashBytes } from "./ingest/hash.js";
import { randomUUID } from "node:crypto";

/**
 * @param {string} root vault directory
 * @param {{logger?: object}} [options]
 */
export function createVault(root, { logger = console } = {}) {
  return {
    root,

    /**
     * Copy bytes into the vault.
     * @param {Buffer} buffer
     * @param {string} originalName used only for its extension
     * @param {{at?: Date}} [options]
     * @returns {{hash: string, vaultPath: string, bytes: number}} vaultPath is relative to the root
     */
    store(buffer, originalName, { at = new Date() } = {}) {
      const hash = hashBytes(buffer);
      const ext = path.extname(originalName).toLowerCase() || ".bin";
      const year = String(at.getUTCFullYear());
      const month = String(at.getUTCMonth() + 1).padStart(2, "0");
      const relative = path.posix.join(year, month, `${hash}${ext}`);
      const absolute = path.join(root, year, month, `${hash}${ext}`);

      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        /* Identical bytes are the same file; writing again would be pointless
           churn on a folder that only ever grows. */
        if (!fs.existsSync(absolute)) {
          /* Unique per call: two processes storing the same bytes must not
             share a temp path, or one can rename the other's half-written
             file into place. The rename itself is atomic, and the destination
             is named by content hash, so last-writer-wins is safe. */
          const tmp = `${absolute}.${process.pid}.${randomUUID()}.writing`;
          try {
            fs.writeFileSync(tmp, buffer);
            fs.renameSync(tmp, absolute);
          } catch (err) {
            /* Unique temp names never get overwritten by a later attempt, so
               a failed write must clean up after itself or it leaks forever.
               Untested on purpose: reaching this needs writeFileSync to succeed
               and renameSync to fail, which cannot be provoked portably without
               adding an injection seam that would cost more than it proves. */
            try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
            throw err;
          }
        }
      } catch (err) {
        logger.error?.(`[vault] could not store ${originalName}: ${err.message}`);
        throw new Error(`vault write failed for ${originalName}: ${err.message}`);
      }

      return { hash, vaultPath: relative, bytes: buffer.length };
    },

    /**
     * @param {string} hash
     * @param {string} ext including the dot
     * @returns {Buffer|null} null when the vault does not hold it
     * @throws when the vault exists but cannot be read — a recovery tool must
     *         never report a permissions failure as "the data is gone"
     */
    read(hash, ext) {
      let years;
      try {
        years = fs.readdirSync(root);
      } catch (err) {
        if (err.code === "ENOENT") return null;   // nothing stored yet
        logger.error?.(`[vault] cannot read ${root}: ${err.message}`);
        throw err;
      }

      for (const year of years) {
        let months;
        try {
          months = fs.readdirSync(path.join(root, year));
        } catch {
          continue;   // a stray file where a year directory should be
        }
        for (const month of months) {
          const candidate = path.join(root, year, month, `${hash}${ext}`);
          if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
        }
      }
      return null;
    },
  };
}
