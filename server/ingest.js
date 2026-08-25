/**
 * Workbook ingestion: tolerant header mapping, value normalization,
 * optional child sheets (Milestones / Updates / Risks), and the 24x7
 * chokidar watcher over the data/ drop-folder (SPEC §3).
 */
import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import chokidar from "chokidar";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(customParseFormat);

export const WORKBOOK_EXTENSIONS = new Set([".xlsx", ".xlsm", ".xls", ".csv"]);

const STATUSES = ["Proposed", "Approved", "In Progress", "On Hold", "Completed", "Cancelled"];
const HEALTHS = ["Green", "Amber", "Red"];
const PRIORITIES = ["Critical", "High", "Medium", "Low"];
const PHASES = ["Initiation", "Planning", "Execution", "Monitoring", "Closure"];

/** Canonical field -> normalized header synonyms (SPEC §3). */
const SYNONYMS = {
  id: ["projectid", "id", "prjid", "projectcode", "code"],
  name: ["projectname", "name", "title"],
  department: ["department", "dept", "businessunit", "bu", "division"],
  pillar: ["strategicpillar", "pillar", "strategictheme", "theme"],
  program: ["program", "programme", "portfolio"],
  parentId: ["parentprojectid", "parentid", "parent", "parentproject"],
  owner: ["owner", "projectmanager", "pm", "projectowner", "manager"],
  sponsor: ["sponsor", "executivesponsor", "execsponsor"],
  vendor: ["vendor", "supplier", "partner"],
  status: ["status", "projectstatus"],
  health: ["health", "rag", "ragstatus", "healthstatus", "overallhealth"],
  priority: ["priority", "criticality"],
  phase: ["phase", "projectphase", "currentphase"],
  approvalDate: ["approvaldate", "approvedon", "dateapproved", "approved"],
  startDate: ["startdate", "start", "kickoffdate"],
  targetEndDate: ["targetenddate", "enddate", "targetdate", "plannedend", "duedate", "targetcompletion"],
  actualEndDate: ["actualenddate", "actualend", "completiondate", "completedon", "dateclosed"],
  budget: ["budget", "budgetaed", "approvedbudget", "totalbudget"],
  spent: ["spent", "actualspend", "spenttodate", "actuals", "consumed"],
  percentComplete: ["percentcomplete", "complete", "completion", "progress", "pctcomplete"],
  description: ["description", "summary", "scope", "objective"],
  lastUpdated: ["lastupdated", "updatedon", "lastmodified"],
  openQuestion: ["openquestion", "question", "decisionneeded", "decisionrequired", "escalation", "askofcio"],
};

const CHILD_SHEET_FIELDS = {
  milestones: {
    projectId: ["projectid", "id", "prjid", "projectcode"],
    name: ["milestone", "milestonename", "name", "title"],
    dueDate: ["duedate", "due", "targetdate", "plannedon"],
    completedDate: ["completeddate", "completedon", "completed", "actualdate"],
    status: ["status", "state"],
  },
  updates: {
    projectId: ["projectid", "id", "prjid", "projectcode"],
    date: ["date", "updatedate", "postedon"],
    author: ["author", "by", "postedby", "owner"],
    text: ["update", "text", "comment", "note", "statusupdate", "details"],
  },
  risks: {
    projectId: ["projectid", "id", "prjid", "projectcode"],
    title: ["risk", "title", "riskdescription", "description"],
    severity: ["severity", "level", "riskseverity", "rating"],
    status: ["status", "state"],
    owner: ["owner", "riskowner", "assignedto"],
  },
  questions: {
    projectId: ["projectid", "id", "prjid", "projectcode"],
    text: ["question", "openquestion", "decisionneeded", "decisionrequired", "ask", "text", "description"],
    askedBy: ["askedby", "raisedby", "author", "owner", "from"],
    raisedDate: ["raised", "raiseddate", "date", "askedon"],
    neededBy: ["neededby", "decisionby", "duedate", "requiredby", "by"],
    decisionOwner: ["decisionowner", "decisionmaker", "assignedto", "escalatedto", "with"],
    status: ["status", "state"],
  },
};

