/**
 * Section 5 — Security Posture.
 *
 * Last on the page by design: it is standing context rather than something the
 * CIO decides in the room. Sourced from the workbook's Posture sheet, so it is
 * absent rather than empty when nobody has provided one.
 */
import { fmtDate } from "../lib/format.js";
import { CountUp, useGrow, useReveal } from "../lib/motion.jsx";
import ChangeBadge from "./ChangeBadge.jsx";

const STATUS_CHIP = {
  Compliant: "good",
  Partial: "warn",
  "Non-Compliant": "critical",
  "Not Assessed": "muted",
};

function ScoreBar({ score, target }) {
  const ref = useGrow(score);
  const tone = score >= target ? "good" : score >= target * 0.75 ? "warn" : "critical";
  return (
    <div className="posture-bar">
      <div className="bar">
        <i ref={ref} className={`glow-fill ${tone}`} />
      </div>
      <span className="target-mark" style={{ left: `${Math.min(100, target)}%` }} title={`Target ${Math.round(target)}%`} />
    </div>
  );
}

export default function SectionPosture({ data, onOpen }) {
  const ref = useReveal([data]);

  if (!data?.available) {
    return (
      <section className="sec" id="posture" data-section="posture" ref={ref}>
        <header className="sec-head">
          <span className="sec-n">5</span>
          <h2 className="sec-title display">Security Posture</h2>
        </header>
        <article className="card" data-reveal>
          <p className="empty-line">
            No Posture sheet has been provided. Add one to any workbook — download the
            template from the top bar — and this section fills itself in.
          </p>
        </article>
      </section>
    );
  }

  const { counts, domains, weakest, overdueReviews, remediation, overallScore, targetScore, headline } = data;

  return (
    <section className="sec" id="posture" data-section="posture" ref={ref}>
      <header className="sec-head">
        <span className="sec-n">5</span>
        <h2 className="sec-title display">Security Posture</h2>
        <p className="sec-sub">{headline}</p>
      </header>

      <div className="sec-kpis" data-reveal>
        <div className="mini">
          <span className="lab">Overall maturity</span>
          <span className="val"><CountUp value={overallScore} format={(n) => `${Math.round(n)}%`} /></span>
          <span className="micro">target {Math.round(targetScore)}%</span>
        </div>
        <div className="mini">
          <span className="lab">Domain status</span>
          <span className="rag posture-rag">
            <i className="good" /><b>{counts.compliant}</b>
            <i className="warn" /><b>{counts.partial}</b>
            <i className="critical" /><b>{counts.nonCompliant}</b>
            {counts.notAssessed > 0 && <><i className="muted" /><b>{counts.notAssessed}</b></>}
          </span>
        </div>
        <div className="mini">
          <span className="lab">Critical findings</span>
          <span className="val critical-ink"><CountUp value={counts.criticalFindings} /></span>
          <span className="micro">{counts.openFindings} open in total</span>
        </div>
        <div className="mini">
          <span className="lab">Reviews overdue</span>
          <span className="val"><CountUp value={counts.reviewsOverdue} /></span>
        </div>
      </div>

      <article className="card" data-reveal>
        <h3>Weakest domains — furthest from target</h3>
        {weakest.map((d) => (
          <div className="row-item posture-row" key={`${d.domain}-${d.control}`}>
            <div className="row-top">
              <span className="strong">{d.domain}</span>
              <ChangeBadge change={d.change} />
              <span className={`chip solid ${STATUS_CHIP[d.status]}`}>{d.status}</span>
              {d.criticalFindings > 0 && (
                <span className="chip critical">{d.criticalFindings} critical</span>
              )}
              <span className="micro push">{d.owner || "no owner"}</span>
            </div>
            {d.control && <p className="meta">{d.control}</p>}
            <ScoreBar score={d.score} target={d.target} />
            <p className="micro posture-scale">
              <b>{Math.round(d.score)}%</b> against a {Math.round(d.target)}% target
              {d.gap > 0 ? ` · ${Math.round(d.gap)} points short` : " · at or above target"}
              {d.lastAssessed ? ` · assessed ${fmtDate(d.lastAssessed)}` : " · never assessed"}
            </p>
            {d.notes && <p className="meta">{d.notes}</p>}
            {d.linkedProject && (
              <p className="meta">
                Remediation:{" "}
                <button type="button" className="linkish strong" onClick={() => onOpen(d.linkedProject.id)}>
                  {d.linkedProject.name}
                </button>{" "}
                <span className="micro">({d.linkedProject.health}, {Math.round(d.linkedProject.percentComplete)}% complete)</span>
              </p>
            )}
          </div>
        ))}
      </article>

      <div className="grid-23 gap-top">
        <article className="card" data-reveal>
          <h3>All domains</h3>
          <div className="table-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Domain</th><th>Status</th><th className="num">Score</th><th className="num">Target</th>
                  <th className="num">Findings</th><th>Owner</th><th>Next review</th>
                </tr>
              </thead>
              <tbody>
                {domains.map((d) => (
                  <tr key={`${d.domain}-${d.control}`}>
                    <td>
                      <span className="strong">{d.domain}</span>
                      <ChangeBadge change={d.change} />
                      {d.control && <div className="micro">{d.control}</div>}
                    </td>
                    <td><span className={`chip ${STATUS_CHIP[d.status]}`}>{d.status}</span></td>
                    <td className="num">{d.status === "Not Assessed" ? "—" : `${Math.round(d.score)}%`}</td>
                    <td className="num">{Math.round(d.target)}%</td>
                    <td className="num">
                      {d.openFindings}
                      {d.criticalFindings > 0 && <span className="critical-ink"> ({d.criticalFindings})</span>}
                    </td>
                    <td className="micro">{d.owner || "—"}</td>
                    <td className={`micro ${d.reviewOverdue ? "critical-ink" : ""}`}>
                      {fmtDate(d.nextReview)}{d.reviewOverdue ? ` · ${d.reviewOverdueDays}d overdue` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="micro foot-note">Figures come from the Posture sheet of the ingested workbooks.</p>
        </article>

        <article className="card" data-reveal>
          <h3>Funded remediation</h3>
          {remediation.length === 0 && (
            <p className="empty-line">No posture domain names a remediation project.</p>
          )}
          {remediation.map((r) => (
            <div className="row-item tight" key={`${r.domain}-${r.project.id}`}>
              <div className="row-top">
                <span className="strong">{r.domain}</span>
                <span className={`chip ${STATUS_CHIP[r.status]} push`}>{r.status}</span>
              </div>
              <button type="button" className="meta linkish" onClick={() => onOpen(r.project.id)}>
                {r.project.name}
              </button>
              <p className="micro">{r.project.health} · {Math.round(r.project.percentComplete)}% complete</p>
            </div>
          ))}

          {overdueReviews.length > 0 && (
            <>
              <h3 className="sub-h">Assessments overdue</h3>
              {overdueReviews.map((d) => (
                <div className="row-item tight" key={`overdue-${d.domain}`}>
                  <div className="row-top">
                    <span className="strong">{d.domain}</span>
                    <span className="micro push critical-ink">{d.reviewOverdueDays}d</span>
                  </div>
                  <p className="micro">Due {fmtDate(d.nextReview)} · {d.owner || "no owner"}</p>
                </div>
              ))}
            </>
          )}
        </article>
      </div>
    </section>
  );
}
