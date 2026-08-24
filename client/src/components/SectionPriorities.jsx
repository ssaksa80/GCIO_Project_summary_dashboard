/**
 * Section 3 — Priorities.
 * A ranked call list: what to act on, why it ranks there, and what is needed.
 * The score is a visible sum of the weights named in "why", so it can be
 * argued with rather than taken on faith.
 */
import { fmtDate, fmtMoney } from "../lib/format.js";
import { CountUp, useGrow, useReveal } from "../lib/motion.jsx";

const HEALTH_CHIP = { Green: "good", Amber: "warn", Red: "critical" };

function ScoreBar({ score }) {
  const ref = useGrow(score);
  const tone = score > 85 ? "critical" : score > 70 ? "warn" : "good";
  return <div className="bar slim"><i ref={ref} className={`glow-fill ${tone}`} /></div>;
}

export default function SectionPriorities({ data, onOpen }) {
  const ref = useReveal([data]);
  const { items, watchlist } = data;

  return (
    <section className="sec" id="priorities" ref={ref}>
      <header className="sec-head">
        <span className="sec-n">3</span>
        <h2 className="sec-title display">Priorities</h2>
        <p className="sec-sub">Ranked by priority, health, schedule, risk, spend and dependency weight</p>
      </header>

      <article className="card" data-reveal>
        {items.length === 0 && <p className="empty-line">Nothing is active — the portfolio is fully closed out.</p>}
        {items.map((p, i) => (
          <div className="prio" key={p.id}>
            <div className="prio-rank">
              <span className="rank-n">{i + 1}</span>
              <span className="rank-l">rank</span>
            </div>

            <div className="prio-body">
              <div className="row-top">
                <button type="button" className="pname big" onClick={() => onOpen(p.id)}>{p.name}</button>
                <span className={`chip solid ${HEALTH_CHIP[p.health]}`}>{p.health}</span>
                <span className={`chip ${p.priority === "Critical" ? "critical" : p.priority === "High" ? "warn" : "muted"}`}>{p.priority}</span>
                <span className="micro">{p.owner || "no owner"} · {p.department}</span>
              </div>
              <p className="meta">{p.why}</p>
              <p className="ask"><b>Needed:</b> {p.ask}</p>
            </div>

            <div className="prio-score">
              <span className="score-v"><CountUp value={p.score} duration={1.1} /></span>
              <span className="micro">urgency score</span>
              <ScoreBar score={p.score} />
              <span className="micro spread">
                {fmtMoney(p.budget)} committed · {Math.round(p.percentComplete)}% complete
                <br />
                target {fmtDate(p.targetEndDate)}
                {p.forecastEnd && p.targetEndDate && p.forecastEnd > p.targetEndDate
                  ? ` · forecast ${fmtDate(p.forecastEnd)}`
                  : ""}
              </span>
            </div>
          </div>
        ))}
      </article>

      {watchlist.length > 0 && (
        <article className="card gap-top" data-reveal>
          <h3>Watch list — next in line</h3>
          <div className="watch-grid">
            {watchlist.map((w) => (
              <div className="watch" key={w.id}>
                <div className="row-top">
                  <button type="button" className="pname" onClick={() => onOpen(w.id)}>{w.name}</button>
                  <span className="micro push">{w.score}</span>
                </div>
                <p className="micro">{w.why}</p>
              </div>
            ))}
          </div>
        </article>
      )}
    </section>
  );
}
