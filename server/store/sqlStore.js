/**
 * SQL-backed portfolio store.
 *
 * SQL Server is the system of record; this keeps a read model in memory and
 * refreshes it whenever an ingest changes something. Two reasons:
 *
 *   - the section engine is synchronous, pure and well tested. Making it async
 *     to reach a database would ripple through every builder and every test for
 *     no benefit at this size (≤5,000 projects is a few MB).
 *   - a database outage then degrades to "the dashboard still shows the last
 *     known portfolio" instead of a blank screen, which is what an executive
 *     dashboard should do.
 *
 * It presents the same read surface as the in-memory Store, so app.js and the
 * domain code cannot tell which one they were given.
 */
import { hashProject } from "../ingest/hash.js";
import { compareVersions } from "../changes.js";

export class SqlStore {
  /**
   * @param {{projects: object, posture: object, sourceFiles?: object,
   *          ingestRuns?: object, projectVersions?: object}} repos
   * @param {{vault?: object, logger?: object}} [options]
   */
  constructor(repos, { vault = null, logger = console } = {}) {
    this.repos = repos;
    this.vault = vault;
    this.logger = logger;

    /** @type {Map<string, object>} the read model */
    this.projectsById = new Map();
    /** @type {object[]} */
    this.postureRows = [];
    /** @type {Set<function>} SSE listeners: fn(eventName, payload) */
    this.listeners = new Set();
    /** @type {Array<object>} newest-first, capped */
    this.ingestLog = [];

    this.lastIngestAt = null;
    this.demoMode = false;
    this.sourceFiles = new Set();
    this.ready = false;
  }

  /** True when the database has the Phase 1 history tables wired in. */
  get tracksHistory() {
    return Boolean(this.repos.sourceFiles && this.repos.ingestRuns && this.repos.projectVersions);
  }

  /* ----------------------------------------------------------- read side */

  all() {
    return [...this.projectsById.values()];
  }

  get(id) {
    return this.projectsById.get(String(id || "").toUpperCase()) || null;
  }

  posture() {
    return this.postureRows;
  }

  get projectCount() {
    return this.projectsById.size;
  }

  get fileCount() {
    return this.sourceFiles.size;
  }

  /**
   * What moved since a date, ready for the section engine.
   *
   * Returns null — NOT an empty Map — when this store keeps no history. Empty
   * means "nothing moved"; null means "we cannot know", and the briefing says
   * something different for each. Conflating them would have the dashboard
   * quietly assert that a portfolio was stable during a period it has no
   * record of.
   *
   * @param {string} sinceISO YYYY-MM-DD
   * @returns {Promise<Map<string, object>|null>}
   */
  async changesSince(sinceISO) {
    if (!this.repos.projectVersions) return null;

    const raw = await this.repos.projectVersions.changedSince(sinceISO);
    const changes = new Map();

    for (const [projectId, entry] of raw) {
      if (!entry.baseline) {
        /* Known only from inside the period. Say when, and say nothing else. */
        changes.set(projectId, { trackedSince: entry.trackedSince, current: entry.current });
        continue;
      }
      const compared = compareVersions(entry.baseline, entry.current);
      if (compared) changes.set(projectId, { ...compared, since: entry.baseline.recordedAt });
    }
    return changes;
  }

  /**
   * The oldest recorded version, so the briefing can say how far back it knows.
   *
   * The `?.` is deliberate, not the same guard style as changedSince above by
   * accident: changedSince is an established contract every real
   * projectVersions repository already implements, while oldestRecordedAt is
   * brand new in this same change. A fixture built before it existed should
   * not throw here.
   */
  async historyStartedAt() {
    if (!this.repos.projectVersions?.oldestRecordedAt) return null;
    return this.repos.projectVersions.oldestRecordedAt();
  }

  /* ---------------------------------------------------------- write side */

  /** Load the read model from SQL. Called at boot and after every ingest. */
  async refresh() {
    const [projects, posture] = await Promise.all([
      this.repos.projects.all(),
      this.repos.posture.list(),
    ]);

    this.projectsById = new Map(projects.map((p) => [p.id, p]));
    this.postureRows = posture;
    this.sourceFiles = new Set(projects.map((p) => p.sourceFile).filter(Boolean));
    this.ready = true;
    return this.projectCount;
  }