/** Posture rows describe security domains, not projects (SPEC: section 5). */
const POSTURE_FIELDS = {
  domain: ["domain", "securitydomain", "area", "capability", "pillar"],
  control: ["control", "controlname", "subdomain", "detail", "measure"],
  status: ["status", "compliance", "compliancestatus", "state", "rag"],
  score: ["score", "currentscore", "maturity", "maturityscore", "rating", "percent"],
  target: ["target", "targetscore", "goal", "requiredscore"],
  owner: ["owner", "accountable", "responsible", "lead"],
  lastAssessed: ["lastassessed", "assessed", "lastreview", "lastreviewed", "asof", "date"],
  nextReview: ["nextreview", "nextassessment", "due", "duedate", "reviewdue"],
  openFindings: ["openfindings", "findings", "openissues", "gaps"],
  criticalFindings: ["criticalfindings", "criticalgaps", "critical", "highrisk"],
  projectId: ["projectid", "remediationproject", "linkedproject", "project"],
  notes: ["notes", "comment", "commentary", "remarks", "detailnotes"],
};

const POSTURE_STATUSES = ["Compliant", "Partial", "Non-Compliant", "Not Assessed"];
const POSTURE_STATUS_ALIASES = {
  compliant: "Compliant", met: "Compliant", green: "Compliant", pass: "Compliant", good: "Compliant",
  partial: "Partial", partiallycompliant: "Partial", amber: "Partial", inprogress: "Partial", improving: "Partial",
  noncompliant: "Non-Compliant", notcompliant: "Non-Compliant", fail: "Non-Compliant", red: "Non-Compliant",
  gap: "Non-Compliant", atrisk: "Non-Compliant",
  notassessed: "Not Assessed", unknown: "Not Assessed", na: "Not Assessed", pending: "Not Assessed",
};

const normKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Find the header row. Real workbooks (and our own template) often carry a
 * title or a guidance note above the headers, so scan the first few rows and
 * keep the one that maps the most known fields.
 * @returns {{map: object, index: number, score: number}}
 */
function findHeaderRow(rows, synonyms, limit = 8) {
  let best = { map: {}, index: 0, score: -1 };
  const depth = Math.min(limit, rows.length);
  for (let i = 0; i < depth; i += 1) {
    const map = mapHeaders(rows[i], synonyms);
    const score = Object.keys(map).length;
    if (score > best.score) best = { map, index: i, score };
  }
  return best;
}

/** Build header-index -> canonical-field map for one sheet's header row. */
function mapHeaders(headerRow, synonyms) {
  const map = {};
  headerRow.forEach((header, idx) => {
    const key = normKey(header);
    if (!key) return;
    for (const [field, aliases] of Object.entries(synonyms)) {
      if (aliases.includes(key) && !(field in map)) map[field] = idx;
    }
  });
  return map;
}

// ---------- value normalization ----------

/** Coerce any supported date representation to ISO yyyy-mm-dd or null. */
export function toISO(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    const d = dayjs(value);
    return d.isValid() ? d.format("YYYY-MM-DD") : null;
  }
  if (typeof value === "number" && value > 20000 && value < 80000) {
    // Excel serial date (days since 1899-12-30)
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return dayjs(new Date(ms)).format("YYYY-MM-DD");
  }
  const text = String(value).trim();
  const formats = ["YYYY-MM-DD", "DD/MM/YYYY", "D/M/YYYY", "MM/DD/YYYY", "DD-MM-YYYY", "DD-MMM-YYYY", "D MMM YYYY", "MMM D, YYYY", "YYYY/MM/DD"];
  for (const fmt of formats) {
    const d = dayjs(text, fmt, true);
    if (d.isValid()) return d.format("YYYY-MM-DD");
  }
  const loose = dayjs(text);
  return loose.isValid() ? loose.format("YYYY-MM-DD") : null;
}

