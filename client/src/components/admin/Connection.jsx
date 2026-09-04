/*
 * What this deployment is pointed at, and whether it can still reach it.
 *
 * Mirrors DEDB's Connection screen with one deliberate difference, stated on
 * the screen rather than hidden: DEDB edits a runtime config store, GCIO reads
 * .env which the service wrapper freezes at install time. Editable fields here
 * would be fields that appear to save and change nothing.
 *
 * The directory test is the useful half regardless. It performs the same bind
 * sign-in performs, which is what separates "the directory is unreachable" from
 * "that person typed the wrong password" — a distinction that cost a day on
 * this deployment, when a TLS failure and a bad password both surfaced as a
 * refusal at the sign-in form.
 */
import { useCallback, useEffect, useState } from "react";
import { get, post } from "./api.js";

function Field({ label, value, mono }) {
  return (
    <div className="conn-field">
      <span className="micro">{label}</span>
      <div className={mono ? "conn-value mono" : "conn-value"}>{value ?? <span className="meta">not set</span>}</div>
    </div>
  );
}

export default function Connection({ onError }) {
  const [c, setC] = useState(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);

  const load = useCallback(async () => {
    try { setC(await get("/api/admin/connection")); onError(null); }
    catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try { setTest(await post("/api/admin/connection/test-directory", {})); onError(null); }
    catch (e) { onError(e.message); }
    finally { setTesting(false); }
  }

  if (!c) return <section className="card panel r-card"><p className="meta">Loading…</p></section>;

  return (
    <>
      <section className="card panel r-card">
        <div className="panel-head">
          <h3 className="r-h2">Database</h3>
          <span className="chip neutral">read-only</span>
        </div>
        <p className="meta">{c.why}</p>
        <div className="r-grid conn-grid">
          <Field label="STORE" value={c.database.store} />
          <Field label="SERVER" value={c.database.server} mono />
          <Field label="INSTANCE" value={c.database.instance} mono />
          <Field label="DATABASE" value={c.database.database} mono />
          <Field label="WINDOWS AUTH" value={String(c.database.windowsAuth)} />
          <Field label="ENCRYPT" value={String(c.database.encrypt)} />
          <Field label="TRUST SERVER CERT" value={String(c.database.trustServerCertificate)} />
          <Field label="PASSWORD" value={c.database.passwordSet ? "set" : "not set"} />
        </div>
      </section>

      <section className="card panel r-card">
        <div className="panel-head">
          <h3 className="r-h2">Directory</h3>
          <button type="button" className="btn primary" disabled={testing} onClick={runTest}>
            {testing ? "Testing…" : "Test directory"}
          </button>
        </div>
        <p className="meta">
          The test performs the same bind sign-in performs, using the service account.
          It answers whether the directory is reachable and the application's own
          credential still works — separately from whether any person's password does.
        </p>

        {test && (
          <div className={`card admin-tile ${test.ok ? "" : "conn-bad"}`}>
            <span className="micro">{test.ok ? "DIRECTORY REACHED" : "DIRECTORY TEST FAILED"}</span>
            {test.ok ? (
              <div className="meta">
                Bound as <strong>{test.bindDN}</strong> in {test.ms} ms.
                {test.searchable === false && " The bind worked but the base DN returned no people — check LDAP_BASE_DN."}
              </div>
            ) : (
              <div className="meta critical-ink">
                {test.message}
                {test.code ? ` (${test.code})` : ""}
              </div>
            )}
          </div>
        )}

        <div className="r-grid conn-grid">
          <Field label="AUTH MODE" value={c.directory.authMode} />
          <Field label="URL" value={c.directory.url} mono />
          <Field label="BASE DN" value={c.directory.baseDN} mono />
          <Field label="DOMAIN" value={c.directory.domain} mono />
          <Field label="UPN SUFFIX" value={c.directory.upnSuffix} mono />
          <Field label="SERVICE ACCOUNT" value={c.directory.bindDN} mono />
          <Field label="BIND PASSWORD"
                 value={!c.directory.bindPasswordSet ? "not set"
                        : c.directory.bindPasswordSealed ? "set · sealed at rest" : "set · PLAINTEXT in .env"} />
          <Field label="TIMEOUT" value={`${c.directory.timeoutMs} ms`} />
        </div>
      </section>
    </>
  );
}
