/** Section 1 — Successes. What went right, first thing on the page. */
import { fmtDate, fmtMoney } from "../lib/format.js";
import { CountUp, useGrow, useReveal } from "../lib/motion.jsx";
import { DeliveryTrend, useTokens } from "./charts.jsx";

function Progress({ pct }) {
  const ref = useGrow(pct);
  return <div className="bar"><i ref={ref} className="glow-fill" /></div>;
}

export default function SectionSuccesses({ data, charts, theme, onOpen }) {
  const tk = useTokens(theme);
  const ref = useReveal([data]);
  const { delivered, milestones, nearComplete, recovered, savings, headline } = data;

  return (
    <section className="sec" id="successes" ref={ref}>
      <header className="sec-head">
        <span className="sec-n">1</span>
        <h2 className="sec-title display">Successes</h2>
        <p className="sec-sub">{headline}</p>
      </header>

      <div className="sec-kpis" data-reveal>
        <div className="mini"><span className="lab">Delivered</span><span className="val"><CountUp value={delivered.length} /></span></div>
        <div className="mini"><span className="lab">Milestones closed</span><span className="val"><CountUp value={milestones.length} /></span></div>
        <div className="mini"><span className="lab">Near complete</span><span className="val"><CountUp value={nearComplete.length} /></span></div>
        <div className="mini"><span className="lab">Returned to budget</span><span className="val">{savings > 0 ? fmtMoney(savings) : "—"}</span></div>
      </div>

      <div className="grid-23">
        <article className="card" data-reveal>
          <h3>Delivered this period</h3>
          {delivered.length === 0 && <p className="empty-line">No projects closed inside this window.</p>}
          {delivered.map((d) => (
            <div className="row-item" key={d.id}>
              <div className="row-top">
                <button type="button" className="pname" onClick={() => onOpen(d.id)}>{d.name}</button>
                <span className="chip good solid">Delivered</span>
                {d.onTime && <span className="chip info">On time</span>}
                <span className="micro push">{d.department}</span>
              </div>
              <p className="meta">Closed {fmtDate(d.completedOn)} — {d.note}</p>
            </div>
          ))}
        </article>

        <article className="card" data-reveal>
          <h3>Milestones completed</h3>
          {milestones.length === 0 && <p className="empty-line">No milestones closed in this window.</p>}
          {milestones.map((m) => (
            <div className="row-item tight" key={`${m.id}-${m.name}`}>
              <div className="row-top">
                <span className="strong">{m.name}</span>
                <span className="micro push">{fmtDate(m.completedOn)}</span>
              </div>
              <button type="button" className="meta linkish" onClick={() => onOpen(m.id)}>{m.project}</button>
            </div>
          ))}
        </article>
      </div>

      <div className="grid-23 gap-top">
        <article className="card" data-reveal>
          <h3>Delivery trend</h3>
          <DeliveryTrend data={charts.completionTrend} tk={tk} />
        </article>

        <article className="card" data-reveal>
          <h3>On final approach (≥90%)</h3>
          {nearComplete.length === 0 && <p className="empty-line">Nothing is inside the last 10% yet.</p>}
          {nearComplete.map((n) => (
            <div className="row-item tight" key={n.id}>
              <button type="button" className="pname" onClick={() => onOpen(n.id)}>{n.name}</button>
              <p className="meta">{Math.round(n.percentComplete)}% complete — {n.note}</p>
              <Progress pct={n.percentComplete} />
            </div>
          ))}
          {recovered.length > 0 && (
            <>
              <h3 className="sub-h">Ahead of plan</h3>
              {recovered.map((r) => (
                <div className="row-item tight" key={r.id}>
                  <button type="button" className="pname" onClick={() => onOpen(r.id)}>{r.name}</button>
                  <p className="meta">{r.note}</p>
                </div>
              ))}
            </>
          )}
        </article>
      </div>
    </section>
  );
}
