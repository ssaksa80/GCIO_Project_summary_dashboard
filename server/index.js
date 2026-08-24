/**
 * GCIO Project Intelligence — application server (SPEC §1, §4).
 * Express API + SSE live channel + static client + 24x7 data/ watcher.
 * Designed to never exit on bad input: every route is wrapped, and
 * process-level guards log instead of dying.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import dayjs from "dayjs";

import { Store } from "./store.js";
import { ingestBuffer, ingestDirectory, applyResult, watchDataDir, WORKBOOK_EXTENSIONS } from "./ingest.js";
import { buildSummary, toRow, computeDetail } from "./summarize.js";
import { getChain } from "./chain.js";
import { buildExcel } from "./exporters/excel.js";
import { buildWord } from "./exporters/word.js";
import { buildHtml } from "./exporters/html.js";
import { buildPptxDeck } from "./exporters/pptx.js";
import { buildTemplate, TEMPLATE_FILENAME } from "./template.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SAMPLE_DIR = path.join(ROOT, "sample-data");
const CLIENT_DIST = path.join(ROOT, "client", "dist");
const PORT = Number(process.env.PORT || 8123);
const VERSION = "1.0.0";
const PERIODS = new Set(["daily", "weekly", "monthly", "yearly"]);

const store = new Store();
const startedAt = Date.now();

const log = (msg) => console.log(`[gcio ${dayjs().format("HH:mm:ss")}] ${msg}`);

// ---------- boot-time ingestion (SPEC §3) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
{
  const fromData = ingestDirectory(store, DATA_DIR);
  if (fromData.files > 0) {
    log(`ingested ${store.projectCount} projects from ${fromData.files} workbook(s) in data/`);
  } else {
    const fromSample = ingestDirectory(store, SAMPLE_DIR);
    if (fromSample.files > 0) {
      store.demoMode = true;
      log(`demo mode: ingested ${store.projectCount} projects from ${fromSample.files} sample workbook(s)`);
    } else if (store.loadCache(DATA_DIR)) {
      log(`restored ${store.projectCount} projects from cache snapshot`);
    } else {
      log("no data yet — waiting for workbooks in data/ or an upload");
    }
  }
  if (store.projectCount > 0) store.lastIngestAt = store.lastIngestAt || new Date().toISOString();
}

watchDataDir(store, DATA_DIR, (batch) => {
  store.saveCache(DATA_DIR);
  store.emit("ingest", { files: batch.files, projectCount: store.projectCount, at: store.lastIngestAt });
  log(`live ingest: ${batch.files.join(", ")} -> ${store.projectCount} projects`);
});

// ---------- app ----------
const app = express();
app.use(express.json({ limit: "40mb" }));

/** Async route wrapper so any rejection lands in the error handler. */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    projectCount: store.projectCount,
    fileCount: store.fileCount,
    lastIngestAt: store.lastIngestAt,
    demoMode: store.demoMode,
    version: VERSION,
  });
});

app.get("/api/meta", (req, res) => {
  const projects = store.all();
  const uniq = (fn) => [...new Set(projects.map(fn).filter(Boolean))].sort();
  res.json({
    departments: uniq((p) => p.department),
    pillars: uniq((p) => p.pillar),
    owners: uniq((p) => p.owner),
    sponsors: uniq((p) => p.sponsor),
    statuses: ["Proposed", "Approved", "In Progress", "On Hold", "Completed", "Cancelled"],
    currency: "AED",
    asOf: store.lastIngestAt,
  });
});

app.get("/api/summary", (req, res) => {
  const period = PERIODS.has(req.query.period) ? req.query.period : "monthly";
  const date = dayjs(req.query.date || undefined).isValid() ? dayjs(req.query.date || undefined).format("YYYY-MM-DD") : dayjs().format("YYYY-MM-DD");
  res.json(buildSummary(store, period, date));
});

app.get("/api/projects", (req, res) => {
  const { department, pillar, status, health, q, sort } = req.query;
  const needle = String(q || "").toLowerCase();
  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  let rows = store.all()
    .filter((p) => !department || eq(p.department, department))
    .filter((p) => !pillar || eq(p.pillar, pillar))
    .filter((p) => !status || eq(p.status, status))
    .filter((p) => !health || eq(p.health, health))
    .filter((p) => !needle || [p.id, p.name, p.owner, p.sponsor, p.program].some((v) => String(v).toLowerCase().includes(needle)))
    .map((p) => toRow(p));
  const key = String(sort || "-budget");
  const desc = key.startsWith("-");
  const field = desc ? key.slice(1) : key;
  rows.sort((a, b) => {
    const av = a[field] ?? "";
    const bv = b[field] ?? "";
    const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return desc ? -cmp : cmp;
  });
  res.json({ count: rows.length, projects: rows });
});

app.get("/api/projects/:id", (req, res) => {
  const project = store.get(req.params.id);
  if (!project) return res.status(404).json({ error: `unknown project ${req.params.id}` });
  const { computed, timeline } = computeDetail(project);
  res.json({ project, chain: getChain(store, project.id), computed, timeline });
});

// ---------- canonical template workbook ----------
app.get("/api/template", wrap(async (req, res) => {
  const buffer = await buildTemplate();
  res.set({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${TEMPLATE_FILENAME}"`,
    "Content-Length": String(buffer.length),
  });
  res.send(buffer);
}));

