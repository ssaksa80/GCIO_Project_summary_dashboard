/**
 * Builds the Express application.
 *
 * No listening, no watcher, no process-level handlers — those belong to
 * index.js. Keeping the factory free of side effects is what lets the test
 * suite drive the real routes in-process, with a fake store and a fake
 * directory, and assert the authorisation matrix.
 */
import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import dayjs from "dayjs";

import { ingestBuffer, WORKBOOK_EXTENSIONS } from "./ingest.js";
import { buildSummary, toRow, computeDetail } from "./summarize.js";
import { getChain } from "./chain.js";
import { buildExcel } from "./exporters/excel.js";
import { buildWord } from "./exporters/word.js";
import { buildHtml } from "./exporters/html.js";
import { buildPptxDeck } from "./exporters/pptx.js";
import { buildTemplate, TEMPLATE_FILENAME } from "./template.js";
import { looksLikeWorkbook } from "./uploadGuard.js";
import { attachSession, requireSession, requireRole } from "./auth/session.js";
import { authRoutes } from "./auth/routes.js";
import { securityHeaders, rateLimit } from "./middleware/securityHeaders.js";

const PERIODS = new Set(["daily", "weekly", "monthly", "yearly"]);
const VERSION = "1.0.0";

/**
 * @param {{
 *   store: object,
 *   config: object,
 *   sessions: object,
 *   roleMapping: object,
 *   audit: {append: Function},
 *   ldapAuthenticate?: Function,
 *   dataDir?: string,
 *   clientDist?: string,
 *   startedAt?: number
 * }} deps
 * @returns {import('express').Express}
 */
export function createApp(deps) {
  const { store, config } = deps;
  const dataDir = deps.dataDir || path.resolve("data");
  const clientDist = deps.clientDist || path.resolve("client", "dist");
  const startedAt = deps.startedAt || Date.now();
  const audit = deps.audit || { append: async () => {} };
  const sessions = deps.sessions;
  const roleMapping = deps.roleMapping;

  const app = express();
  /* TLS terminates at IIS on the same box, so forwarded headers are trusted
     from loopback and nowhere else. */
  app.set("trust proxy", "loopback");
  app.use(securityHeaders({ https: Boolean(config.isProd) }));
  app.use(cookieParser());
  app.use(express.json({ limit: "40mb" }));

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const auditFrom = (req, event) =>
    audit.append({ ...event, ip: req.ip, userAgent: req.get?.("user-agent"), requestId: req.id });

  /* Monitoring must not need a session. */
  app.get("/healthz", (req, res) => {
    res.json({ status: "ok", uptimeSec: Math.round((Date.now() - startedAt) / 1000), version: VERSION });
  });
  app.get("/readyz", (req, res) => {
    if (!store.projectCount) {
      return res.status(503).json({ ready: false, reason: "no data has been ingested yet" });
    }
    res.json({ ready: true, projects: store.projectCount, lastIngestAt: store.lastIngestAt });
  });

  /* Identity, then the gate. /api/me answers for signed-out callers too, so
     the client can tell "not signed in" from "server is broken". */
  /* Credential endpoints are throttled per IP; the rest of the API is behind a
     session, so it is not an anonymous attack surface. Exports are capped
     separately because each one costs real work. */
  app.use(["/api/auth/login", "/api/auth/sso"],
    rateLimit({ max: 10, windowMs: 60_000, message: "too many sign-in attempts, try again shortly" }));
  app.use("/api/export",
    rateLimit({ max: 60, windowMs: 60_000, message: "export limit reached, try again shortly" }));

  app.use(attachSession({ sessions, idleMinutes: config.sessionIdleMinutes }));
  app.use(authRoutes({
    config, sessions, roleMapping, audit,
    ldapAuthenticate: deps.ldapAuthenticate,
    entraJwks: deps.entraJwks,
  }));
  app.use("/api", (req, res, next) => {
    if (req.path === "/me" || req.path.startsWith("/auth/")) return next();
    return requireSession(req, res, next);
  });

  // ---------- app ----------
  
  /** Async route wrapper so any rejection lands in the error handler. */
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
  
  app.post("/api/ingest/upload", requireRole("pm"), upload.array("files", 20), wrap(async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "no files received (multipart field name: files)" });
    const ingested = [];
    const errors = [];
    for (const f of files) {
      const safe = path.basename(f.originalname).replace(/[^\w.\- ()]/g, "_");
      const verdict = looksLikeWorkbook(f.buffer, safe);
      if (!verdict.ok) {
        errors.push({ file: safe, error: verdict.reason });
        await auditFrom(req, { actor: req.session.principal, action: "upload.rejected", subject: `${safe}: ${verdict.reason}` });
        continue;
      }
      const parsed = ingestBuffer(f.buffer, safe, dayjs().format("YYYY-MM-DD"));
      if (!parsed.ok) {
        errors.push({ file: safe, error: parsed.error });
        continue;
      }
      // Persist into the watched folder: .uploading suffix first so the watcher
      // only sees the completed file on rename; the watcher then owns the upsert.
      const finalPath = path.join(dataDir, safe);
      const tmpPath = `${finalPath}.uploading`;
      fs.writeFileSync(tmpPath, f.buffer);
      fs.renameSync(tmpPath, finalPath);
      ingested.push({ file: safe, projects: parsed.projects.length });
      await auditFrom(req, { actor: req.session.principal, action: "upload", subject: `${safe} (${parsed.projects.length} projects)` });
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
    await auditFrom(req, { actor: req.session.principal, action: "export", subject: `${format} ${period} ${date}` });
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
  app.use(express.static(clientDist, { index: "index.html", maxAge: "1h" }));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    const index = path.join(clientDist, "index.html");
    if (fs.existsSync(index)) return res.sendFile(index);
    res.status(503).send("GCIO dashboard client is not built yet. Run: npm run build");
  });


  app.use(express.static(clientDist, { index: "index.html", maxAge: "1h" }));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    const index = path.join(clientDist, "index.html");
    if (fs.existsSync(index)) return res.sendFile(index);
    res.status(503).send("GCIO dashboard client is not built yet. Run: npm run build");
  });

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500) console.error(`[gcio] ${req.method} ${req.path} failed: ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.status(status).json({ error: { code: err.code || "internal", message: err.message || "internal error" } });
    }
  });

  return app;
}
