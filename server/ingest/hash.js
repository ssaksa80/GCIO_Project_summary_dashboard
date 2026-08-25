/**
 * Content hashes.
 *
 * Two questions, two hashes:
 *   hashBytes   — have I already ingested this exact file?
 *   hashProject — has this project actually changed, or was the workbook
 *                 merely re-saved?
 *
 * hashProject deliberately hashes a fixed field list rather than the whole
 * object: a field added to the pipeline later must not silently invalidate
 * every project's history. Adding a field here is a conscious act.
 */
import crypto from "node:crypto";

/**
 * @param {Buffer} buffer
 * @returns {string} lower-case sha256 hex digest
 * @throws {TypeError} if buffer is not a Buffer (strings and other types can re-encode differently and corrupt vault storage)
 */
export function hashBytes(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError(`hashBytes requires a Buffer, got ${typeof buffer}`);
  }
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/* The fields that mean something to a reader of the dashboard. sourceFile is
   absent on purpose: moving a project between workbooks is not a change to it. */
export const HASHED_FIELDS = [
  "id", "name", "description", "department", "pillar", "program", "parentId",
  "owner", "sponsor", "vendor", "status", "health", "priority", "phase",
  "approvalDate", "startDate", "targetEndDate", "actualEndDate",
  "budget", "spent", "percentComplete", "currency", "lastUpdated",
];

export const HASHED_CHILDREN = ["milestones", "updates", "risks", "questions"];

/** Stable JSON: keys sorted, so two equal objects always serialise identically. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * @param {object} project a normalised project with ISO date strings (not Date objects),
 *                 finite numbers (not NaN or Infinity), and the fields from normalizeProjectRow.
 *                 A Date object or non-finite number will hash differently from its normalized
 *                 equivalent, silently creating separate history entries for the same content.
 * @returns {string} sha256 over its meaningful content
 */
export function hashProject(project) {
  const subject = {};
  for (const field of HASHED_FIELDS) subject[field] = project[field] ?? null;

  for (const kind of HASHED_CHILDREN) {
    /* Sorted by their serialised form: the order rows happen to sit in a
       sheet is not a change to the project. */
    subject[kind] = (project[kind] || []).map(stable).sort();
  }
  return crypto.createHash("sha256").update(stable(subject)).digest("hex");
}