// ---------- uploads ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });

app.post("/api/ingest/upload", upload.array("files", 20), wrap(async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "no files received (multipart field name: files)" });
  const ingested = [];
  const errors = [];
  for (const f of files) {
    const safe = path.basename(f.originalname).replace(/[^\w.\- ()]/g, "_");
    if (!WORKBOOK_EXTENSIONS.has(path.extname(safe).toLowerCase())) {
      errors.push({ file: safe, error: "unsupported file type (use .xlsx .xls .xlsm .csv)" });
      continue;
    }
    const parsed = ingestBuffer(f.buffer, safe, dayjs().format("YYYY-MM-DD"));
    if (!parsed.ok) {
      errors.push({ file: safe, error: parsed.error });
      continue;
    }
    // Persist into the watched folder: .uploading suffix first so the watcher
    // only sees the completed file on rename; the watcher then owns the upsert.
    const finalPath = path.join(DATA_DIR, safe);
    const tmpPath = `${finalPath}.uploading`;
    fs.writeFileSync(tmpPath, f.buffer);
    fs.renameSync(tmpPath, finalPath);
    ingested.push({ file: safe, projects: parsed.projects.length });
  }
  res.json({ ok: errors.length === 0, ingested, errors });
}));

// ---------- exports ----------
const EXPORT_META = {
  xlsx: { ext: "xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  docx: { ext: "docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  html: { ext: "html", type: "text/html; charset=utf-8" },
  pptx: { ext: "pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

app.post("/api/export/:format", wrap(async (req, res) => {
  const format = req.params.format;
  if (!EXPORT_META[format]) return res.status(400).json({ error: `unknown format '${format}' (xlsx|docx|html|pptx)` });
  const body = req.body || {};
  const period = PERIODS.has(body.period) ? body.period : "monthly";
  const date = dayjs(body.date || undefined).isValid() ? dayjs(body.date || undefined).format("YYYY-MM-DD") : dayjs().format("YYYY-MM-DD");
  const summary = buildSummary(store, period, date);

  const scopeIds = Array.isArray(body.projectIds) && body.projectIds.length
    ? body.projectIds.map((id) => String(id).toUpperCase())
    : null;
  const scoped = scopeIds ? store.all().filter((p) => scopeIds.includes(p.id)) : store.all();
  const projects = scoped.map((p) => toRow(p)).sort((a, b) => b.budget - a.budget);

  let detailProjects;
  if (scopeIds) {
    detailProjects = scoped;
  } else {
    const wanted = [...new Set([...summary.attention.map((a) => a.id), ...summary.charts.topProjects.map((t) => t.id)])].slice(0, 10);
    detailProjects = wanted.map((id) => store.get(id)).filter(Boolean);
  }
  detailProjects = detailProjects.map((p) => ({ ...p, ...computeDetail(p).computed ? { computed: computeDetail(p).computed } : {} }));

  const meta = { currency: "AED", demoMode: store.demoMode, projectCount: store.projectCount };
  const payload = {
    summary,
    projects,
    detailProjects,
    meta,
    images: Array.isArray(body.images) ? body.images.filter((i) => i && typeof i.dataUrl === "string") : [],
    theme: typeof body.theme === "string" ? body.theme : "obsidian",
    generatedBy: "GCIO Project Intelligence",
    asOf: dayjs().format("YYYY-MM-DD"),
  };

  const { ext, type } = EXPORT_META[format];
  const filename = `GCIO_Portfolio_Brief_${period}_${date}.${ext}`;
  const output = format === "xlsx" ? await buildExcel(payload)
    : format === "docx" ? await buildWord(payload)
    : format === "pptx" ? buildPptxDeck(payload)
    : buildHtml(payload);
  res.set({
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.send(typeof output === "string" ? output : Buffer.from(output));
}));

// ---------- SSE live channel ----------
app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ projectCount: store.projectCount, at: store.lastIngestAt })}\n\n`);
  const listener = (event, payload) => res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  store.listeners.add(listener);
  const heartbeat = setInterval(() => res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`), 30000);
  req.on("close", () => {
    clearInterval(heartbeat);
    store.listeners.delete(listener);
  });
});

// ---------- static client ----------
app.use(express.static(CLIENT_DIST, { index: "index.html", maxAge: "1h" }));
app.get(/^\/(?!api\/).*/, (req, res) => {
  const index = path.join(CLIENT_DIST, "index.html");
  if (fs.existsSync(index)) return res.sendFile(index);
  res.status(503).send("GCIO dashboard client is not built yet. Run: npm run build");
});

// ---------- error handling: log, respond, never die ----------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(`[gcio] ${req.method} ${req.path} failed: ${err.stack || err.message}`);
  if (!res.headersSent) res.status(500).json({ error: err.message || "internal error" });
});
process.on("unhandledRejection", (err) => console.error(`[gcio] unhandled rejection: ${err && err.stack}`));
process.on("uncaughtException", (err) => console.error(`[gcio] uncaught exception: ${err && err.stack}`));

app.listen(PORT, () => {
  log(`GCIO Project Intelligence v${VERSION} listening on http://localhost:${PORT}`);
  log(`watching ${DATA_DIR} for workbooks (24x7 live ingestion)`);
});
