/*
 * Who owns which part of the brief.
 *
 * Mirrors DEDB's Ownership screen. A grant names a person OR a directory group
 * and a section; ownership is resolved by matching the name against the
 * caller's principal and their group CNs.
 *
 * The type field is descriptive, not load-bearing — the resolver never filters
 * on it — so the screen says so rather than implying a group grant behaves
 * differently from a user grant. Pretending otherwise would be a UI that
 * describes a rule the server does not enforce.
 */
import { useCallback, useEffect, useState } from "react";
import { get, post, del, when } from "./api.js";

const SECTIONS = [
  ["successes", "Successes"],
  ["questions", "Questions, Risks & Issues"],
  ["priorities", "Priorities"],
  ["roadmap", "Roadmap / Planned"],
  ["posture", "Security Posture"],
];

export default function Ownership({ onError }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [principalType, setPrincipalType] = useState("user");
  const [principalName, setPrincipalName] = useState("");
  const [sectionKey, setSectionKey] = useState(SECTIONS[0][0]);

  const load = useCallback(async () => {
    try { setRows(await get("/api/admin/ownership")); onError(null); }
    catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  async function run(fn) {
    setBusy(true);
    try { await fn(); await load(); onError(null); }
    catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  const label = (k) => (SECTIONS.find(([id]) => id === k) || [k, k])[1];

  return (
    <section className="card panel r-card">
      <div className="panel-head">
        <h3 className="r-h2">Section ownership</h3>
        <span className="micro">{rows ? `${rows.length} grants` : ""}</span>
      </div>
      <p className="meta">
        Ownership is matched by name against the person signing in and every group they
        belong to. The type below records what you meant; it does not change how the
        match is made, so a name that is wrong owns nothing and reports nothing.
      </p>

      <fieldset className="admin-grant">
        <legend className="micro">Give someone a section</legend>
        <label className="field">
          <span className="micro">Type</span>
          <select value={principalType} onChange={(e) => setPrincipalType(e.target.value)}>
            <option value="user">user — an account name</option>
            <option value="group">group — a directory group CN</option>
          </select>
        </label>
        <label className="field">
          <span className="micro">Name</span>
          <input type="text" value={principalName} autoComplete="off"
            placeholder={principalType === "user" ? "jdoe" : "GCIO-Security-Owners"}
            onChange={(e) => setPrincipalName(e.target.value)} />
        </label>
        <label className="field">
          <span className="micro">Section</span>
          <select value={sectionKey} onChange={(e) => setSectionKey(e.target.value)}>
            {SECTIONS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
          </select>
        </label>
        <button type="button" className="btn primary" disabled={busy || !principalName.trim()}
          onClick={() => run(async () => {
            await post("/api/admin/ownership", {
              principalType, principalName: principalName.trim(), sectionKey,
            });
            setPrincipalName("");
          })}>
          {busy ? "Saving…" : "Grant"}
        </button>
      </fieldset>

      {!rows && <p className="meta">Loading…</p>}
      {rows && !rows.length && <p className="meta">Nobody owns a section yet.</p>}

      {!!rows?.length && (
        <div className="r-table-scroll">
          <table className="projects">
            <thead><tr>
              <th scope="col">Owner</th>
              <th scope="col">Type</th>
              <th scope="col">Section</th>
              <th scope="col" className="r-col-qhd">Granted by</th>
              <th scope="col" className="r-col-4k">When</th>
              <th scope="col">Actions</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.Id}>
                  <td>{r.PrincipalName}</td>
                  <td><span className="chip neutral">{r.PrincipalType}</span></td>
                  <td>{label(r.SectionKey)}</td>
                  <td className="meta r-col-qhd">{r.GrantedBy || "—"}</td>
                  <td className="meta r-col-4k">{when(r.GrantedAt)}</td>
                  <td>
                    <button type="button" className="btn" disabled={busy}
                      onClick={() => run(() => del(`/api/admin/ownership/${r.Id}`))}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