  /** Phase 0 behaviour, unchanged: no history tables, so nothing to record. */
  async #applyWithoutHistory(result) {
    await this.repos.projects.replaceForFile(result.file, result.projects);
    await this.repos.posture.replaceForFile(result.file, result.posture || []);
    this.lastIngestAt = new Date().toISOString();
    await this.refresh();
    this.log({
      file: result.file, ok: true,
      projects: result.projects.length,
      postureDomains: (result.posture || []).length,
    });
    return result.projects.length;
  }

  /**
   * Persist one workbook's parse result and record what happened.
   *
   * Order matters: the bytes go to the vault first, so a crash midway leaves a
   * replayable file rather than a half-written portfolio and no source.
   *
   * @param {{file: string, projects: object[], posture?: object[], bytes?: Buffer}} result
   * @param {{trigger?: "watcher"|"upload"|"boot"|"replay", actor?: string}} [context]
   */
  async applyFile(result, { trigger = "watcher", actor = null } = {}) {
    if (!this.tracksHistory) return this.#applyWithoutHistory(result);

    /* The run is opened before anything else can fail. Vaulting the bytes and
       recording the source file can both throw, and if the run were opened
       after them the one failure mode that happens first would be the one this
       table cannot explain. The source file is attached when the run closes. */
    const runId = await this.repos.ingestRuns.start({ fileName: result.file, trigger });

    /* Which of these is true changes what a failure means, and an operator
       reading the run needs the difference: "opening" means nothing landed
       anywhere, "snapshot" means dbo.Project moved but history did not,
       "history" means both moved but the run itself could not be closed, and
       "closed" means everything — including the run's own outcome — is
       already correct and only the in-memory read model is in question. */
    let stage = "opening";

    try {
      const vaulted = this.vault && result.bytes
        ? this.vault.store(result.bytes, result.file)
        : null;

      /* Not "have I seen these bytes" — "is this content what the dashboard is
         actually showing". A hash recorded by an ingest that then failed must
         not let the retry be skipped: SourceFile remembers bytes unconditionally
         the moment they are vaulted, whether or not the ingest that vaulted them
         ever reached dbo.Project, so it cannot be the oracle for "unchanged".
         liveHashFor looks at the last CLOSED run instead, which is the only
         place that ties a hash to content actually applied. */
      const liveHash = await this.repos.ingestRuns.liveHashFor(result.file);
      const unchanged = Boolean(vaulted) && liveHash === vaulted.hash;

      const recorded = vaulted
        ? await this.repos.sourceFiles.record({
            fileName: result.file, sha256: vaulted.hash, bytes: vaulted.bytes,
            vaultPath: vaulted.vaultPath,
            /* Always null today: applyFile is only ever called with trigger
               "boot" or "watcher". The upload route writes into the watched
               folder and lets the watcher pick the file up rather than calling
               in with an actor, so "who uploaded this" is recoverable only by
               cross-referencing the audit log by timestamp. Deliberate, not a
               bug — see the comment beside INGEST_TRIGGERS in ingestRuns.js. */
            uploadedBy: actor,
          })
        : { sourceFileId: null };

      if (unchanged) {
        await this.repos.ingestRuns.finish(runId, {
          outcome: "unchanged",
          projectsSeen: result.projects.length,
          sourceFileId: recorded.sourceFileId,
        });
        this.log({ file: result.file, ok: true, unchanged: true });
        return 0;
      }

      /* Starts after the vault write and stops before refresh(): refreshing the
         in-memory read model is not part of persisting, and including it would
         make this number mean something different from what the metric claims. */
      const persistStartedAt = performance.now();

      await this.repos.projects.replaceForFile(result.file, result.projects);
      await this.repos.posture.replaceForFile(result.file, result.posture || []);
      stage = "snapshot";

      const changed = await this.repos.projectVersions.appendChanged(
        result.projects.map((project) => ({ project, hash: hashProject(project) })),
        { ingestRunId: runId }
      );
      stage = "history";
      const persistMs = Math.round(performance.now() - persistStartedAt);

      await this.repos.ingestRuns.finish(runId, {
        outcome: "applied",
        projectsSeen: result.projects.length,
        projectsChanged: changed,
        postureRows: (result.posture || []).length,
        sourceFileId: recorded.sourceFileId,
        parseMs: result.parseMs ?? null,
        persistMs,
      });
      stage = "closed";

      this.lastIngestAt = new Date().toISOString();
      await this.refresh();

      this.log({
        file: result.file, ok: true,
        projects: result.projects.length, changed,
        postureDomains: (result.posture || []).length,
      });
      return result.projects.length;
    } catch (err) {
      if (stage === "closed") {
        /* Every table is correct and the run itself says so. Only the
           in-memory read model is stale, and overwriting a true "applied" with
           "failed" would tell an operator the opposite of what happened. */
        this.logger.error?.(`[ingest] ${result.file} was applied, but refreshing the read model failed: ${err.message}`);
        this.log({ file: result.file, ok: true, staleReadModel: true, error: err.message });
        throw err;
      }

      const reason = stage === "history"
        ? `snapshot and history applied but the run could not be closed: ${err.message}`
        : stage === "snapshot"
          ? `snapshot applied but history not recorded: ${err.message}`
          : err.message;

      /* finish() may itself be what failed; if it fails again there is nothing
         further we can do, and the open run left behind is itself the signal. */
      try {
        await this.repos.ingestRuns.finish(runId, { outcome: "failed", error: reason });
      } catch (closeErr) {
        this.logger.error?.(`[ingest] could not close run ${runId}: ${closeErr.message}`);
      }
      this.log({ file: result.file, ok: false, error: reason });
      throw err;
    }
  }

  /** Forget a workbook that was deleted from the drop folder. */
  async removeFile(sourceFile) {
    const runId = this.tracksHistory
      ? await this.repos.ingestRuns.start({ fileName: sourceFile, trigger: "watcher" })
      : null;

    /* Unlike applyFile there is no snapshot/history split to distinguish —
       only whether the run already closed with its true outcome before
       something later (the read-model refresh) failed. */
    let closed = false;

    try {
      const removed = await this.repos.projects.removeFile(sourceFile);
      await this.repos.posture.removeFile(sourceFile);

      if (runId !== null) {
        await this.repos.ingestRuns.finish(runId, { outcome: "removed", projectsSeen: removed });
        closed = true;
      }

      this.lastIngestAt = new Date().toISOString();
      await this.refresh();
      this.log({ file: sourceFile, ok: true, removed });
      return removed;
    } catch (err) {
      if (closed) {
        /* The removal and the run's own outcome are both already correct.
           Only the in-memory read model is stale, and overwriting a true
           "removed" with "failed" would tell an operator the opposite of
           what happened. */
        this.logger.error?.(`[ingest] ${sourceFile} was removed, but refreshing the read model failed: ${err.message}`);
        this.log({ file: sourceFile, ok: true, staleReadModel: true, error: err.message });
        throw err;
      }

      /* An open run is invisible to liveHashFor, which filters on a closed
         outcome — so an abandoned removal would leave the old hash looking
         live while the rows are already gone, and re-dropping the same
         workbook would be skipped as unchanged. */
      if (runId !== null) {
        try {
          await this.repos.ingestRuns.finish(runId, { outcome: "failed", error: `removal failed: ${err.message}` });
        } catch (closeErr) {
          this.logger.error?.(`[ingest] could not close run ${runId}: ${closeErr.message}`);
        }
      }
      this.log({ file: sourceFile, ok: false, error: err.message });
      throw err;
    }
  }

  /**
   * Record a workbook that never got as far as being applied.
   *
   * A parse failure otherwise leaves no trace in dbo.IngestRun, which makes a
   * corrupt file indistinguishable from a file nobody ever sent. Both look like
   * silence to an administrator, and only one of them is their problem.
   *
   * @param {string} fileName
   * @param {string} reason
   * @param {{trigger?: "watcher"|"upload"|"boot"|"replay"}} [context]
   */
  async recordRejectedFile(fileName, reason, { trigger = "watcher" } = {}) {
    this.log({ file: fileName, ok: false, error: reason });
    if (!this.tracksHistory) return;

    try {
      const runId = await this.repos.ingestRuns.start({ fileName, trigger });
      await this.repos.ingestRuns.finish(runId, { outcome: "failed", error: `could not parse: ${reason}` });
    } catch (err) {
      /* Recording the rejection must never be what stops the watcher; the
         console line is still there either way. */
      this.logger.error?.(`[ingest] could not record the rejection of ${fileName}: ${err.message}`);
    }
  }

  /* -------------------------------------------------- parity with Store */

  log(entry) {
    this.ingestLog.unshift({ at: new Date().toISOString(), ...entry });
    if (this.ingestLog.length > 50) this.ingestLog.length = 50;
  }

  emit(event, payload) {
    for (const listener of this.listeners) {
      try {
        listener(event, payload);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  /** The database is the snapshot, so these are deliberately no-ops. */
  saveCache() { /* SQL is the durable record */ }
  loadCache() { return false; }
}
