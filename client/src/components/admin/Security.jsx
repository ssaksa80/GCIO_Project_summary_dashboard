/*
 * The security posture of the application itself.
 *
 * Not to be confused with the dashboard's Security Posture section, which is
 * about the portfolio. This one answers what an auditor asks about the app:
 * how people authenticate, whether that happens over TLS, whether the stored
 * credential is sealed, how sessions expire, and who holds admin.
 *
 * Each row is a fact plus its consequence. "Sessions expire after 240 minutes"
 * is data; "so an unattended browser stays signed in for four hours" is what
 * someone actually needs to decide whether that is acceptable.
 */
import { useCallback, useEffect, useState } from "react";
import { get } from "./api.js";

function Check({ good, label, detail }) {
  return (
    <div className="sec-row">
      <span className={`chip ${good === true ? "solid" : good === false ? "critical" : "neutral"}`}>
        {good === true ? "ok" : good === false ? "review" : "n/a"}
      </span>
      <div>
        <div>{label}</div>
        {detail && <div className="cell-sub">{detail}</div>}
      </div>
    </div>
  );
}

export default function Security({ onError }) {
  const [s, setS] = useState(null);

  const load = useCallback(async () => {
    try { setS(await get("/api/admin/security")); onError(null); }
    catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  if (!s) return <section className="card panel r-card"><p className="meta">Loading…</p></section>;

  const a = s.authentication || {};
  const z = s.authorisation || {};
  const ses = s.sessions || {};
  const lockedOut = z.adminRoutesTotal === 0;

  return (
    <>
      <section className="card panel r-card">
        <div className="panel-head">
          <h3 className="r-h2">Authentication</h3>
          <button type="button" className="btn" onClick={load}>Refresh</button>
        </div>
        <div className="sec-list">
          <Check good={a.mode === "ldap"} label={`Sign-in mode: ${a.mode}`}
            detail={a.mode === "dev"
              ? "Development mode accepts any password. It is refused when NODE_ENV=production, but it must never be what a live host is running."
              : "People authenticate against the directory."} />
          <Check good={a.directoryOverTls} label={a.directoryOverTls ? "Directory reached over LDAPS" : "Directory reached without TLS"}
            detail={a.directoryOverTls
              ? "Credentials are encrypted in transit."
              : "Passwords cross the network in the clear on a simple bind. Use an ldaps:// URL."} />
          <Check good={a.serviceAccountConfigured} label={a.serviceAccountConfigured ? "Service account configured" : "No service account"}
            detail={a.serviceAccountConfigured
              ? "Sign-in searches for the user, then binds the DN the directory returned."
              : "Sign-in constructs an identity from LDAP_UPN_SUFFIX, which cannot be right on a domain with more than one suffix."} />
          <Check good={a.bindPasswordSealed} label={a.bindPasswordSealed ? "Bind password sealed at rest" : "Bind password stored in plaintext"}
            detail={a.bindPasswordSealed
              ? "Encrypted with a machine-bound key, so a copied .env is useless elsewhere. It does not protect against code running on this host."
              : "Run seal-secret.ps1 on the host to encrypt it."} />
          <Check good={null} label={`Single sign-on: ${a.ssoEnabled ? "enabled" : "disabled"}`} />
        </div>
      </section>

      <section className="card panel r-card">
        <h3 className="r-h2">Sessions</h3>
        <div className="sec-list">
          <Check good={null} label={`Idle timeout: ${ses.idleMinutes} minutes`}
            detail={`An unattended browser stays signed in for ${Math.round((ses.idleMinutes || 0) / 60 * 10) / 10} hours of inactivity.`} />
          <Check good={null} label={`Maximum age: ${ses.absoluteHours} hours`}
            detail="The hard cap, regardless of activity. A session is destroyed at this point even if it is in use." />
        </div>
      </section>

      <section className="card panel r-card">
        <h3 className="r-h2">Who can administer this</h3>
        <div className="sec-list">
          <Check good={z.refusesWithoutRole} label="Access is closed by default"
            detail="Signing in proves identity only. Someone the directory knows but nothing grants is refused." />
          <Check good={!lockedOut} label={`${z.adminRoutesTotal} route${z.adminRoutesTotal === 1 ? "" : "s"} to admin`}
            detail={lockedOut
              ? "Nobody can reach this screen. Recover with Grant-Role.cmd on the host."
              : "Each is a group mapped to admin, or a direct grant."} />
        </div>

        <div className="r-grid conn-grid">
          <div className="conn-field">
            <span className="micro">GROUPS MAPPED TO ADMIN</span>
            <div className="conn-value">
              {z.adminGroups?.length ? z.adminGroups.join(", ") : <span className="meta">none</span>}
            </div>
          </div>
          <div className="conn-field">
            <span className="micro">DIRECT ADMIN GRANTS</span>
            <div className="conn-value">
              {z.adminGrants?.length ? z.adminGrants.join(", ") : <span className="meta">none</span>}
            </div>
          </div>
        </div>
      </section>

      {!!s.warnings?.length && (
        <section className="card panel r-card">
          <h3 className="r-h2">Startup warnings</h3>
          <ul className="admin-warnings">
            {s.warnings.map((w, i) => <li key={i} className="critical-ink">{w}</li>)}
          </ul>
        </section>
      )}
    </>
  );
}
