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
import { buildSummary, loadChanges, loadHistoryStart, toRow, computeDetail } from "./summarize.js";
import { getChain } from "./chain.js";
import { buildExcel } from "./exporters/excel.js";
import { buildWord } from "./exporters/word.js";
import { buildHtml } from "./exporters/html.js";
import { buildPptxDeck } from "./exporters/pptx.js";
import { buildTemplate, TEMPLATE_FILENAME } from "./template.js";
import { looksLikeWorkbook } from "./uploadGuard.js";
import { attachSession, requireSession, requireRole } from "./auth/session.js";
import { PRECEDENCE } from "./auth/authz.js";
import { SECTION_KEYS } from "./repos/ownership.js";
import { KNOWN_SETTINGS } from "./repos/settings.js";
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
  const sessions = deps.sessions;
  const roleMapping = deps.roleMapping;
  /* Per-user role grants. Optional, so every existing caller that wires only
     roleMapping keeps working: resolveAccess reads an absent one as "no
     grants" and falls back to directory groups alone. */
  const userRoleMapping = deps.userRoleMapping || null;
  /* Injected rather than imported, so the console's picker is testable without
     a directory and a deployment with no service account gives a clear error
     instead of a stack trace. */
  const searchDirectory = deps.searchDirectory || null;
  /* All optional, all defaulting to null: a caller that wires none of them
     still gets a working app, and each screen reports its own absence
     rather than the page failing. */
  const ownership = deps.ownership || null;
  const settings = deps.settings || null;
  const adminProbes = deps.adminProbes || null;
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
   * the same way: history and its start date loaded concurrently -- each
   * already swallows its own failure, so there is nothing here for Promise.all
   * to obscure -- then handed to buildSummary. Concurrency (not two sequential
   * awaits) matters most exactly when the database is degraded: that is when
   * both guards are doing their job, and sequential awaits would make the
   * request sit out two connection timeouts back to back before answering.
   */
  const summarize = async (period, dateISO) => {
    const [changes, historyStartedAt] = await Promise.all([
      loadChanges(store, period, dateISO),
      loadHistoryStart(store),
    ]);
    return buildSummary(store, period, dateISO, { changes, historyStartedAt });
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
    userRoleMapping,
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
  /* ---- admin console: who may use this application --------------------- */

  const fail = (res, code, message, status = 422) =>
    res.status(status).json({ error: { code, message } });

  /**
   * Would this change leave nobody holding a direct admin grant?
   *
   * Demoting or revoking yourself is revoking your own admin access, and if no
   * other direct admin grant remains the console locks for everyone. The way
   * back is a database edit or the seed group - a maintenance window to undo
   * one click, so it is refused instead.
   *
   * Deliberately only counts DIRECT grants. Group-derived admins are not
   * visible here and, more to the point, are not something this console can
   * restore; treating them as a safety net would make the guard depend on a
   * directory state nobody in this screen can see or change.
   */
  async function lastAdminGuard(req, principal, losesAdmin) {
    if (!losesAdmin || !userRoleMapping) return null;
    const map = await userRoleMapping.getMap();
    const target = String(principal || "").toLowerCase().split("@")[0].split("\\").pop();
    if (map[target] !== "admin") return null;
    const others = Object.entries(map).filter(([p, r]) => r === "admin" && p !== target);
    if (others.length) return null;
    return {
      code: "last_admin",
      message: "this is the last account holding an admin grant; grant admin to someone else before removing your own, or you will lock yourself out",
    };
  }

  /**
   * Every per-user grant. Admin-only: who holds which role is exactly the map
   * an attacker would want before picking an account to go after.
   */
  app.get("/api/admin/user-roles", requireRole("admin"), wrap(async (req, res) => {
    if (!userRoleMapping) return res.json([]);
    res.json(await userRoleMapping.list());
  }));

  /**
   * Grant or change one person's role.
   *
   * Validated here rather than left to the table's CHECK: a constraint
   * violation arrives as a 500 carrying a SQL message, which tells an admin
   * nothing about which of the two fields was wrong.
   */
  app.post("/api/admin/user-roles", requireRole("admin"), wrap(async (req, res) => {
    if (!userRoleMapping) return fail(res, "user_roles_unavailable", "per-user grants are not configured on this deployment", 503);
    const principal = String(req.body?.principal || "").trim();
    const role = String(req.body?.role || "").toLowerCase();
    if (!principal || !PRECEDENCE.includes(role)) {
      return fail(res, "bad_user_role", `principal is required and role must be one of ${PRECEDENCE.join(", ")}`);
    }

    const guard = await lastAdminGuard(req, principal, role !== "admin");
    if (guard) return fail(res, guard.code, guard.message, 409);

    await userRoleMapping.set(principal, role, req.session.principal);
    await auditFrom(req, { actor: req.session.principal, action: "authz.grant", subject: `${principal} -> ${role}` });
    res.json({ ok: true });
  }));

  /** Revoke a grant. The person keeps whatever their directory groups give. */
  app.delete("/api/admin/user-roles/:principal", requireRole("admin"), wrap(async (req, res) => {
    if (!userRoleMapping) return fail(res, "user_roles_unavailable", "per-user grants are not configured on this deployment", 503);
    const principal = decodeURIComponent(req.params.principal);
    const guard = await lastAdminGuard(req, principal, true);
    if (guard) return fail(res, guard.code, guard.message, 409);

    await userRoleMapping.remove(principal);
    await auditFrom(req, { actor: req.session.principal, action: "authz.revoke", subject: principal });
    res.json({ ok: true });
  }));

  /**
   * Find someone to grant a role to.
   *
   * The picker exists so a grant lands on an account that demonstrably exists.
   * A principal typed by hand is stored happily against a typo, reports
   * nothing, and looks correct in the table while the person is still refused
   * at sign-in.
   */
  /**
   * Directory group -> role. The other half of who may use this application:
   * a mapping grants access to everyone in a group at once, where a per-user
   * grant names one person.
   */
  app.get("/api/admin/roles", requireRole("admin"), wrap(async (req, res) => {
    res.json(await roleMapping.list());
  }));

  app.post("/api/admin/roles", requireRole("admin"), wrap(async (req, res) => {
    const groupName = String(req.body?.groupName || "").trim();
    const role = String(req.body?.role || "").toLowerCase();
    if (!groupName || !PRECEDENCE.includes(role)) {
      return fail(res, "bad_group_role", `groupName is required and role must be one of ${PRECEDENCE.join(", ")}`);
    }
    await roleMapping.set(groupName, role);
    await auditFrom(req, { actor: req.session.principal, action: "authz.map", subject: `${groupName} -> ${role}` });
    res.json({ ok: true });
  }));

  /**
   * Remove a mapping.
   *
   * Refused when it is the caller's own only route to admin. The per-user
   * guard does not cover this case: someone whose admin comes from a GROUP can
   * delete that mapping and lose the console with no grant to fall back on.
   * Recovering then needs Grant-Role.cmd on the host, or a database edit.
   */
  app.delete("/api/admin/roles/:groupName", requireRole("admin"), wrap(async (req, res) => {
    const groupName = decodeURIComponent(req.params.groupName);
    const isMine = (req.session.groups || []).some((g) => String(g).toLowerCase() === groupName.toLowerCase());
    if (isMine) {
      const map = await roleMapping.getMap({ fresh: true });
      const grants = userRoleMapping ? await userRoleMapping.getMap() : {};
      const sam = String(req.session.principal || "").toLowerCase().split("@")[0].split("\\").pop();
      const keptByGrant = grants[sam] === "admin";
      const keptByOther = (req.session.groups || []).some((g) =>
        String(g).toLowerCase() !== groupName.toLowerCase() && map[String(g).toLowerCase()] === "admin");
      if (map[groupName.toLowerCase()] === "admin" && !keptByGrant && !keptByOther) {
        return fail(res, "last_admin", "this mapping is your own only route to admin; removing it would lock you out of this screen", 409);
      }
    }
    await roleMapping.remove(groupName);
    await auditFrom(req, { actor: req.session.principal, action: "authz.unmap", subject: groupName });
    res.json({ ok: true });
  }));

  /**
   * Who is signed in.
   *
   * Never includes a session id. That is a bearer token, and a screen showing
   * one would be a screen handing it over - into a response body, a proxy log
   * and a browser cache. Revocation is by principal, which is the question an
   * admin is actually asking.
   */
  app.get("/api/admin/sessions", requireRole("admin"), wrap(async (req, res) => {
    if (typeof sessions.list !== "function") return res.json([]);
    res.json(await sessions.list({ idleMinutes: config.sessionIdleMinutes }));
  }));

  app.delete("/api/admin/sessions/:principal", requireRole("admin"), wrap(async (req, res) => {
    const principal = decodeURIComponent(req.params.principal);
    await sessions.destroyForPrincipal(principal);
    await auditFrom(req, { actor: req.session.principal, action: "session.revoked", subject: principal });
    res.json({ ok: true });
  }));

  /* ---- health -----------------------------------------------------------
     DEDB Health answers three questions in one place: is the database
     reachable, is the directory configured, and which migrations have run.
     All three are otherwise learned by reading a log file. */
  app.get("/api/admin/health", requireRole("admin"), wrap(async (req, res) => {
    const out = {
      version, store: config.store, authMode: config.authMode,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      projects: store.projectCount ?? null,
      database: { configured: config.store === "mssql", up: null, detail: null },
      directory: {
        configured: config.authMode === "ldap" && Boolean(config.ldap.url),
        url: config.ldap.url || null,
        serviceAccount: config.ldap.bindDN ? "configured" : "not configured",
        bindPasswordSealed: String(process.env.LDAP_BIND_PASSWORD || "").startsWith("enc:v1:"),
      },
      migrations: { applied: [], last: null },
      warnings: config.warnings || [],
    };
    /* Each probe is separate and failure-tolerant: a database that is down
       must still let the rest of the page render, because that is exactly
       when an operator needs to read it. */
    if (adminProbes && adminProbes.database) {
      try { Object.assign(out.database, await adminProbes.database()); }
      catch (err) { out.database.up = false; out.database.detail = err.message; }
    }
    if (adminProbes && adminProbes.migrations) {
      try { out.migrations = await adminProbes.migrations(); }
      catch (err) { out.migrations.error = err.message; }
    }
    res.json(out);
  }));

  /* ---- ownership --------------------------------------------------------- */
  app.get("/api/admin/ownership", requireRole("admin"), wrap(async (req, res) => {
    if (!ownership) return res.json([]);
    res.json(await ownership.list());
  }));

  /**
   * Grant a section to a person or a group.
   *
   * Validated before the repo, as DEDB validates it, and for the same reason:
   * the resolver matches PrincipalName verbatim and never filters on type, so
   * an unvalidated typo becomes a grant that matches nobody and reports
   * nothing. Non-strings are refused rather than coerced - String(12345) would
   * pass a non-empty check and persist as junk.
   */
  app.post("/api/admin/ownership", requireRole("admin"), wrap(async (req, res) => {
    if (!ownership) return fail(res, "ownership_unavailable", "section ownership is not configured on this deployment", 503);
    const b = req.body || {};
    if (typeof b.principalType !== "string") return fail(res, "bad_principal_type", "principalType must be user or group");
    if (typeof b.principalName !== "string") return fail(res, "bad_principal_name", "principalName is required");
    if (typeof b.sectionKey !== "string") return fail(res, "bad_section", "sectionKey must be one of: " + SECTION_KEYS.join(", "));
    const principalType = b.principalType.trim().toLowerCase();
    const principalName = b.principalName.trim();
    const sectionKey = b.sectionKey.trim();
    if (!["user", "group"].includes(principalType)) return fail(res, "bad_principal_type", "principalType must be user or group");
    if (!principalName) return fail(res, "bad_principal_name", "principalName is required");
    if (principalName.length > 200) return fail(res, "bad_principal_name", "principalName must be 200 characters or fewer");
    if (!SECTION_KEYS.includes(sectionKey)) return fail(res, "bad_section", "sectionKey must be one of: " + SECTION_KEYS.join(", "));

    const id = await ownership.grant({ principalType, principalName, sectionKey, grantedBy: req.session.principal });
    await auditFrom(req, { actor: req.session.principal, action: "ownership.grant", subject: principalName + " -> " + sectionKey });
    res.json({ id });
  }));

  app.delete("/api/admin/ownership/:id", requireRole("admin"), wrap(async (req, res) => {
    if (!ownership) return fail(res, "ownership_unavailable", "section ownership is not configured on this deployment", 503);
    await ownership.revoke(req.params.id);
    await auditFrom(req, { actor: req.session.principal, action: "ownership.revoke", subject: String(req.params.id) });
    res.json({ ok: true });
  }));

  /* ---- settings ---------------------------------------------------------- */
  app.get("/api/admin/settings", requireRole("admin"), wrap(async (req, res) => {
    if (!settings) return res.json([]);
    res.json(await settings.describe());
  }));

  /**
   * Save settings, and report which ones actually took effect.
   *
   * DEDB distinguishes saved from applied-live, and it is the honest
   * distinction: some settings the running process re-reads, others need a
   * restart. Returning appliedLive lets the console say which is which rather
   * than implying every save is instant. A save that persists but does not
   * apply is not a failure - it is a fact the operator needs.
   */
  app.put("/api/admin/settings", requireRole("admin"), wrap(async (req, res) => {
    if (!settings) return fail(res, "settings_unavailable", "settings are not configured on this deployment", 503);
    const body = req.body || {};
    if (typeof body !== "object" || Array.isArray(body)) return fail(res, "bad_settings", "expected an object of key/value pairs");

    const saved = [];
    for (const [k, v] of Object.entries(body)) {
      await settings.set(k, v, req.session.principal);
      saved.push(k);
    }
    /* Only what THIS request changed live, so the console cannot claim a
       restart-only setting applied. */
    const appliedLive = saved.filter((k) => KNOWN_SETTINGS.some((x) => x.key === k && x.live));
    await auditFrom(req, { actor: req.session.principal, action: "settings.save", subject: saved.join(", ") });
    res.json({ ok: true, saved, appliedLive, needsRestart: saved.filter((k) => !appliedLive.includes(k)) });
  }));

  /* ---- connection -------------------------------------------------------- */
  /**
   * What this deployment is pointed at. READ-ONLY, and that is a genuine
   * difference from DEDB, which edits a runtime config store. GCIO reads its
   * configuration from .env, which the service wrapper freezes at install
   * time; a screen that appeared to change it would be lying. Passwords are
   * never included - only whether one is set, and whether it is sealed.
   */
  app.get("/api/admin/connection", requireRole("admin"), wrap(async (req, res) => {
    res.json({
      editable: false,
      why: "configuration comes from .env, which the service wrapper freezes at install time; change it there and re-register the service",
      database: {
        store: config.store,
        server: process.env.DB_SERVER || null,
        instance: process.env.DB_INSTANCE || null,
        database: process.env.DB_DATABASE || null,
        windowsAuth: String(process.env.DB_WINDOWS_AUTH || "") === "true",
        encrypt: String(process.env.DB_ENCRYPT || "") === "true",
        trustServerCertificate: String(process.env.DB_TRUST_CERT || "") === "true",
        passwordSet: Boolean(process.env.DB_PASSWORD),
      },
      directory: {
        authMode: config.authMode,
        url: config.ldap.url || null,
        baseDN: config.ldap.baseDN || null,
        domain: config.ldap.domain || null,
        upnSuffix: config.ldap.upnSuffix || null,
        bindDN: config.ldap.bindDN || null,
        bindPasswordSet: Boolean(config.ldap.bindPassword),
        bindPasswordSealed: String(process.env.LDAP_BIND_PASSWORD || "").startsWith("enc:v1:"),
        timeoutMs: config.ldap.timeoutMs,
      },
    });
  }));

  /** Prove the directory is reachable and the service account still binds. */
  app.post("/api/admin/connection/test-directory", requireRole("admin"), wrap(async (req, res) => {
    if (!adminProbes || !adminProbes.directory) return fail(res, "probe_unavailable", "directory testing is not configured on this deployment", 503);
    const started = Date.now();
    try {
      const detail = await adminProbes.directory();
      await auditFrom(req, { actor: req.session.principal, action: "directory.test", subject: "ok" });
      res.json({ ok: true, ms: Date.now() - started, ...detail });
    } catch (err) {
      /* 200 with ok:false, not a 5xx. The probe RAN and produced a result; the
         result is "it failed", which the screen must render rather than treat
         as the screen itself being broken. */
      await auditFrom(req, { actor: req.session.principal, action: "directory.test", subject: "failed: " + (err.code || err.message) });
      res.json({ ok: false, ms: Date.now() - started, code: err.code || null, message: err.message });
    }
  }));

  /* ---- database ---------------------------------------------------------- */
  app.get("/api/admin/database", requireRole("admin"), wrap(async (req, res) => {
    if (!adminProbes || !adminProbes.database) {
      return res.json({ store: config.store, up: null, tables: [], migrations: { applied: [] } });
    }
    const out = { store: config.store, tables: [], migrations: { applied: [] } };
    try { Object.assign(out, await adminProbes.database({ withTables: true })); }
    catch (err) { out.up = false; out.detail = err.message; }
    if (adminProbes.migrations) {
      try { out.migrations = await adminProbes.migrations(); } catch { /* rendered as empty */ }
    }
    res.json(out);
  }));

  /* ---- logs -------------------------------------------------------------- */
  /**
   * The tail of the service logs. Read-only and capped: the wrapper writes
   * these files and they reach tens of megabytes, so sending one whole would
   * stall the browser and the request. A tail is what gets read anyway.
   */
  app.get("/api/admin/logs", requireRole("admin"), wrap(async (req, res) => {
    if (!adminProbes || !adminProbes.logs) return fail(res, "logs_unavailable", "log reading is not configured on this deployment", 503);
    const which = String(req.query.which || "out");
    const lines = Math.min(2000, Math.max(10, Number(req.query.lines) || 300));
    res.json(await adminProbes.logs({ which, lines }));
  }));

  /* ---- security ---------------------------------------------------------- */
  /**
   * The posture of the application itself, not of the portfolio.
   *
   * Every line is something an auditor asks and an operator would otherwise
   * answer by reading configuration files: how sessions expire, whether the
   * bind password is sealed, whether the directory is reached over TLS, and
   * who holds admin.
   */
  app.get("/api/admin/security", requireRole("admin"), wrap(async (req, res) => {
    const grants = userRoleMapping ? await userRoleMapping.getMap() : {};
    const groupMap = await roleMapping.getMap();
    const adminGrants = Object.entries(grants).filter(([, r]) => r === "admin").map(([p]) => p);
    const adminGroups = Object.entries(groupMap).filter(([, r]) => r === "admin").map(([g]) => g);
    res.json({
      authentication: {
        mode: config.authMode,
        ssoEnabled: config.ssoEnabled,
        directoryOverTls: String(config.ldap.url || "").startsWith("ldaps://"),
        serviceAccountConfigured: Boolean(config.ldap.bindDN),
        bindPasswordSealed: String(process.env.LDAP_BIND_PASSWORD || "").startsWith("enc:v1:"),
      },
      sessions: {
        idleMinutes: config.sessionIdleMinutes,
        absoluteHours: config.sessionAbsoluteHours,
      },
      authorisation: {
        refusesWithoutRole: true,
        adminGroups,
        adminGrants,
        /* The number that matters: if this reaches zero nobody can reach this
           screen, and the way back is Grant-Role.cmd on the host. */
        adminRoutesTotal: adminGroups.length + adminGrants.length,
      },
      warnings: config.warnings || [],
    });
  }));

  app.get("/api/admin/directory", requireRole("admin"), wrap(async (req, res) => {
    if (!searchDirectory) return fail(res, "directory_search_unavailable", "directory search is not configured on this deployment", 503);
    res.json(await searchDirectory(String(req.query.q || "")));
  }));

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
