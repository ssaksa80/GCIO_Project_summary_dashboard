/*
 * Who may use this application.
 *
 * Sign-in proves who someone is; it grants nothing. A person reaches the
 * dashboard only if a directory group maps to a role or an admin granted them
 * one here, and this screen is the second of those.
 *
 * The picker searches the directory rather than taking a typed name. A grant
 * written against a typo saves without complaint, shows correctly in the list,
 * and leaves the person refused at sign-in with nothing connecting the two.
 */
import { useCallback, useEffect, useRef, useState } from "react";

const ROLES = ["viewer", "pm", "admin"];
const ROLE_HELP = {
  viewer: "read the dashboard",
  pm: "read, and upload workbooks",
  admin: "everything, including this screen",
};

async function api(url, options) {
  const res = await fetch(url, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `request failed (${res.status})`);
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

export default function AdminConsole({ me, onClose }) {
  const [grants, setGrants] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [searchState, setSearchState] = useState("idle"); // idle | searching | failed
  const [searchError, setSearchError] = useState(null);
  const [picked, setPicked] = useState(null);
  const [role, setRole] = useState("viewer");

  const dialogRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const load = useCallback(async () => {
    try {
      setGrants(await api("/api/admin/user-roles"));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /* Focus the dialog on open and trap Tab inside it, matching ProjectDrawer.
     FOCUSABLE is re-queried per keypress because the picker's result list
     appears and disappears while the dialog is open. */
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const previouslyFocused = document.activeElement;
    node.focus();
    const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const onKey = (e) => {
      if (e.key === "Escape") { closeRef.current?.(); return; }
      if (e.key !== "Tab") return;
      const items = [...node.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      /* Only if it is still in the document: returning focus to a node React
         has already unmounted throws focus to <body> instead. */
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  /* Debounced, and every response is checked against the latest query before
     it is shown: two searches in flight can land out of order, and the slower
     one would otherwise overwrite results for what was actually typed. */
  useEffect(() => {
    const q = query.trim();
    if (!q) { setMatches([]); setSearchState("idle"); setSearchError(null); return; }
    let current = true;
    setSearchState("searching");
    const timer = setTimeout(async () => {
      try {
        const found = await api(`/api/admin/directory?q=${encodeURIComponent(q)}`);
        if (!current) return;
        setMatches(found);
        setSearchState("idle");
        setSearchError(null);
      } catch (e) {
        if (!current) return;
        /* "No matches" and "the directory is unreachable" call for different
           actions, so they must not look the same. */
        setMatches([]);
        setSearchState("failed");
        setSearchError(e.message);
      }
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [query]);

  async function grant() {
    if (!picked) return;
    setBusy(true);
    try {
      await api("/api/admin/user-roles", {
        method: "POST",
        body: JSON.stringify({ principal: picked.username, role }),
      });
      setPicked(null);
      setQuery("");
      setMatches([]);
      await load();
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(principal) {
    setBusy(true);
    try {
      await api(`/api/admin/user-roles/${encodeURIComponent(principal)}`, { method: "DELETE" });
      await load();
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const mySam = String(me?.principal || "").split("@")[0].split("\\").pop().toLowerCase();

  return (
    <div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div
        className="card modal admin-console"
        role="dialog"
        aria-modal="true"
        aria-label="Access — who may use this application"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="panel-head">
          <h2 className="display">Access</h2>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>

        <p className="meta">
          Signing in proves who someone is; it grants nothing. People reach the dashboard
          through a directory group, or through a grant made here.
        </p>

        {error && <div className="meta critical-ink" role="alert">{error}</div>}

        {/* ---- grant ---- */}
        <fieldset className="admin-grant">
          <legend className="micro">Give someone access</legend>

          <label className="field">
            <span className="micro">Find a person</span>
            <input
              type="text"
              value={query}
              placeholder="name, email or account name"
              autoComplete="off"
              onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
            />
          </label>

          {searchState === "searching" && <p className="meta">Searching the directory…</p>}
          {searchState === "failed" && (
            <p className="meta critical-ink" role="alert">
              Could not search the directory: {searchError}
            </p>
          )}
          {searchState === "idle" && query.trim() && !matches.length && !picked && (
            <p className="meta">No accounts match “{query.trim()}”.</p>
          )}

          {!!matches.length && !picked && (
            <ul className="admin-matches">
              {matches.map((m) => (
                <li key={m.username}>
                  <button type="button" className="btn" onClick={() => setPicked(m)}>
                    <strong>{m.name}</strong>
                    <span className="meta"> {m.username}{m.mail ? ` · ${m.mail}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {picked && (
            <div className="admin-picked">
              <p className="meta">
                <strong>{picked.name}</strong> ({picked.username})
                {" "}
                <button type="button" className="btn" onClick={() => setPicked(null)}>change</button>
              </p>
              <label className="field">
                <span className="micro">Role</span>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r} — {ROLE_HELP[r]}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn primary" disabled={busy} onClick={grant}>
                {busy ? "Saving…" : `Grant ${role}`}
              </button>
            </div>
          )}
        </fieldset>

        {/* ---- existing grants ---- */}
        <h3 className="micro">Direct grants</h3>
        {!grants && <p className="meta">Loading…</p>}
        {grants && !grants.length && (
          <p className="meta">
            Nobody has a direct grant. Everyone signing in today does so through a directory group.
          </p>
        )}
        {!!grants?.length && (
          <table className="projects admin-grants">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Role</th>
                <th scope="col">Granted by</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.Principal}>
                  <td>
                    {g.Principal}
                    {g.Principal.toLowerCase() === mySam && <span className="meta"> — you</span>}
                  </td>
                  <td><span className={`chip ${g.Role === "admin" ? "solid" : ""}`}>{g.Role}</span></td>
                  <td className="meta">{g.GrantedBy || "—"}</td>
                  <td>
                    <button type="button" className="btn" disabled={busy} onClick={() => revoke(g.Principal)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="meta">
          Revoking removes the grant only. Anyone whose role also comes from a directory group keeps it.
        </p>
      </div>
    </div>
  );
}
