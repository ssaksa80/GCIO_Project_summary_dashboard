/*
 * What is actually in the database.
 *
 * Mirrors DEDB's Database screen: schema version, which migrations have run,
 * and row counts per table. The row counts are the useful part — "the dashboard
 * shows 34 projects" and "dbo.Project holds 34 rows" answer different
 * questions, and when they disagree that is the finding.
 *
 * Counts come from sys.partitions, which is an estimate maintained by the
 * engine rather than a COUNT(*) per table. On a table of any size an exact
 * count would scan it, and a status screen must not be able to slow the
 * database it is reporting on. The screen says so rather than implying
 * precision it does not have.
 */
import { useCallback, useEffect, useState } from "react";
import { get, when } from "./api.js";

export default function Database({ onError }) {
  const [d, setD] = useState(null);

  const load = useCallback(async () => {
    try { setD(await get("/api/admin/database")); onError(null); }
    catch (e) { onError(e.message); }
  }, [onError]);

  useEffect(() => { load(); }, [load]);

  if (!d) return <section className="card panel r-card"><p className="meta">Loading…</p></section>;

  const applied = d.migrations?.applied || [];

  return (
    <>
      <section className="card panel r-card">
        <div className="panel-head">
          <h3 className="r-h2">Schema</h3>
          <button type="button" className="btn" onClick={load}>Refresh</button>
        </div>

        {d.store !== "mssql" && (
          <p className="meta">
            This deployment uses the in-memory store, so there is no schema and no
            migrations. Nothing here is missing — there is simply no database.
          </p>
        )}

        {d.store === "mssql" && (
          <>
            <div className="r-grid admin-tiles">
              <div className="card admin-tile">
                <span className="micro">CONNECTION</span>
                <div className="r-h2">{d.up === true ? "up" : d.up === false ? "down" : "unknown"}</div>
                <div className="meta">{d.detail || d.database || ""}</div>
              </div>
              <div className="card admin-tile">
                <span className="micro">SCHEMA VERSION</span>
                <div className="r-h2">{d.migrations?.last ?? "—"}</div>
                <div className="meta">{applied.length} migration{applied.length === 1 ? "" : "s"} applied</div>
              </div>
              <div className="card admin-tile">
                <span className="micro">SERVER</span>
                <div className="meta">{d.serverVersion || "—"}</div>
              </div>
            </div>

            {!!applied.length && (
              <div className="r-table-scroll">
                <table className="projects">
                  <thead><tr>
                    <th scope="col">#</th><th scope="col">Migration</th>
                    <th scope="col" className="r-col-qhd">Applied</th>
                  </tr></thead>
                  <tbody>
                    {applied.map((m) => (
                      <tr key={m.id}>
                        <td className="num">{m.id}</td>
                        <td>{m.name}</td>
                        <td className="meta r-col-qhd">{when(m.appliedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      {!!d.tables?.length && (
        <section className="card panel r-card">
          <div className="panel-head">
            <h3 className="r-h2">Tables</h3>
            <span className="micro">{d.tables.length} tables</span>
          </div>
          <p className="meta">
            Row counts are the engine's own estimates, not a COUNT(*) — an exact count
            would scan every table, and a status screen must not be able to slow the
            database it reports on.
          </p>
          <div className="r-table-scroll">
            <table className="projects">
              <thead><tr><th scope="col">Table</th><th scope="col">Rows</th></tr></thead>
              <tbody>
                {d.tables.map((t) => (
                  <tr key={t.name}>
                    <td>{t.name}</td>
                    <td className="num">{Number(t.rows).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
