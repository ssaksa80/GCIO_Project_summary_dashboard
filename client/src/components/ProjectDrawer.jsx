import { useEffect, useRef, useState } from "react";
import { getJSON, downloadExport } from "../lib/api.js";
import { fmtMoney, fmtDate, HEALTH_CHIP } from "../lib/format.js";

/* What the browser itself treats as tabbable. The dialog container carries
   tabIndex={-1} so it can take initial focus without ever joining the tab
   order, which is why the -1 entries are excluded here. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const SCHEDULE_CHIP = { "On Track": "good", "At Risk": "warn", Overdue: "critical", Completed: "good" };
const RISK_CHIP = { Critical: "critical", High: "serious", Medium: "warn", Low: "neutral" };

function TreeNode({ node, onNavigate, depth = 0 }) {
  return (
    <>
      <button type="button" className="tree-node" onClick={() => onNavigate(node.id)} style={{ marginLeft: depth * 4 }}>
        <span className={`chip ${HEALTH_CHIP[node.health] || "neutral"}`} style={{ padding: "2px 7px" }}><i /></span>
        <b>{node.name}</b>
        <span className="pct">{Math.round(node.percentComplete)}%</span>
      </button>
      {node.children?.length > 0 && (
        <div className="tree">
          {node.children.map((c) => <TreeNode key={c.id} node={c} onNavigate={onNavigate} depth={depth + 1} />)}
        </div>
      )}
    </>
  );
}

export default function ProjectDrawer({ id, onClose, onNavigate, period, date }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    getJSON(`/api/projects/${encodeURIComponent(id)}`)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [id]);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /*
    Modal focus behaviour.

    The drawer already behaved as a modal for a mouse: a backdrop that dismisses
    it, and Escape to close. It did not behave as one for the keyboard. Focus
    stayed on whatever was clicked, Tab kept walking the page behind the
    backdrop, and the drawer's own close button sat 99 Tab presses away because
    the drawer mounts last in the document. Findings 5, 6, 7 and 9 in
    docs/accessibility-assessment.md.

    Focus goes to the dialog container rather than to the close button or the
    heading. It is the only one of the three that exists at mount - the drawer
    renders a skeleton, and the <h2> does not arrive until the fetch above
    resolves - and it announces the dialog's own name rather than "Close,
    button".
  */
  const dialogRef = useRef(null);
  const returnFocusRef = useRef(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      /* The trigger can legitimately be gone by now - the table's filters may
         have changed underneath, or navigation replaced the section that held
         it. Focusing a detached node silently sends focus to <body>, which is
         worse than leaving it alone. */
      const target = returnFocusRef.current;
      if (target && target.isConnected) target.focus();
    };
  }, []);

  /* Re-announce when the tree navigates to a different project inside the same
     mounted drawer: the heading changes but focus would otherwise sit on the
     tree node of a project that is no longer being shown. */
  useEffect(() => { dialogRef.current?.focus(); }, [id]);

  /*
    Keep Tab inside the dialog.

    The list is re-queried on every keypress rather than captured once, because
    the contents change twice after mount: when the fetch resolves and the
    skeleton is replaced, and when onNavigate swaps to another project. A list
    captured at mount would hold one stale close button.
  */
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      /* No extra filtering on top of FOCUSABLE. The selector already excludes
         disabled controls, and any additional rule here would have to be
         mirrored exactly by anything reasoning about "the last focusable in the
         dialog" - including the tests, which disagreed with an earlier
         aria-hidden filter and failed intermittently because of it. */
      const items = [...dialog.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!dialog.contains(active)) {
        /* Focus escaped some other way - a click on the backdrop, say. Bring it
           back rather than letting Tab continue through the page behind. */
        e.preventDefault();
        first.focus();
      }
    };
    const dialog = dialogRef.current;
    dialog?.addEventListener("keydown", onKeyDown);
    return () => dialog?.removeEventListener("keydown", onKeyDown);
  }, []);

  const exportProject = async (format) => {
    setBusy(format);
    try {
      await downloadExport(format, { period, date, projectIds: [id] });
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const p = data?.project;
  const c = data?.computed;

  return (
    <>
      <div className="backdrop" onClick={onClose} aria-hidden="true" />
      {/* A <div>, not an <aside>: <aside> is not permitted to carry
          role="dialog" (axe aria-allowed-role, Finding 2). aria-modal tells
          assistive technology the rest of the page is unavailable while this is
          open, which is now true for the keyboard as well. */}
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Project detail"
        tabIndex={-1}
        ref={dialogRef}
      >
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">✕</button>

        {error && <div style={{ color: "var(--critical-ink)", marginTop: 30 }}>{error}</div>}
        {!data && !error && (
          <div style={{ display: "grid", gap: 12, marginTop: 34 }}>
            <div className="skeleton" style={{ height: 60 }} />
            <div className="skeleton" style={{ height: 180 }} />
            <div className="skeleton" style={{ height: 220 }} />
          </div>
        )}

        {p && c && (
          <>
            <span className="micro">{p.id}{p.program ? ` · ${p.program}` : ""}</span>
            <h2>{p.name}</h2>
            <div className="drawer-chips">
              <span className={`chip ${HEALTH_CHIP[p.health]}`}><i />{p.health}</span>
              <span className="chip neutral"><i />{p.status}</span>
              <span className={`chip ${SCHEDULE_CHIP[c.scheduleStatus]}`}><i />{c.scheduleStatus}</span>
              <span className="chip neutral"><i />{p.priority} priority</span>
              <span className="chip neutral"><i />{p.phase}</span>
            </div>

            {p.description && (
              <p style={{ margin: "0 0 16px", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.55 }}>{p.description}</p>
            )}

            <div className="stat-strip">
              <div className="cellstat">
                <span className="micro">Complete</span>
                <b>{Math.round(p.percentComplete)}%</b>
              </div>
              <div className="cellstat">
                <span className="micro">{c.daysRemaining !== null && c.daysRemaining < 0 ? "Days overdue" : "Days remaining"}</span>
                <b style={c.daysRemaining !== null && c.daysRemaining < 0 ? { color: "var(--critical-ink)" } : undefined}>
                  {c.daysRemaining === null ? "—" : Math.abs(c.daysRemaining)}
                </b>
              </div>
              <div className="cellstat">
                <span className="micro">Budget used</span>
                <b style={c.budgetUtilizationPct > 100 ? { color: "var(--critical-ink)" } : undefined}>{Math.round(c.budgetUtilizationPct)}%</b>
              </div>
            </div>

            <h3 className="micro section-title">Project record</h3>
            <div className="meta-grid">
              <div className="meta-cell"><span className="micro">Owner / PM</span><b>{p.owner || "—"}</b></div>
              <div className="meta-cell"><span className="micro">Executive sponsor</span><b>{p.sponsor || "—"}</b></div>
              <div className="meta-cell"><span className="micro">Department</span><b>{p.department}</b></div>
              <div className="meta-cell"><span className="micro">Strategic pillar</span><b>{p.pillar}</b></div>
              <div className="meta-cell"><span className="micro">Vendor</span><b>{p.vendor || "—"}</b></div>
              <div className="meta-cell"><span className="micro">Source file</span><b title={p.sourceFile}>{p.sourceFile}</b></div>
              <div className="meta-cell"><span className="micro">Approved</span><b>{fmtDate(p.approvalDate)}</b></div>
              <div className="meta-cell"><span className="micro">Started</span><b>{fmtDate(p.startDate)}</b></div>
              <div className="meta-cell"><span className="micro">Target end</span><b>{fmtDate(p.targetEndDate)}</b></div>
              <div className="meta-cell"><span className="micro">{p.actualEndDate ? "Completed" : "Forecast end"}</span><b>{fmtDate(p.actualEndDate || c.forecastEnd)}</b></div>
              <div className="meta-cell"><span className="micro">Budget</span><b>{fmtMoney(p.budget)}</b></div>
              <div className="meta-cell"><span className="micro">Spent to date</span><b>{fmtMoney(p.spent)}</b></div>
            </div>

            {(data.chain.ancestors.length > 0 || data.chain.children.length > 0) && (
              <>
                <h3 className="micro section-title">Project chain</h3>
                <div className="chain-crumbs">
                  {data.chain.ancestors.map((a) => (
                    <span key={a.id} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <button type="button" className="crumb" onClick={() => onNavigate(a.id)}>{a.name}</button>
                      <span className="chain-sep">›</span>
                    </span>
                  ))}
                  <span className="crumb current">{p.name}</span>
                </div>
                {data.chain.children.length > 0 && (
                  <div className="tree">
                    {data.chain.children.map((childNode) => (
                      <TreeNode key={childNode.id} node={childNode} onNavigate={onNavigate} />
                    ))}
                  </div>
                )}
              </>
            )}

            {data.timeline.length > 0 && (
              <>
                <h3 className="micro section-title">Timeline</h3>
                <div className="timeline">
                  {data.timeline.map((ev, i) => (
                    <div className="tl-item" key={`${ev.date}-${ev.label}-${i}`}>
                      <span className="tl-date">{fmtDate(ev.date)}</span>
                      <span className="tl-rail">
                        <span className={`tl-dot ${ev.type}${ev.type === "milestone" ? (ev.detail.startsWith("Completed") ? " done" : ev.detail.includes("Overdue") ? " overdue" : "") : ""}`} />
                      </span>
                      <span>
                        <span className="tl-label">{ev.label}</span>
                        {ev.detail && <div className="tl-detail">{ev.detail}</div>}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {p.risks.length > 0 && (
              <>
                <h3 className="micro section-title">Risks ({c.openRisks} open)</h3>
                <table className="risk-table">
                  <tbody>
                    {p.risks.map((r) => (
                      <tr key={r.title}>
                        <td style={{ width: 84 }}><span className={`chip ${RISK_CHIP[r.severity] || "neutral"}`}><i />{r.severity}</span></td>
                        <td>{r.title}<div className="cell-sub">{r.status}{r.owner ? ` · ${r.owner}` : ""}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {p.updates.length > 0 && (
              <>
                <h3 className="micro section-title">Latest updates</h3>
                <div className="updates-feed">
                  {p.updates.slice(0, 5).map((u) => (
                    <div className="update-item" key={`${u.date}-${u.text.slice(0, 24)}`}>
                      <div className="update-head"><span>{u.author || "Update"}</span><span>{fmtDate(u.date)}</span></div>
                      <div className="update-text">{u.text}</div>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="drawer-actions">
              <span className="micro" style={{ alignSelf: "center", marginRight: 4 }}>Export this project:</span>
              {["docx", "xlsx", "html"].map((f) => (
                <button key={f} type="button" className="btn" disabled={Boolean(busy)} onClick={() => exportProject(f)}>
                  {busy === f ? "Preparing…" : f.toUpperCase()}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
