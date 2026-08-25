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
    if (!this.tracksHistory) {
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

    /* The run is opened before anything else can fail. Vaulting the bytes and
       recording the source file can both throw, and if the run were opened
       after them the one failure mode that happens first would be the one this
       table cannot explain. The source file is attached when the run closes. */
    const runId = await this.repos.ingestRuns.start({ fileName: result.file, trigger });

    /* "failed" would otherwise mean two different things: nothing happened, or
       the dashboard moved and only the history is missing. An operator reading
       the run needs to know which. */
    let snapshotWritten = false;

    try {
      const vaulted = this.vault && result.bytes
        ? this.vault.store(result.bytes, result.file)
        : null;

      /* Read the newest hash BEFORE recording this one, or it compares the file
         against itself and every ingest looks unchanged. */
      const unchanged = vaulted
        ? (await this.repos.sourceFiles.newestHashFor(result.file)) === vaulted.hash
        : false;

      const recorded = vaulted
        ? await this.repos.sourceFiles.record({
            fileName: result.file, sha256: vaulted.hash, bytes: vaulted.bytes,
            vaultPath: vaulted.vaultPath, uploadedBy: actor,
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

      await this.repos.projects.replaceForFile(result.file, result.projects);
      await this.repos.posture.replaceForFile(result.file, result.posture || []);
      snapshotWritten = true;

      const changed = await this.repos.projectVersions.appendChanged(
        result.projects.map((project) => ({ project, hash: hashProject(project) })),
        { ingestRunId: runId }
      );

      this.lastIngestAt = new Date().toISOString();
      await this.refresh();

      await this.repos.ingestRuns.finish(runId, {
        outcome: "applied",
        projectsSeen: result.projects.length,
        projectsChanged: changed,
        postureRows: (result.posture || []).length,
        sourceFileId: recorded.sourceFileId,
      });

      this.log({
        file: result.file, ok: true,
        projects: result.projects.length, changed,
        postureDomains: (result.posture || []).length,
      });
      return result.projects.length;
    } catch (err) {
      const reason = snapshotWritten
        ? `snapshot applied but history not recorded: ${err.message}`
        : err.message;
      await this.repos.ingestRuns.finish(runId, { outcome: "failed", error: reason });
      this.log({ file: result.file, ok: false, error: reason });
      throw err;
    }
  }

  /** Forget a workbook that was deleted from the drop folder. */
  async removeFile(sourceFile) {
    const runId = this.tracksHistory
      ? await this.repos.ingestRuns.start({ fileName: sourceFile, trigger: "watcher" })
      : null;

    const removed = await this.repos.projects.removeFile(sourceFile);
    await this.repos.posture.removeFile(sourceFile);
    this.lastIngestAt = new Date().toISOString();
    await this.refresh();

    if (runId !== null) {
      await this.repos.ingestRuns.finish(runId, { outcome: "removed", projectsSeen: removed });
    }
    this.log({ file: sourceFile, ok: true, removed });
    return removed;
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
