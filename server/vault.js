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
      const relative = path.join(year, month, `${hash}${ext}`);
      const absolute = path.join(root, relative);

      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        /* Identical bytes are the same file; writing again would be pointless
           churn on a folder that only ever grows. */
        if (!fs.existsSync(absolute)) {
          const tmp = `${absolute}.writing`;
          fs.writeFileSync(tmp, buffer);
          fs.renameSync(tmp, absolute);
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
     */
    read(hash, ext) {
      const candidates = [];
      try {
        for (const year of fs.readdirSync(root)) {
          for (const month of fs.readdirSync(path.join(root, year))) {
            candidates.push(path.join(root, year, month, `${hash}${ext}`));
          }
        }
      } catch {
        return null; // nothing stored yet
      }
      const found = candidates.find((p) => fs.existsSync(p));
      return found ? fs.readFileSync(found) : null;
    },
  };
}
