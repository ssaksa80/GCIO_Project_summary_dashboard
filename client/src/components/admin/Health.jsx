/*
 * Is it healthy, and what is it connected to?
 *
 * Mirrors DEDB's Health screen: database up, directory configured, migrations
 * applied, record count — the four things an operator otherwise learns by
 * reading a log file or a config file.
 *
 * Each row states a fact and, where the fact is bad, what to do about it. A
 * status screen that says "down" without saying "and here is which one" simply
 * moves the investigation somewhere else.
 */
import { useCallback, useEffect, useState } from "react";
import { get, when } from "./api.js";

/*
 * `state` has three meanings, and the third one used to be missing.
 *
 *   true      up
 *   false     down
 *   "text"    a neutral chip saying exactly that - "not configured", "none yet"
 *   null      genuinely unknown - configured, but the probe could not answer
 *   undefined not applicable - this row reports a value, not a condition
 *
 * The string case exists because four rows used null to mean "not configured",
 * which rendered as "unknown". Those are opposite statements: one says the
 * setup is incomplete and names the fix, the other says the system tried to
 * look and failed. Only the second is worth waking somebody for.
 *
 * Uptime is the last kind. It passed null, which rendered as "unknown", so a
 * row that had nothing to report looked like a row whose status could not be
 * determined. Those are different statements, and on a health screen the
 * difference is the whole point: "unknown" invites an investigation that has
 * nowhere to go.
 */
function Row({ label, state, detail, children }) {
  const badge = state === undefined ? null
    : state === true ? { cls: "solid", text: "up" }
    : state === false ? { cls: "critical", text: "down" }
    : typeof state === "string" ? { cls: "neutral", text: state }
    : { cls: "neutral", text: "unknown" };
  return (
    <div className="health-row">
      <div className="health-label">{label}</div>
      <div className="health-body">
        {children}
        {detail && <div className="cell-sub">{detail}</div>}
      </div>
      <div className="health-state">
        {badge && <span className={`chip ${badge.cls}`}>{badge.text}</span>}
      </div>
    </div>
  );
}

function secondsToSpan(s) {
  if (s == null) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function Health({ onError }) {
  const [h, setH] = useState(null);

  const load = useCallback(async () => {
    try { setH(await get("/api/admin/health")); onError(null); }
    catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  if (!h) return <section className="card panel r-card"><p className="meta">Loading…</p></section>;

  const dir = h.directory || {};
  const db = h.database || {};
  const mig = h.migrations || {};

  return (
    <>
      <section className="card panel r-card">
        <div className="panel-head">
          <h3 className="r-h2">Health</h3>
          <button type="button" className="btn" onClick={load}>Refresh</button>
        </div>

        <div className="health-list">
          <Row label="Database" state={db.configured ? db.up : "not configured"}
               detail={db.up === false ? db.detail : db.configured ? `${db.database || ""}${db.ms != null ? ` · answered in ${db.ms} ms` : ""}` : "in-memory store: there is no database"}>
            <strong>{h.store}</strong>
          </Row>

          <Row label="Directory (LDAP)" state={dir.configured ? true : "not configured"}
               detail={dir.url || "AUTH_MODE is not ldap on this deployment"}>
            <strong>{dir.configured ? "configured" : "not configured"}</strong>
            {dir.configured && (
              <span className="meta">
                {" "}· service account {dir.serviceAccount}
                {dir.serviceAccount === "configured" && (dir.bindPasswordSealed
                  ? " · password sealed"
                  : " · password in plaintext")}
              </span>
            )}
          </Row>

          <Row label="Migrations applied" state={mig.last != null ? true : "none applied"}
               detail={mig.error || (mig.applied?.length ? `latest is ${mig.last}` : "none recorded")}>
            <span className="meta">
              {mig.applied?.length
                ? mig.applied.map((m) => `${m.id}_${m.name}`).join(", ")
                : "—"}
            </span>
          </Row>

          <Row label="Projects" state={h.projects != null ? true : "no data"}>
            <strong>{h.projects ?? "—"}</strong>
          </Row>

          {/* No badge: uptime is a value, not a condition. */}
        <Row label="Uptime">
            <strong>{secondsToSpan(h.uptimeSec)}</strong>
            <span className="meta"> · version {h.version} · auth {h.authMode}</span>
          </Row>
        </div>
      </section>

      {!!h.warnings?.length && (
        <section className="card panel r-card">
          <h3 className="r-h2">Warnings</h3>
          <p className="meta">
            Things the service started despite. None of these stop it running; all of them
            are worth fixing.
          </p>
          <ul className="admin-warnings">
            {h.warnings.map((w, i) => <li key={i} className="critical-ink">{w}</li>)}
          </ul>
        </section>
      )}
    </>
  );
}
