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
import { renderMetrics } from "./metrics.js";
import { buildSummary, loadChanges, loadHistoryStart, loadDocuments, toRow, computeDetail } from "./summarize.js";
import { getChain } from "./chain.js";
import { buildExcel } from "./exporters/excel.js";
import { buildWord } from "./exporters/word.js";
import { buildHtml } from "./exporters/html.js";
import { buildPptxDeck } from "./exporters/pptx.js";
import { buildTemplate, TEMPLATE_FILENAME } from "./template.js";
import { looksLikeSupportedFile } from "./uploadGuard.js";
import { attachSession, requireSession, requireRole } from "./auth/session.js";
import { authRoutes } from "./auth/routes.js";
import { securityHeaders, rateLimit } from "./middleware/securityHeaders.js";

const PERIODS = new Set(["daily", "weekly", "monthly", "yearly"]);

/**
 * @param {{
 *   store: object,
 *   config: object,
 *   sessions: object,
 *   roleMapping: object,
 *   audit: {append: Function},
 *   ingestRuns?: {recent: Function}|null,
 *   documents?: {list: Function, add: Function, remove: Function}|null,
 *   ldapAuthenticate?: Function,
 *   dataDir?: string,
 *   clientDist?: string,
 *   startedAt?: number,
 *   isIngestLeader?: () => boolean,
 *   readModelAgeSeconds?: () => number|null
 * }} deps
 * @returns {import('express').Express}
 */
