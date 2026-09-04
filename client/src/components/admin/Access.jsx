/*
 * Who may use this application.
 *
 * Two sources, shown side by side because that is how they actually combine:
 * a directory group grants a role to everyone in it, a direct grant names one
 * person, and sign-in takes the HIGHER of the two. Showing only one of them
 * makes the other look broken - an admin removes a grant, the person still has
 * access through a group, and nothing on screen explains why.
 *
 * Mirrors DEDB's Roles.jsx, including its user picker; the group half is the
 * part GCIO previously had no screen for at all.
 */
import { useCallback, useEffect, useState } from "react";
import { get, post, del, when } from "./api.js";

const ROLES = ["viewer", "pm", "admin"];
const ROLE_HELP = {
  viewer: "read the dashboard",
  pm: "read, and upload workbooks",
  admin: "everything, including this screen",
};

export default function Access({ me, onError }) {
  const [grants, setGrants] = useState(null);
  const [maps, setMaps] = useState(null);
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [search, setSearch] = useState("idle"); // idle | searching | failed
  const [searchErr, setSearchErr] = useState(null);
  const [picked, setPicked] = useState(null);
  const [role, setRole] = useState("viewer");

  const [groupName, setGroupName] = useState("");
  const [groupRole, setGroupRole] = useState("viewer");

  const load = useCallback(async () => {
    try {
      const [g, m] = await Promise.all([get("/api/admin/user-roles"), get("/api/admin/roles")]);
      setGrants(g);
      setMaps(m);
      onError(null);
    } catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  /* Debounced, and every response is checked against the latest query before it
     is shown: two searches in flight can land out of order, and the slower one
     would otherwise overwrite results for what was actually typed. */
  useEffect(() => {
    const q = query.trim();
    if (!q) { setMatches([]); setSearch("idle"); setSearchErr(null); return; }
    let live = true;
    setSearch("searching");
    const timer = setTimeout(async () => {
      try {
        const found = await get(`/api/admin/directory?q=${encodeURIComponent(q)}`);
        if (!live) return;
        setMatches(found); setSearch("idle"); setSearchErr(null);
      } catch (e) {
        if (!live) return;
        /* "No matches" and "the directory is unreachable" call for different
           actions, so they must not look the same. */
        setMatches([]); setSearch("failed"); setSearchErr(e.message);
      }
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  async function run(fn) {
    setBusy(true);
    try { await fn(); await load(); onError(null); }
    catch (e) { onError(e.message); }
    finally { setBusy(false); }
  }

  const mySam = String(me?.principal || "").split("@")[0].split("\\").pop().toLowerCase();

  return (
    <div className="r-grid admin-two">
      {/* ---- people ---- */}
      <section className="card panel r-card">
        <div className="panel-head">
          <h3 className="r-h2">People</h3>
          <span className="micro">{grants ? `${grants.length} direct` : ""}</span>
        </div>
        <p className="meta">
          A grant names one person and takes effect at their next sign-in. It can raise
          someone above what their groups give them; it never lowers them.
        </p>

        <fieldset className="admin-grant">
          <legend className="micro">Give someone access</legend>
          <label className="field">
            <span className="micro">Find a person</span>
            <input type="text" value={query} placeholder="name, email or account name"
              autoComplete="off" onChange={(e) => { setQuery(e.target.value); setPicked(null); }} />
          </label>

          {search === "searching" && <p className="meta">Searching the directory…</p>}
          {search === "failed" && <p className="meta critical-ink" role="alert">Could not search the directory: {searchErr}</p>}
          {search === "idle" && query.trim() && !matches.length && !picked && (
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
                <strong>{picked.name}</strong> ({picked.username}){" "}
                <button type="button" className="btn" onClick={() => setPicked(null)}>change</button>
              </p>
              <label className="field">
                <span className="micro">Role</span>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLES.map((r) => <option key={r} value={r}>{r} — {ROLE_HELP[r]}</option>)}
                </select>
              </label>
              <button type="button" className="btn primary" disabled={busy}
                onClick={() => run(async () => {
                  await post("/api/admin/user-roles", { principal: picked.username, role });
                  setPicked(null); setQuery(""); setMatches([]);
                })}>
                {busy ? "Saving…" : `Grant ${role}`}
              </button>
            </div>
          )}
        </fieldset>

        {!grants && <p className="meta">Loading…</p>}
        {grants && !grants.length && (
          <p className="meta">No direct grants. Everyone signing in today does so through a group.</p>
        )}
        {!!grants?.length && (
          <div className="r-table-scroll">
            <table className="projects">
              <thead><tr>
                <th scope="col">Account</th><th scope="col">Role</th>
                <th scope="col" className="r-col-qhd">Granted by</th>
                <th scope="col" className="r-col-4k">When</th>
                <th scope="col">Actions</th>
              </tr></thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.Principal}>
                    <td>{g.Principal}{g.Principal.toLowerCase() === mySam && <span className="meta"> — you</span>}</td>
                    <td><span className={`chip ${g.Role === "admin" ? "solid" : ""}`}>{g.Role}</span></td>
                    <td className="meta r-col-qhd">{g.GrantedBy || "—"}</td>
                    <td className="meta r-col-4k">{when(g.GrantedAt)}</td>
                    <td>
                      <button type="button" className="btn" disabled={busy}
                        onClick={() => run(() => del(`/api/admin/user-roles/${encodeURIComponent(g.Principal)}`))}>
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

      {/* ---- groups ---- */}
      <section className="card panel r-card">
        <div className="panel-head">
          <h3 className="r-h2">Directory groups</h3>
          <span className="micro">{maps ? `${maps.length} mapped` : ""}</span>
        </div>
        <p className="meta">
          A mapping grants a role to everyone in that group. This is how access scales;
          the list on the left is how exceptions are made.
        </p>

        <fieldset className="admin-grant">
          <legend className="micro">Map a group</legend>
          <label className="field">
            <span className="micro">Group name</span>
            <input type="text" value={groupName} placeholder="GCIO-Dashboard-Admins"
              autoComplete="off" onChange={(e) => setGroupName(e.target.value)} />
          </label>
          <label className="field">
            <span className="micro">Role</span>
            <select value={groupRole} onChange={(e) => setGroupRole(e.target.value)}>
              {ROLES.map((r) => <option key={r} value={r}>{r} — {ROLE_HELP[r]}</option>)}
            </select>
          </label>
          <button type="button" className="btn primary" disabled={busy || !groupName.trim()}
            onClick={() => run(async () => {
              await post("/api/admin/roles", { groupName: groupName.trim(), role: groupRole });
              setGroupName("");
            })}>
            {busy ? "Saving…" : `Map to ${groupRole}`}
          </button>
        </fieldset>

        {!maps && <p className="meta">Loading…</p>}
        {maps && !maps.length && (
          <p className="meta critical-ink">
            No groups are mapped. Nobody can sign in through group membership alone.
          </p>
        )}
        {!!maps?.length && (
          <div className="r-table-scroll">
            <table className="projects">
              <thead><tr>
                <th scope="col">Group</th><th scope="col">Role</th><th scope="col">Actions</th>
              </tr></thead>
              <tbody>
                {maps.map((m) => {
                  const name = m.groupName || m.GroupName;
                  const r = m.role || m.Role;
                  const mine = (me?.groups || []).some((g) => String(g).toLowerCase() === String(name).toLowerCase());
                  return (
                    <tr key={name}>
                      <td>{name}{mine && <span className="meta"> — yours</span>}</td>
                      <td><span className={`chip ${r === "admin" ? "solid" : ""}`}>{r}</span></td>
                      <td>
                        <button type="button" className="btn" disabled={busy}
                          onClick={() => run(() => del(`/api/admin/roles/${encodeURIComponent(name)}`))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
