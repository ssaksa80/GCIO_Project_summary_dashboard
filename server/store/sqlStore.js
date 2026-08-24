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
export class SqlStore {
  /**
   * @param {{projects: object, posture: object}} repos
   * @param {{logger?: object}} [options]
   */
  constructor(repos, { logger = console } = {}) {
    this.repos = repos;
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
   * Persist one workbook's parse result, then refresh the read model.
   * @param {{file: string, projects: object[], posture?: object[]}} result
   */
  async applyFile(result) {
    await this.repos.projects.replaceForFile(result.file, result.projects);
    await this.repos.posture.replaceForFile(result.file, result.posture || []);
    this.lastIngestAt = new Date().toISOString();
    await this.refresh();
    this.log({
      file: result.file,
      ok: true,
      projects: result.projects.length,
      postureDomains: (result.posture || []).length,
    });
    return result.projects.length;
  }

  /** Forget a workbook that was deleted from the drop folder. */
  async removeFile(sourceFile) {
    const removed = await this.repos.projects.removeFile(sourceFile);
    await this.repos.posture.removeFile(sourceFile);
    this.lastIngestAt = new Date().toISOString();
    await this.refresh();
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