export function createApp(deps) {
  const { store, config } = deps;
  /* One source for every endpoint that reports a version, read from
     package.json by loadConfig. A literal here would drift the moment anyone
     bumped the package without editing this file -- and it did: /healthz said
     1.0.0 for every release up to 1.5.0 while /metrics said the truth. The
     release gates compare versions, so a stale one does not fail loudly, it
     answers "did the fix land?" wrongly. */
  const version = config.version || "unknown";
  const dataDir = deps.dataDir || path.resolve("data");
  const clientDist = deps.clientDist || path.resolve("client", "dist");
  const startedAt = deps.startedAt || Date.now();
  const audit = deps.audit || { append: async () => {} };
  const ingestRuns = deps.ingestRuns || null;
  /* Optional like ingestRuns: a deployment or a test that wires no document
     store gets an unavailable Documents section, not an error. */
  const documents = deps.documents || null;
  const sessions = deps.sessions;
  const roleMapping = deps.roleMapping;
  /* A function, not a plain boolean: STORE=mssql's leader status can flip to
     false mid-run if this process loses its dedicated applock connection
     (server/db/leaderElection.js), and a scrape must see that without the
     app being rebuilt. Defaults to true -- true both for STORE=memory, which
     runs no election at all and is trivially its own ingester, and for any
     caller (existing tests included) that has not wired the election up. */
  const isIngestLeader = deps.isIngestLeader || (() => true);
  /* Also a function, for the same reason: it changes over the process's
     life (every ingest on a leader, every poll tick on a follower -- see
     server/readModelRefresh.js). Defaults to a function returning null,
     which renderMetrics reads as "not applicable" and omits the series --
     true for STORE=memory, which has no separate read model to go stale,
     and for any caller that has not wired this up. */
  const readModelAgeSeconds = deps.readModelAgeSeconds || (() => null);

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

  /**
   * Both /api/summary and /api/export/:format need the same summary, built
   * the same way: history, its start date and the imported documents loaded
   * concurrently -- each already swallows its own failure, so there is nothing
   * here for Promise.all to obscure -- then handed to buildSummary.
   * Concurrency (not sequential awaits) matters most exactly when the database
   * is degraded: that is when all three guards are doing their job, and
   * sequential awaits would make the request sit out three connection timeouts
   * back to back before answering.
   */
  const summarize = async (period, dateISO) => {
    const [changes, historyStartedAt, docs] = await Promise.all([
      loadChanges(store, period, dateISO),
      loadHistoryStart(store),
      loadDocuments(documents),
    ]);
    return buildSummary(store, period, dateISO, { changes, historyStartedAt, documents: docs });
  };

  /* Monitoring must not need a session. */
  app.get("/healthz", (req, res) => {
    res.json({ status: "ok", uptimeSec: Math.round((Date.now() - startedAt) / 1000), version });
  });
  app.get("/readyz", (req, res) => {
    if (!store.projectCount) {
      return res.status(503).json({ ready: false, reason: "no data has been ingested yet" });
    }
    res.json({ ready: true, projects: store.projectCount, lastIngestAt: store.lastIngestAt });
  });

  /**
   * Operational numbers for a scraper. Open like the health endpoints above,
   * because a scraper cannot authenticate — and safe to be open only because
   * it holds nothing read from a workbook: no project name, no person, no
   * filename, no error text. Blocked at the proxy instead; see
   * deploy/iis-site.md.
   */
  app.get("/metrics", wrap(async (req, res) => {
    /* Optional parts degrade rather than fail: monitoring that goes dark
       exactly when the database does is worse than no monitoring. An
       unreachable store is exactly when a scraper most needs to see the
       process is still alive, so reading it is guarded the same way as the
       ingest-history reads below -- not just the two ingestRuns calls. */
    let ingestTiming = null;
    let runOutcomes = null;
    if (ingestRuns) {
      try {
        [ingestTiming, runOutcomes] = await Promise.all([
          ingestRuns.timingSummary(),
          ingestRuns.countByOutcome(),
        ]);
      } catch (err) {
        console.error(`[metrics] history unavailable: ${err.message}`);
      }
    }

    /* "Ready" means the same thing /readyz above already means -- there is a
       portfolio to serve -- not SqlStore's own internal bootstrap flag, which
       the in-memory store does not have at all and would otherwise read as
       permanently not-ready. Falls back to "nothing to report" rather than a
       500 if the store itself is unwell: an unreadable store is not a reason
       to stop saying gcio_up 1. */
    let metricsStore = { ready: false, demoMode: false, projectCount: 0, fileCount: 0, lastIngestAt: null };
    try {
      metricsStore = {
        ready: Boolean(store.projectCount),
        demoMode: Boolean(store.demoMode),
        projectCount: store.projectCount,
        fileCount: store.fileCount,
        lastIngestAt: store.lastIngestAt,
      };
    } catch (err) {
      console.error(`[metrics] store unavailable: ${err.message}`);
    }

    /* res.send(string) makes Express re-serialize Content-Type through the
       content-type package, which alphabetizes parameters -- charset before
       version -- undoing the literal header a scraper expects. A Buffer
       skips that step, so the header set above survives byte-for-byte. */
    const body = await renderMetrics({
      store: metricsStore, startedAt, version, ingestTiming, runOutcomes,
      ingestLeader: isIngestLeader(),
      readModelAgeSeconds: readModelAgeSeconds(),
    });
    res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(Buffer.from(body, "utf-8"));
  }));

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
      version,
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
  
  app.get("/api/summary", wrap(async (req, res) => {
    const period = PERIODS.has(req.query.period) ? req.query.period : "monthly";
    const date = dayjs(req.query.date || undefined).isValid() ? dayjs(req.query.date || undefined).format("YYYY-MM-DD") : dayjs().format("YYYY-MM-DD");
    res.json(await summarize(period, date));
  }));
  
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
  
  // ---------- audit trail (administrators only) ----------
  /**
   * Who signed in, who uploaded what, and what left the building. Reading it
   * is itself recorded: an audit trail that does not log its own readers
   * answers "who saw this" with silence.
   */
  app.get("/api/audit", requireRole("admin"), wrap(async (req, res) => {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    const action = req.query.action ? String(req.query.action) : null;
    const events = await audit.recent({ limit, action });
    await auditFrom(req, {
      actor: req.session.principal,
      action: "audit.read",
      subject: action ? `${events.length} events, filtered to ${action}` : `${events.length} events`,
    });
    res.json({ count: events.length, events });
  }));

  /**
   * The last ingests and what each one did. This is the answer to "why does
   * the dashboard not show last night's file": either there is no run, or
   * there is one with an outcome and a reason.
   *
   * Not audited: unlike /api/audit, this exposes filenames and counts, not
   * who did what, so reading it is not itself an accountability event. Not
   * rate-limited either: it is already behind a session and the admin role,
   * unlike the anonymous /api/auth/* routes, and its query is a single bounded
   * SELECT, unlike /api/export's document generation — the same reasoning
   * that leaves /api/audit unthrottled.
   */
  app.get("/api/ingest/runs", requireRole("admin"), wrap(async (req, res) => {
    if (!ingestRuns) return res.json({ historyEnabled: false, count: 0, runs: [] });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const runs = await ingestRuns.recent({ limit });
    res.json({ historyEnabled: true, count: runs.length, runs });
  }));

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
      const verdict = looksLikeSupportedFile(f.buffer, safe);
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
    const summary = await summarize(period, date);

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

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500) console.error(`[gcio] ${req.method} ${req.path} failed: ${err.stack || err.message}`);
    if (!res.headersSent) {
      res.status(status).json({ error: { code: err.code || "internal", message: err.message || "internal error" } });
    }
  });

  return app;
}
