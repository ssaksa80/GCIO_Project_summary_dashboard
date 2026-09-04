/*
 * Who did what.
 *
 * Mirrors DEDB's Audit.jsx. This is the screen that answers questions asked
 * weeks later - who granted that role, who signed in from where, which upload
 * changed the portfolio. Reading it is itself recorded server-side, which is
 * why the list refreshes rather than polling: an audit trail that logs a reader
 * every few seconds buries the events worth seeing.
 */
import { useCallback, useEffect, useState } from "react";
import { get, when } from "./api.js";

/* Grouped so a reader can ask a question rather than remember an action name. */
const FILTERS = [
  ["", "Everything"],
  ["signin", "Sign-ins"],
  ["signin.denied", "Refused"],
  ["signin.failed", "Failed"],
  ["authz.grant", "Roles granted"],
  ["authz.revoke", "Roles revoked"],
  ["upload", "Uploads"],
  ["session.revoked", "Sessions revoked"],
];

/* Anything that denies, fails or removes is worth the eye landing on it. */
const ALARMING = /denied|failed|revoke|unmap/i;

export default function Audit({ onError }) {
  const [events, setEvents] = useState(null);
  const [action, setAction] = useState("");
  const [limit, setLimit] = useState(200);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (action) qs.set("action", action);
      const body = await get(`/api/audit?${qs}`);
      setEvents(body.events || []);
      onError(null);
    } catch (e) { onError(e.message); }
  }, [action, limit, onError]);

  useEffect(() => { load(); }, [load]);

  return (
    <section className="card panel r-card">
      <div className="panel-head">
        <h3 className="r-h2">Audit trail</h3>
        <span className="micro">{events ? `${events.length} events` : ""}</span>
      </div>
      <p className="meta">
        Sign-ins, role changes, uploads and revocations. Reading this page is itself
        recorded — an audit trail that does not log its own readers answers
        “who saw this” with silence.
      </p>

      <div className="filter-row">
        <label className="field">
          <span className="micro">Show</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {FILTERS.map(([v, label]) => <option key={v || "all"} value={v}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="micro">Most recent</span>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 200, 500, 1000].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="button" className="btn" onClick={load}>Refresh</button>
      </div>

      {!events && <p className="meta">Loading…</p>}
      {events && !events.length && <p className="meta">No events match that filter.</p>}

      {!!events?.length && (
        <div className="r-table-scroll">
          <table className="projects">
            <thead><tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">Who</th>
              <th scope="col">Detail</th>
            </tr></thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={`${e.at || e.At}-${i}`}>
                  <td className="meta">{when(e.at || e.At)}</td>
                  <td>
                    <span className={`chip ${ALARMING.test(String(e.action || e.Action)) ? "critical" : ""}`}>
                      {e.action || e.Action}
                    </span>
                  </td>
                  <td>{e.actor || e.Actor || "—"}</td>
                  <td className="meta">{e.subject || e.Subject || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
