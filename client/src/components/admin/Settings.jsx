/*
 * Settings an operator can change without a deploy.
 *
 * Mirrors DEDB's Settings screen, and above all its honesty about what a save
 * actually does. Some settings the running process re-reads; others apply only
 * to the next restart. The server returns which is which for the keys THIS save
 * touched, and the screen reports that verbatim rather than showing a green
 * tick and letting the operator wonder why nothing changed.
 *
 * Settings this build does not recognise are shown read-only instead of being
 * dropped. Hiding them is how they get deleted by the next save from an older
 * build.
 */
import { useCallback, useEffect, useState } from "react";
import { get, put } from "./api.js";

export default function Settings({ onError }) {
  const [rows, setRows] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await get("/api/admin/settings");
      setRows(r);
      setDraft(Object.fromEntries(r.map((s) => [s.key, s.value ?? ""])));
      onError(null);
    } catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  const changed = rows
    ? rows.filter((s) => !s.unknown && String(draft[s.key] ?? "") !== String(s.value ?? ""))
    : [];

  async function save() {
    if (!changed.length) return;
    setBusy(true);
    setResult(null);
    try {
      /* Only what actually changed. Sending the whole form would rewrite every
         row's UpdatedBy and UpdatedAt on every save, which destroys the record
         of who last touched a particular setting. */
      const body = Object.fromEntries(changed.map((s) => [s.key, draft[s.key]]));
      setResult(await put("/api/admin/settings", body));
      await load();
      onError(null);
    } catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="card panel r-card">
      <div className="panel-head">
        <h3 className="r-h2">Settings</h3>
        <button type="button" className="btn" onClick={load}>Reload</button>
      </div>
      <p className="meta">
        Stored in the database, not in <code>.env</code>. Connection details and secrets
        are deliberately not here — those live in the environment and are read before the
        database is reachable.
      </p>

      {result && (
        <div className="card admin-tile">
          <span className="micro">SAVED</span>
          <div className="meta">
            {result.appliedLive?.length
              ? <>Applied without a restart: <strong>{result.appliedLive.join(", ")}</strong>. </>
              : null}
            {result.needsRestart?.length
              ? <>Saved, and will apply when the service next restarts: <strong>{result.needsRestart.join(", ")}</strong>.</>
              : null}
          </div>
        </div>
      )}

      {!rows && <p className="meta">Loading…</p>}

      {!!rows?.length && (
        <>
          <div className="admin-settings">
            {rows.map((s) => (
              <label key={s.key} className="field admin-setting">
                <span className="micro">
                  {s.label}
                  {s.live ? <span className="chip neutral"> applies live</span>
                          : <span className="chip neutral"> needs a restart</span>}
                  {s.unknown && <span className="chip critical"> unknown to this build</span>}
                </span>
                {s.type === "enum" ? (
                  <select value={draft[s.key] ?? ""} disabled={s.unknown}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}>
                    <option value="">(not set)</option>
                    {(s.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input type={s.type === "number" ? "number" : "text"}
                    value={draft[s.key] ?? ""} disabled={s.unknown}
                    onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />
                )}
                {s.help && <span className="meta">{s.help}</span>}
                {s.unknown && (
                  <span className="meta">
                    Stored by a different build. Shown so it is not silently deleted; not editable here.
                  </span>
                )}
              </label>
            ))}
          </div>

          <button type="button" className="btn primary" disabled={busy || !changed.length} onClick={save}>
            {busy ? "Saving…" : changed.length ? `Save ${changed.length} change${changed.length > 1 ? "s" : ""}` : "No changes"}
          </button>
        </>
      )}
    </section>
  );
}
