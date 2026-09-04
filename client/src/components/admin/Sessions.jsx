/*
 * Who is signed in right now.
 *
 * Mirrors DEDB's Sessions.jsx. Deliberately shows no session id: that is a
 * bearer token, and a screen displaying one would be a screen handing it over.
 * Revocation is therefore by principal, which also matches what an admin
 * actually wants - "get this person out", not "kill this one browser tab".
 */
import { useCallback, useEffect, useState } from "react";
import { get, del, when, since } from "./api.js";

export default function Sessions({ me, onError }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    try { setRows(await get("/api/admin/sessions")); onError(null); }
    catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  async function revoke(principal) {
    setBusy(true);
    try { await del(`/api/admin/sessions/${encodeURIComponent(principal)}`); setConfirming(null); await load(); onError(null); }
    catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  const mine = String(me?.principal || "").toLowerCase();

  return (
    <section className="card panel r-card">
      <div className="panel-head">
        <h3 className="r-h2">Live sessions</h3>
        <button type="button" className="btn" onClick={load}>Refresh</button>
      </div>
      <p className="meta">
        Everyone with a session that has not expired and has been active inside the idle
        window. Revoking signs every one of that person's sessions out immediately; they
        can sign back in unless their role has also been removed.
      </p>

      {!rows && <p className="meta">Loading…</p>}
      {rows && !rows.length && <p className="meta">Nobody is signed in.</p>}

      {!!rows?.length && (
        <div className="r-table-scroll">
          <table className="projects">
            <thead><tr>
              <th scope="col">Person</th>
              <th scope="col">Role</th>
              <th scope="col">Last seen</th>
              <th scope="col" className="r-col-qhd">Expires</th>
              <th scope="col" className="r-col-4k">Address</th>
              <th scope="col">Actions</th>
            </tr></thead>
            <tbody>
              {rows.map((s, i) => {
                const isMe = String(s.principal || "").toLowerCase() === mine;
                return (
                  <tr key={`${s.principal}-${i}`}>
                    <td>
                      {s.displayName || s.principal}
                      <div className="cell-sub">{s.principal}{isMe && " — you"}</div>
                    </td>
                    <td><span className={`chip ${s.role === "admin" ? "solid" : ""}`}>{s.role}</span></td>
                    <td>{since(s.lastSeenAt)}<div className="cell-sub">{when(s.lastSeenAt)}</div></td>
                    <td className="meta r-col-qhd">{when(s.expiresAt)}</td>
                    <td className="meta r-col-4k">{s.lastIp || "—"}</td>
                    <td>
                      {confirming === s.principal ? (
                        <>
                          <button type="button" className="btn primary" disabled={busy}
                            onClick={() => revoke(s.principal)}>
                            {busy ? "…" : (isMe ? "Sign myself out" : "Confirm")}
                          </button>{" "}
                          <button type="button" className="btn" onClick={() => setConfirming(null)}>Cancel</button>
                        </>
                      ) : (
                        /* Two steps on purpose. Revoking your own session logs you
                           out of the screen you are standing on, and revoking
                           someone else's interrupts whatever they were doing. */
                        <button type="button" className="btn" disabled={busy}
                          onClick={() => setConfirming(s.principal)}>
                          {isMe ? "Sign out" : "Revoke"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
