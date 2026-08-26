/**
 * Section 2 — Questions, Risks & Issues, in that order.
 * Questions come first because they are the only part that needs the CIO to
 * do something in the room.
 */
import { fmtDate } from "../lib/format.js";
import { CountUp, useReveal } from "../lib/motion.jsx";
import { HealthByDepartment, useTokens } from "./charts.jsx";
import ChangeBadge from "./ChangeBadge.jsx";

const HEALTH_CHIP = { Green: "good", Amber: "warn", Red: "critical" };
const SEV_CHIP = { Critical: "critical", High: "warn", Medium: "info", Low: "muted" };

export default function SectionQRI({ data, charts, theme, onOpen }) {
  const tk = useTokens(theme);
  const ref = useReveal([data]);
  const { questions, risks, issues, counts } = data;

  return (
    <section className="sec" id="questions" data-section="qri" ref={ref}>
      <header className="sec-head">
        <span className="sec-n">2</span>
        <h2 className="sec-title display">Questions, Risks &amp; Issues</h2>
        <p className="sec-sub">
          {counts.questions} open question{counts.questions === 1 ? "" : "s"} · {counts.risks} open risk{counts.risks === 1 ? "" : "s"} ({counts.risksCritical} critical) · {counts.issues} live issue{counts.issues === 1 ? "" : "s"}
        </p>
      </header>

      <div className="sec-kpis" data-reveal>
        <div className="mini"><span className="lab">Questions open</span><span className="val"><CountUp value={counts.questions} /></span></div>
        <div className="mini"><span className="lab">Need a decision now</span><span className="val critical-ink"><CountUp value={counts.questionsCritical} /></span></div>
        <div className="mini"><span className="lab">Critical risks</span><span className="val"><CountUp value={counts.risksCritical} /></span></div>
        <div className="mini"><span className="lab">Live issues</span><span className="val"><CountUp value={counts.issues} /></span></div>
      </div>

      <article className="card block-questions" data-reveal>
        <h3>Questions — decisions awaiting the CIO</h3>
        {questions.length === 0 && <p className="empty-line">Nothing is waiting on an executive decision.</p>}
        {questions.map((q, i) => (
          <div className="row-item question" key={`${q.id}-${i}`}>
            <div className="row-top">
              <span className={`chip solid ${q.severity === "critical" ? "critical" : "warn"}`}>
                {q.severity === "critical" ? "Decision now" : "Decision soon"}
              </span>
              <span className={`chip ${q.source === "workbook" ? "info" : "muted"}`}>
                {q.source === "workbook" ? "from PM" : "derived"}
              </span>
              <span className="micro push">{q.neededBy ? `Needed by ${fmtDate(q.neededBy)}` : "No date set"}</span>
            </div>
            <p className="q-text">{q.text}</p>
            <p className="meta">
              <button type="button" className="linkish" onClick={() => onOpen(q.id)}>{q.project}</button>
              <ChangeBadge change={q.change} />
              {" · "}{q.because}
              {q.decisionOwner ? ` · with ${q.decisionOwner}` : ""}
            </p>
          </div>
        ))}
        {counts.questions > questions.length && (
          <p className="micro foot-note">Showing the {questions.length} most pressing of {counts.questions}. {counts.questionsFromWorkbook} were written by project managers; the rest are derived from portfolio state.</p>
        )}
      </article>

      <div className="grid-23 gap-top">
        <article className="card" data-reveal>
          <h3>Open risks — severity ranked</h3>
          <div className="table-scroll">
            <table className="tbl">
              <thead>
                <tr><th>Severity</th><th>Risk</th><th>Project</th><th>Owner</th><th>Status</th></tr>
              </thead>
              <tbody>
                {risks.slice(0, 10).map((r, i) => (
                  <tr key={`${r.id}-${i}`}>
                    <td><span className={`chip solid ${SEV_CHIP[r.severity] || "muted"}`}>{r.severity}</span></td>
                    <td className="strong">{r.title}</td>
                    <td>
                      <button type="button" className="linkish" onClick={() => onOpen(r.id)}>{r.project}</button>
                      <ChangeBadge change={r.change} />
                    </td>
                    <td className="micro">{r.owner || "—"}</td>
                    <td className="micro">{r.status}</td>
                  </tr>
                ))}
                {risks.length === 0 && <tr><td colSpan={5} className="empty-line">No open risks recorded.</td></tr>}
              </tbody>
            </table>
          </div>
          {risks.length > 10 && <p className="micro foot-note">{risks.length - 10} further open risks across the portfolio.</p>}
        </article>

        <article className="card" data-reveal>
          <h3>Health by department</h3>
          <HealthByDepartment data={charts.healthByDepartment} tk={tk} />
        </article>
      </div>

      <article className="card gap-top" data-reveal>
        <h3>Issues — already materialised</h3>
        <div className="table-scroll">
          <table className="tbl">
            <thead><tr><th>Project</th><th>Issue</th><th>Type</th><th>Health</th></tr></thead>
            <tbody>
              {issues.slice(0, 12).map((it, i) => (
                <tr key={`${it.id}-${i}`}>
                  <td><button type="button" className="linkish strong" onClick={() => onOpen(it.id)}>{it.project}</button></td>
                  <td>{it.text}</td>
                  <td className="micro">{it.type}</td>
                  <td><span className={`chip solid ${HEALTH_CHIP[it.health]}`}>{it.health}</span></td>
                </tr>
              ))}
              {issues.length === 0 && <tr><td colSpan={4} className="empty-line">No live issues — nothing is overdue, overrun or held.</td></tr>}
            </tbody>
          </table>
        </div>
        {issues.length > 12 && <p className="micro foot-note">{issues.length - 12} further issues listed in the full project table.</p>}
      </article>
    </section>
  );
}
