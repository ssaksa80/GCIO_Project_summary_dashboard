/*
 * The admin console, as a full page rather than a modal.
 *
 * Mirrors DEDB's Shell.jsx: a tab strip over one screen at a time, each screen
 * its own file, the whole thing gated on the admin role. It replaces the
 * dashboard rather than floating over it, so the screens get the full width -
 * which is the point on a display where the dashboard itself is now 2800px.
 *
 * NOT a route. It is toggled by state in App.jsx, which was a deliberate
 * choice: no URL to link or bookmark, and the browser's back button leaves the
 * application rather than the console. The header therefore carries an explicit
 * way back, and Escape works, because those are the two things a person will
 * try when there is no address bar to help them.
 *
 * The role check here is presentation only. Every /api/admin route is behind
 * requireRole("admin") server-side; hiding a screen is not access control.
 */
import { useEffect, useRef, useState } from "react";

import Health from "./admin/Health.jsx";
import Ownership from "./admin/Ownership.jsx";
import Access from "./admin/Access.jsx";
import Sessions from "./admin/Sessions.jsx";
import Audit from "./admin/Audit.jsx";
import Settings from "./admin/Settings.jsx";
import Connection from "./admin/Connection.jsx";
import Database from "./admin/Database.jsx";
import Logs from "./admin/Logs.jsx";
import Security from "./admin/Security.jsx";
import Status from "./admin/Status.jsx";

/* Ordered as DEDB orders them: the state of the thing first, then who may
   touch it, then what they did, then how it is configured. An operator opening
   this screen in an incident reads left to right. */
const TABS = [
  ["health", "Health", "is it up, and what is it connected to", Health],
  ["ownership", "Ownership", "who owns which part of the brief", Ownership],
  ["access", "Access", "who may use this application", Access],
  ["sessions", "Sessions", "who is signed in now", Sessions],
  ["audit", "Audit", "who did what", Audit],
  ["settings", "Settings", "what an operator can change without a deploy", Settings],
  ["connection", "Connection", "what this deployment is pointed at", Connection],
  ["database", "Database", "schema, migrations and row counts", Database],
  ["logs", "Logs", "what the service wrote", Logs],
  ["security", "Security", "the posture of the application itself", Security],
  ["ingest", "Ingest", "recent ingest runs", Status],
];

export default function AdminPage({ me, onClose }) {
  const [tab, setTab] = useState(TABS[0][0]);
  const [error, setError] = useState(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  /* Escape leaves. With no URL there is no back button to rely on, and this is
     the first thing anyone tries. */
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") closeRef.current?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* Clearing on a tab change is deliberate: an error raised by the Sessions
     screen is meaningless once Audit is showing, and leaving it on screen makes
     the new screen look broken. */
  useEffect(() => { setError(null); }, [tab]);

  if (me?.role !== "admin") {
    return (
      <div className="shell admin-page">
        <main>
          <div className="card panel r-card">
            <h1 className="r-h1">Access</h1>
            <p className="meta critical-ink">This screen is for administrators.</p>
            <button type="button" className="btn primary" onClick={onClose}>Back to the dashboard</button>
          </div>
        </main>
      </div>
    );
  }

  const active = TABS.find(([id]) => id === tab) || TABS[0];
  const Screen = active[3];

  return (
    <div className="shell admin-page">
      <header className="admin-head">
        <div>
          <span className="micro">GCIO · PROJECT INTELLIGENCE</span>
          <h1 className="r-h1 display">Admin console</h1>
          <p className="meta">{active[2]}</p>
        </div>
        <div className="admin-head-actions">
          {me?.principal && (
            <span className="who" title={`${me.principal} · ${me.role}`}>
              {me.displayName || me.principal} <i>{me.role}</i>
            </span>
          )}
          <button type="button" className="btn primary" onClick={onClose}>
            Back to the dashboard
          </button>
        </div>
      </header>

      {/* A tablist, not a row of links: with no routing these are the only
          navigation, so they must be reachable and announced as such. */}
      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`admin-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="admin-panel"
            className={`admin-tab${tab === id ? " is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <main id="admin-panel" role="tabpanel" aria-labelledby={`admin-tab-${tab}`}>
        {error && <div className="card panel error-panel" role="alert">
          <span className="micro critical-ink">Something went wrong</span>
          <div className="meta">{error}</div>
        </div>}
        <Screen me={me} onError={setError} />
      </main>
    </div>
  );
}
