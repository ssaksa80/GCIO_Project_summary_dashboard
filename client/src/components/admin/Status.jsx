/*
 * Is it healthy, and did last night's file land?
 *
 * Mirrors DEDB's Status.jsx. The ingest table is the point: the question an
 * operator actually arrives with is "the dashboard has not changed, why", and
 * the answer is always one of three things - there is no run, there is a run
 * that failed, or there is a run that succeeded and the file held nothing new.
 * All three are visible here without opening a log.
 */
import { useCallback, useEffect, useState } from "react";
import { get, when, since } from "./api.js";

function secondsToSpan(s) {
  if (s == null) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Status({ onError }) {
  const [health, setHealth] = useState(null);
  const [ready, setReady] = useState(null);
  const [runs, setRuns] = useState(null);

  const load = useCallback(async () => {
    try {
      /* Settled, not all: /api/ingest/runs is admin-only and history may be off
         entirely, and neither should blank the health tiles beside it. */
      const [h, r, i] = await Promise.allSettled([
        get("/healthz"), get("/readyz"), get("/api/ingest/runs?limit=25"),
      ]);
      setHealth(h.status === "fulfilled" ? h.value : null);
      setReady(r.status === "fulfilled" ? r.value : null);
      setRuns(i.status === "fulfilled" ? i.value : { historyEnabled: false, runs: [] });
      onError(null);
    } catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <section className="card panel r-card">
        <div className="panel-head">
          <h3 className="r-h2">Service</h3>
          <button type="button" className="btn" onClick={load}>Refresh</button>
        </div>
        <div className="r-grid admin-tiles">
          <div className="card admin-tile">
            <span className="micro">STATUS</span>
            <div className="r-h2">{health?.status === "ok" ? "Healthy" : health ? health.status : "—"}</div>
            <div className="meta">version {health?.version || "—"}</div>
          </div>
          <div className="card admin-tile">
            <span className="micro">UPTIME</span>
            <div className="r-h2">{secondsToSpan(health?.uptimeSec)}</div>
            <div className="meta">since the last restart</div>
          </div>
          <div className="card admin-tile">
            <span className="micro">PORTFOLIO</span>
            <div className="r-h2">{ready?.projects ?? "—"}</div>
            <div className="meta">{ready?.ready ? "ready to serve" : "not ready"}</div>
          </div>
          <div className="card admin-tile">
            <span className="micro">LAST INGEST</span>
            <div className="r-h2">{ready?.lastIngestAt ? since(ready.lastIngestAt) : "never"}</div>
            <div className="meta">{ready?.lastIngestAt ? when(ready.lastIngestAt) : "no file has been ingested"}</div>
          </div>
        </div>
      </section>

      <section className="card panel r-card">
        <div className="panel-head">
          <h3 className="r-h2">Recent ingests</h3>
          <span className="micro">{runs?.runs ? `${runs.runs.length} runs` : ""}</span>
        </div>

        {!runs && <p className="meta">Loading…</p>}
        {runs && runs.historyEnabled === false && (
          <p className="meta">
            Run history is not recorded on this deployment — it needs the database-backed
            store. Uploads still work; only the record of them is absent.
          </p>
        )}
        {runs?.historyEnabled !== false && !runs?.runs?.length && (
          <p className="meta">
            No ingest has run. If a workbook was dropped and nothing changed, it never
            reached the watcher — check that DATA_DIR points at the folder being used.
          </p>
        )}

        {!!runs?.runs?.length && (
          <div className="r-table-scroll">
            <table className="projects">
              <thead><tr>
                <th scope="col">When</th>
                <th scope="col">File</th>
                <th scope="col">Outcome</th>
                <th scope="col" className="r-col-qhd">Projects</th>
                <th scope="col" className="r-col-4k">Trigger</th>
                <th scope="col" className="r-col-4k">Parse / persist</th>
              </tr></thead>
              <tbody>
                {runs.runs.map((r, i) => {
                  const ok = r.ok ?? (r.Outcome ? String(r.Outcome).toLowerCase() === "ok" : null);
                  return (
                    <tr key={r.id || r.Id || i}>
                      <td className="meta">{when(r.startedAt || r.StartedAt || r.at)}</td>
                      <td>{r.file || r.File || "—"}</td>
                      <td>
                        <span className={`chip ${ok === false ? "critical" : ok ? "" : "neutral"}`}>
                          {r.outcome || r.Outcome || (ok ? "ok" : "—")}
                        </span>
                        {(r.error || r.Error) && <div className="cell-sub critical-ink">{r.error || r.Error}</div>}
                      </td>
                      <td className="num r-col-qhd">{r.projects ?? r.Projects ?? "—"}</td>
                      <td className="meta r-col-4k">{r.trigger || r.Trigger || "—"}</td>
                      <td className="meta r-col-4k">
                        {(r.parseMs ?? r.ParseMs) != null ? `${r.parseMs ?? r.ParseMs} ms` : "—"}
                        {" / "}
                        {(r.persistMs ?? r.PersistMs) != null ? `${r.persistMs ?? r.PersistMs} ms` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