/** Parse money-ish values: "AED 1,200,000", "1.2M", 450000 -> number. */
function toMoney(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value).trim().toUpperCase();
  const suffix = /([0-9.]+)\s*([KMB])\b/.exec(text);
  if (suffix) {
    const mult = { K: 1e3, M: 1e6, B: 1e9 }[suffix[2]];
    return parseFloat(suffix[1]) * mult;
  }
  const cleaned = text.replace(/[^0-9.-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Percent: accepts 0-1 fractions or 0-100; clamps to [0,100]. */
function toPercent(value) {
  if (value === null || value === undefined || value === "") return 0;
  let n = typeof value === "number" ? value : parseFloat(String(value).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n <= 1) n *= 100;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function pickVocab(value, vocab, synonymMap, fallback) {
  const key = normKey(value);
  if (!key) return fallback;
  for (const v of vocab) if (normKey(v) === key) return v;
  for (const [canonical, aliases] of Object.entries(synonymMap)) {
    if (aliases.includes(key)) return canonical;
  }
  return fallback;
}

const STATUS_ALIASES = {
  "In Progress": ["active", "ongoing", "wip", "inflight", "executing", "underway", "inexecution", "started"],
  Completed: ["done", "closed", "complete", "delivered", "finished"],
  Proposed: ["pendingapproval", "pipeline", "draft", "submitted", "underreview", "new"],
  "On Hold": ["hold", "paused", "onhold", "suspended", "parked"],
  Approved: ["sanctioned", "greenlit", "authorised", "authorized"],
  Cancelled: ["canceled", "terminated", "stopped", "withdrawn", "descoped"],
};
const HEALTH_ALIASES = {
  Green: ["g", "ontrack", "good", "healthy", "ok"],
  Amber: ["a", "y", "yellow", "atrisk", "watch", "caution"],
  Red: ["r", "offtrack", "critical", "troubled", "bad"],
};
const MILESTONE_STATUS_ALIASES = {
  Completed: ["done", "complete", "closed", "achieved", "delivered"],
  "In Progress": ["active", "ongoing", "wip", "underway", "started"],
  Overdue: ["late", "missed", "slipped", "delayed"],
  Pending: ["notstarted", "planned", "upcoming", "open", "future"],
};
const SEVERITY_ALIASES = {
  Critical: ["veryhigh", "severe", "extreme"],
  High: ["major", "significant"],
  Medium: ["moderate", "med"],
  Low: ["minor", "trivial"],
};
const RISK_STATUS_ALIASES = {
  Open: ["active", "new", "identified", "raised"],
  Mitigating: ["inmitigation", "treating", "managed", "monitoring", "inprogress"],
  Closed: ["resolved", "done", "retired", "accepted"],
};

/** Stable id for rows that arrive without one. */
function hashId(name) {
  let h = 5381;
  const s = String(name);
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `PRJ-${h.toString(16).toUpperCase().slice(0, 6)}`;
}

const cleanText = (v) => (v === null || v === undefined ? "" : String(v).trim());

/** Normalize one raw projects-sheet row into the canonical project shape. */
function normalizeProjectRow(row, headerMap, sourceFile) {
  const cell = (field) => (field in headerMap ? row[headerMap[field]] : null);
  const name = cleanText(cell("name"));
  const rawId = cleanText(cell("id"));
  if (!rawId && !name) return null;
  const id = (rawId || hashId(name)).toUpperCase();
  const percentComplete = toPercent(cell("percentComplete"));
  const actualEndDate = toISO(cell("actualEndDate"));
  const startDate = toISO(cell("startDate"));

  let status = pickVocab(cell("status"), STATUSES, STATUS_ALIASES, null);
  if (!status) {
    if (actualEndDate || percentComplete >= 100) status = "Completed";
    else if (startDate) status = "In Progress";
    else status = "Proposed";
  }
  let health = pickVocab(cell("health"), HEALTHS, HEALTH_ALIASES, null);
  if (!health) health = status === "On Hold" ? "Amber" : "Green";

  const parentRaw = cleanText(cell("parentId")).toUpperCase();
  return {
    id,
    name: name || id,
    description: cleanText(cell("description")),
    department: cleanText(cell("department")) || "Unassigned",
    pillar: cleanText(cell("pillar")) || "General",
    program: cleanText(cell("program")),
    parentId: parentRaw && parentRaw !== id ? parentRaw : null,
    owner: cleanText(cell("owner")),
    sponsor: cleanText(cell("sponsor")),
    vendor: cleanText(cell("vendor")),
    status,
    health,
    priority: pickVocab(cell("priority"), PRIORITIES, {}, "Medium"),
    phase: pickVocab(cell("phase"), PHASES, {}, "Execution"),
    approvalDate: toISO(cell("approvalDate")),
    startDate,
    targetEndDate: toISO(cell("targetEndDate")),
    actualEndDate,
    budget: toMoney(cell("budget")),
    spent: toMoney(cell("spent")),
    currency: "AED",
    percentComplete: status === "Completed" ? 100 : percentComplete,
    milestones: [],
    updates: [],
    risks: [],
    questions: [],
    lastUpdated: toISO(cell("lastUpdated")),
    inlineQuestion: cleanText(cell("openQuestion")),
    sourceFile,
  };
}

/** Read one child sheet (milestones/updates/risks) into projectId-keyed rows. */
function readChildSheet(sheet, kind) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  if (rows.length < 2) return new Map();
  const found = findHeaderRow(rows, CHILD_SHEET_FIELDS[kind]);
  const map = found.map;
  if (!("projectId" in map)) return new Map();
  const byProject = new Map();
  for (const row of rows.slice(found.index + 1)) {
    const pid = cleanText(row[map.projectId]).toUpperCase();
    if (!pid) continue;
    const cell = (f) => (f in map ? row[map[f]] : null);
    let item = null;
    if (kind === "milestones") {
      const name = cleanText(cell("name"));
      if (!name) continue;
      const completedDate = toISO(cell("completedDate"));
      item = {
        name,
        dueDate: toISO(cell("dueDate")),
        completedDate,
        status: pickVocab(cell("status"), ["Pending", "In Progress", "Completed", "Overdue"], MILESTONE_STATUS_ALIASES, completedDate ? "Completed" : "Pending"),
      };
    } else if (kind === "updates") {
      const text = cleanText(cell("text"));
      if (!text) continue;
      item = { date: toISO(cell("date")), author: cleanText(cell("author")), text };
    } else if (kind === "questions") {
      const text = cleanText(cell("text"));
      if (!text) continue;
      item = {
        text,
        askedBy: cleanText(cell("askedBy")),
        raisedDate: toISO(cell("raisedDate")),
        neededBy: toISO(cell("neededBy")),
        decisionOwner: cleanText(cell("decisionOwner")),
        status: pickVocab(cell("status"), ["Open", "Answered", "Closed"], { answered: "Answered", resolved: "Answered", decided: "Answered", closed: "Closed" }, "Open"),
        source: "workbook",
      };
    } else {
      const title = cleanText(cell("title"));
      if (!title) continue;
      item = {
        title,
        severity: pickVocab(cell("severity"), ["Low", "Medium", "High", "Critical"], SEVERITY_ALIASES, "Medium"),
        status: pickVocab(cell("status"), ["Open", "Mitigating", "Closed"], RISK_STATUS_ALIASES, "Open"),
        owner: cleanText(cell("owner")),
      };
    }
    if (!byProject.has(pid)) byProject.set(pid, []);
    byProject.get(pid).push(item);
  }
  return byProject;
}

/**
 * Read a Posture sheet into normalized domain rows. Unlike the child sheets
 * these are not keyed to a project, so they are returned as a flat array.
 * @returns {object[]}
 */
function readPostureSheet(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  if (rows.length < 2) return [];
  const found = findHeaderRow(rows, POSTURE_FIELDS);
  if (!("domain" in found.map)) return [];

  const out = [];
  for (const row of rows.slice(found.index + 1)) {
    const cell = (f) => (f in found.map ? row[found.map[f]] : null);
    const domain = cleanText(cell("domain"));
    if (!domain) continue;

    const score = toPercent(cell("score"));
    const targetRaw = cell("target");
    const projectId = cleanText(cell("projectId")).toUpperCase();

    out.push({
      domain,
      control: cleanText(cell("control")),
      status: pickVocab(cell("status"), POSTURE_STATUSES, POSTURE_STATUS_ALIASES, null)
        || (score >= 90 ? "Compliant" : score >= 60 ? "Partial" : score > 0 ? "Non-Compliant" : "Not Assessed"),
      score,
      target: targetRaw === null || targetRaw === "" ? 100 : toPercent(targetRaw),
      owner: cleanText(cell("owner")),
      lastAssessed: toISO(cell("lastAssessed")),
      nextReview: toISO(cell("nextReview")),
      openFindings: Math.max(0, Math.round(Number(cell("openFindings")) || 0)),
      criticalFindings: Math.max(0, Math.round(Number(cell("criticalFindings")) || 0)),
      projectId: projectId || null,
      notes: cleanText(cell("notes")),
    });
  }
  return out;
}

/**
 * Parse a workbook buffer into normalized projects.
 * Never throws on malformed content — returns {ok:false, error} instead.
 * @returns {{ok: boolean, file: string, projects?: object[], error?: string}}
 */
export function ingestBuffer(buffer, filename, fileMtimeISO = null) {
  const file = path.basename(filename);
  try {
    const workbook = XLSX.read(buffer, { cellDates: true });
    const childData = { milestones: new Map(), updates: new Map(), risks: new Map(), questions: new Map() };
    let posture = [];
    let projects = [];
    let bestScore = 0;
    let bestSheetRows = null;
    let bestHeaderMap = null;
    let bestHeaderIndex = 0;

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const lowered = normKey(sheetName);
      if (lowered.includes("milestone")) { childData.milestones = readChildSheet(sheet, "milestones"); continue; }
      if (lowered.includes("update")) { childData.updates = readChildSheet(sheet, "updates"); continue; }
      if (lowered.includes("risk")) { childData.risks = readChildSheet(sheet, "risks"); continue; }
      if (lowered.includes("question") || lowered.includes("decision")) { childData.questions = readChildSheet(sheet, "questions"); continue; }
      if (lowered.includes("posture") || lowered.includes("security")) { posture = readPostureSheet(sheet); continue; }
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
      if (rows.length < 2) continue;
      const found = findHeaderRow(rows, SYNONYMS);
      const score = found.score + (("id" in found.map || "name" in found.map) ? 2 : -99);
      if (score > bestScore) {
        bestScore = score;
        bestSheetRows = rows;
        bestHeaderMap = found.map;
        bestHeaderIndex = found.index;
      }
    }

    if (bestSheetRows && bestScore >= 4) {
      projects = bestSheetRows
        .slice(bestHeaderIndex + 1)
        .map((row) => normalizeProjectRow(row, bestHeaderMap, file))
        .filter(Boolean);
    }
    if (projects.length === 0 && posture.length === 0) {
      return { ok: false, file, error: "no recognizable projects sheet (need Project ID/Name plus 2+ known columns)" };
    }

    for (const project of projects) {
      project.milestones = childData.milestones.get(project.id) || [];
      project.updates = (childData.updates.get(project.id) || []).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      project.risks = childData.risks.get(project.id) || [];
      project.questions = childData.questions.get(project.id) || [];
      // A question written straight onto the projects sheet counts the same as
      // one from the Questions sheet — PMs use whichever their template has.
      if (project.inlineQuestion) {
        project.questions.unshift({
          text: project.inlineQuestion,
          askedBy: project.owner,
          raisedDate: project.lastUpdated,
          neededBy: null,
          decisionOwner: project.sponsor,
          status: "Open",
          source: "workbook",
        });
      }
      delete project.inlineQuestion;
      if (!project.lastUpdated) {
        project.lastUpdated = project.updates[0]?.date || fileMtimeISO || null;
      }
    }
    return { ok: true, file, projects, posture };
  } catch (err) {
    return { ok: false, file, error: err.message || "unreadable workbook" };
  }
}

/** Parse a workbook on disk (see ingestBuffer). */
export function ingestFile(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const mtime = dayjs(fs.statSync(filePath).mtime).format("YYYY-MM-DD");
    const parsed = ingestBuffer(buffer, filePath, mtime);
    /* The vault needs the original bytes, and only the caller that already
       read them can supply them without reading the file a second time. */
    return parsed.ok ? { ...parsed, bytes: buffer } : parsed;
  } catch (err) {
    return { ok: false, file: path.basename(filePath), error: err.message };
  }
}

