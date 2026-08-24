/**
 * In-memory portfolio store with file-ownership tracking, ingest log,
 * SSE listener registry, and atomic snapshot persistence.
 * The single mutable-state holder of the application (SPEC §1, §3).
 */
import fs from "node:fs";
import path from "node:path";

const CHILD_KEYS = ["milestones", "updates", "risks"];

/** Dedupe keys for merged child collections. */
const childKey = {
  milestones: (m) => `${m.name}|${m.dueDate || ""}`,
  updates: (u) => `${u.date || ""}|${u.text}`,
  risks: (r) => `${r.title}`,
};

export class Store {
  constructor() {
    /** @type {Map<string, object>} id -> canonical project */
    this.projects = new Map();
    /** @type {Map<string, Set<string>>} sourceFile -> ids last seen in it */
    this.fileIndex = new Map();
    /** @type {Array<object>} newest-first ring buffer, max 50 */
    this.ingestLog = [];
    this.lastIngestAt = null;
    this.demoMode = false;
    /** @type {Set<function>} SSE listeners: fn(eventName, payload) */
    this.listeners = new Set();
  }

  /** All projects as an array. */
  all() {
    return [...this.projects.values()];
  }

  get(id) {
    return this.projects.get(String(id || "").toUpperCase()) || null;
  }

  get projectCount() {
    return this.projects.size;
  }

  get fileCount() {
    return this.fileIndex.size;
  }

  /**
   * Upsert one file's normalized projects, honoring the duplicate-id merge
   * rule (later lastUpdated wins, child arrays merged) and removing projects
   * this file previously owned but no longer provides.
   */
  upsertFromFile(sourceFile, incoming) {
    const newIds = new Set(incoming.map((p) => p.id));
    const previous = this.fileIndex.get(sourceFile) || new Set();
    for (const id of previous) {
      const existing = this.projects.get(id);
      if (!newIds.has(id) && existing && existing.sourceFile === sourceFile) {
        this.projects.delete(id);
      }
    }
    for (const project of incoming) {
      const existing = this.projects.get(project.id);
      if (!existing) {
        this.projects.set(project.id, project);
        continue;
      }
      const keepIncoming = (project.lastUpdated || "") >= (existing.lastUpdated || "");
      const winner = keepIncoming ? project : existing;
      const loser = keepIncoming ? existing : project;
      const merged = { ...loser, ...stripEmpty(winner) };
      for (const key of CHILD_KEYS) {
        merged[key] = mergeChildren(existing[key], project[key], childKey[key]);
      }
      this.projects.set(project.id, merged);
    }
    this.fileIndex.set(sourceFile, newIds);
  }

  /** Remove every project owned by a deleted source file. */
  removeFile(sourceFile) {
    let removed = 0;
    for (const [id, project] of this.projects) {
      if (project.sourceFile === sourceFile) {
        this.projects.delete(id);
        removed += 1;
      }
    }
    this.fileIndex.delete(sourceFile);
    return removed;
  }

  /** Record an ingest event (newest first, capped at 50). */
  log(entry) {
    this.ingestLog.unshift({ at: new Date().toISOString(), ...entry });
    if (this.ingestLog.length > 50) this.ingestLog.length = 50;
  }

  /** Broadcast an event to every SSE listener; a bad listener never throws. */
  emit(event, payload) {
    for (const listener of this.listeners) {
      try {
        listener(event, payload);
      } catch {
        this.listeners.delete(listener);
      }
    }
  }

  /** Atomically persist a snapshot next to the watched data (data/.cache.json). */
  saveCache(dataDir) {
    try {
      const file = path.join(dataDir, ".cache.json");
      const tmp = `${file}.tmp`;
      const snapshot = {
        savedAt: new Date().toISOString(),
        demoMode: this.demoMode,
        projects: this.all(),
        fileIndex: [...this.fileIndex.entries()].map(([f, ids]) => [f, [...ids]]),
      };
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`[store] cache save failed: ${err.message}`);
    }
  }

  /** Load a previous snapshot; returns true when projects were restored. */
  loadCache(dataDir) {
    try {
      const file = path.join(dataDir, ".cache.json");
      if (!fs.existsSync(file)) return false;
      const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(snapshot.projects) || snapshot.projects.length === 0) return false;
      for (const project of snapshot.projects) this.projects.set(project.id, project);
      for (const [f, ids] of snapshot.fileIndex || []) this.fileIndex.set(f, new Set(ids));
      this.demoMode = Boolean(snapshot.demoMode);
      this.lastIngestAt = snapshot.savedAt;
      return true;
    } catch (err) {
      console.error(`[store] cache load failed: ${err.message}`);
      return false;
    }
  }
}

/** Drop empty-ish fields so a merge never overwrites data with blanks. */
function stripEmpty(project) {
  const out = {};
  for (const [key, value] of Object.entries(project)) {
    if (CHILD_KEYS.includes(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    out[key] = value;
  }
  return out;
}

/** Union two child arrays, deduped by the collection's identity key. */
function mergeChildren(a = [], b = [], keyFn) {
  const seen = new Map();
  for (const item of [...(a || []), ...(b || [])]) {
    if (item) seen.set(keyFn(item), item);
  }
  return [...seen.values()];
}