/** Apply one parse result to the store and log it. Returns projects added. */
export function applyResult(store, result) {
  if (result.ok) {
    store.upsertFromFile(result.file, result.projects);
    store.upsertPostureFromFile(result.file, result.posture);
    store.lastIngestAt = new Date().toISOString();
    store.log({
      file: result.file,
      ok: true,
      projects: result.projects.length,
      postureDomains: (result.posture || []).length,
    });
    return result.projects.length;
  }
  store.log({ file: result.file, ok: false, error: result.error });
  return 0;
}

/** Ingest every workbook in a directory. Returns {files, projects, errors}. */
export function ingestDirectory(store, dir) {
  const outcome = { files: 0, projects: 0, errors: [] };
  if (!fs.existsSync(dir)) return outcome;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(".") || entry.endsWith(".uploading")) continue;
    if (!WORKBOOK_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
    const result = ingestFile(path.join(dir, entry));
    outcome.files += 1;
    outcome.projects += applyResult(store, result);
    if (!result.ok) outcome.errors.push(`${result.file}: ${result.error}`);
  }
  return outcome;
}

/**
 * Watch the data/ drop-folder 24x7. Batches rapid changes (300ms quiet window)
 * and calls onBatch({files, projectCount}) after the store is updated.
 */
/**
 * Watch the drop folder and report what changed. Detection only: the caller
 * decides what persistence means, because the in-memory store writes
 * synchronously and the SQL store returns promises. Wiring applyResult() in
 * here hard-wired it to the former, and with STORE=mssql it threw inside the
 * chokidar handler — so a dropped workbook silently never reached the database.
 *
 * @param {string} dataDir folder to watch
 * @param {{
 *   onUpsert: (filePath: string) => Promise<void>|void,
 *   onRemove: (fileName: string) => Promise<void>|void,
 *   onBatch?: (batch: {files: string[]}) => void,
 *   logger?: {error: Function}
 * }} handlers
 * @returns {import('chokidar').FSWatcher}
 */
export function watchDataDir(dataDir, handlers) {
  const { onUpsert, onRemove, onBatch = () => {}, logger = console } = handlers;

  const watcher = chokidar.watch(dataDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 120 },
    ignored: (p) => {
      const base = path.basename(p);
      return base.startsWith(".") || base.endsWith(".uploading") || base.endsWith(".tmp");
    },
  });

  let pending = new Set();
  let timer = null;
  const flush = () => {
    const files = [...pending];
    pending = new Set();
    timer = null;
    if (files.length) onBatch({ files });
  };
  const queue = (file) => {
    pending.add(file);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  };

  /* Handlers are async and must never reject into chokidar: one failed write
     must not stop the watcher for every later file. */
  const settle = (promise, what) =>
    Promise.resolve(promise).catch((err) => {
      logger.error?.(`[watch] ${what} failed: ${err.message}`);
    });

  const handleAddOrChange = async (filePath) => {
    if (!WORKBOOK_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
    await settle(onUpsert(filePath), path.basename(filePath));
    queue(path.basename(filePath));
  };

  watcher.on("add", handleAddOrChange);
  watcher.on("change", handleAddOrChange);
  watcher.on("unlink", async (filePath) => {
    if (!WORKBOOK_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return;
    const name = path.basename(filePath);
    await settle(onRemove(name), `removing ${name}`);
    queue(name);
  });
  watcher.on("error", (err) => logger.error?.(`[watch] ${err.message}`));
  return watcher;
}

