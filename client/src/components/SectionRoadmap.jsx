/**
 * Section 4 — Roadmap / Planned Projects.
 * In-flight work on a forecast timeline first, then the planned pipeline and
 * the milestones that fall due next.
 */
import { useMemo } from "react";
import { fmtDate, fmtMoney } from "../lib/format.js";
import { CountUp, useReveal } from "../lib/motion.jsx";
import { PillarSpend, useTokens } from "./charts.jsx";

const HEALTH_CHIP = { Green: "good", Amber: "warn", Red: "critical" };
const DAY = 86400000;

/** Evenly spaced quarter ticks across the horizon. */
function ticks(startISO, endISO) {
  const start = new Date(startISO).getTime();
  const end = new Date(endISO).getTime();
  const out = [];
  const cursor = new Date(startISO);
  cursor.setDate(1);
  while (cursor.getTime() <= end) {
    const t = cursor.getTime();
    if (t >= start) {
      out.push({
        label: cursor.toLocaleDateString("en-AE", { month: "short", year: "2-digit" }),
        pct: ((t - start) / (end - start)) * 100,
      });
    }
    cursor.setMonth(cursor.getMonth() + 3);
  }
  return out;
}

export default function SectionRoadmap({ data, theme, onOpen }) {
  const tk = useTokens(theme);
  const ref = useReveal([data]);
  const { inFlight, pipeline, upcomingMilestones, pillars, horizonStart, horizonEnd, committedAhead } = data;

  const scale = useMemo(() => {
    const start = new Date(horizonStart).getTime();
    const end = new Date(horizonEnd).getTime();
    const span = Math.max(DAY, end - start);
    return {
      pct: (iso) => Math.max(0, Math.min(100, ((new Date(iso).getTime() - start) / span) * 100)),
      ticks: ticks(horizonStart, horizonEnd),
    };
  }, [horizonStart, horizonEnd]);

  return (
    <section className="sec" id="roadmap" ref={ref}>
      <header className="sec-head">
        <span className="sec-n">4</span>
        <h2 className="sec-title display">Roadmap / Planned Projects</h2>
        <p className="sec-sub">{fmtDate(horizonStart)} — {fmtDate(horizonEnd)} · in flight, then planned</p>
      </header>

      <div className="sec-kpis" data-reveal>
        <div className="mini"><span className="lab">In flight</span><span className="val"><CountUp value={inFlight.length} /></span></div>
        <div className="mini"><span className="lab">Planned</span><span className="val"><CountUp value={pipeline.length} /></span></div>
        <div className="mini"><span className="lab">Milestones ahead</span><span className="val"><CountUp value={upcomingMilestones.length} /></span></div>
        <div className="mini"><span className="lab">Committed ahead</span><span className="val">{fmtMoney(committedAhead)}</span></div>
      </div>

      <article className="card" data-reveal>
        <h3>Delivery horizon — forecast against target</h3>
        <div className="gantt">
          {inFlight.map((p) => {
            const target = p.targetEndDate ? scale.pct(p.targetEndDate) : null;
            const forecast = p.forecastEnd ? scale.pct(p.forecastEnd) : target;
            const barEnd = Math.max(forecast ?? 0, target ?? 0);
            return (
              <div className="lane" key={p.id}>
                <div className="lane-label">
                  <button type="button" className="pname" onClick={() => onOpen(p.id)}>{p.name}</button>
                  <span className="micro">{p.owner || "no owner"} · {Math.round(p.percentComplete)}%{p.onHold ? " · on hold" : ""}</span>
                </div>
                <div className="lane-track">
                  <div
                    className={`lane-bar ${p.slipDays > 0 ? "slipped" : ""} ${p.onHold ? "held" : ""}`}
                    style={{ width: `${Math.max(3, barEnd)}%` }}
                  >
                    <span className="lane-tag">{p.targetEndDate ? fmtDate(p.targetEndDate) : "no target"}</span>
                  </div>
                  {p.slipDays > 0 && target !== null && (
                    <div className="lane-slip" style={{ left: `${target}%`, width: `${Math.max(1, forecast - target)}%` }} />
                  )}
                  {target !== null && <div className="lane-target" style={{ left: `${target}%` }} />}
                </div>
                <div className="lane-end">
                  {p.slipDays > 0
                    ? <span className="chip warn">+{p.slipDays}d</span>
                    : <span className={`chip ${HEALTH_CHIP[p.health]}`}>on plan</span>}
                </div>
              </div>
            );
          })}
          {inFlight.length === 0 && <p className="empty-line">Nothing is in flight.</p>}
          <div className="gantt-axis">
            {scale.ticks.map((t) => (
              <span key={t.label} style={{ left: `${t.pct}%` }}>{t.label}</span>
            ))}
          </div>
        </div>
        <p className="micro foot-note">Target date marked on each lane · hatched span = forecast slip beyond target.</p>
      </article>

      <div className="grid-2 gap-top">
        <article className="card" data-reveal>
          <h3>Planned pipeline — proposed &amp; approved</h3>
          <div className="table-scroll">
            <table className="tbl">
              <thead><tr><th>Project</th><th>Status</th><th>Starts</th><th className="num">Budget</th><th>Readiness</th></tr></thead>
              <tbody>
                {pipeline.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <button type="button" className="linkish strong" onClick={() => onOpen(p.id)}>{p.name}</button>
                      <div className="micro">{p.pillar}</div>
                    </td>
                    <td><span className={`chip ${p.status === "Approved" ? "good" : "muted"}`}>{p.status}</span></td>
                    <td className="micro">{fmtDate(p.startDate)}</td>
                    <td className="num">{fmtMoney(p.budget)}</td>
                    <td><span className={`chip ${p.readiness === "Ready" ? "info" : "warn"}`}>{p.readiness}</span></td>
                  </tr>
                ))}
                {pipeline.length === 0 && <tr><td colSpan={5} className="empty-line">No proposed or approved projects waiting to start.</td></tr>}
              </tbody>
            </table>
          </div>
        </article>

        <article className="card" data-reveal>
          <h3>Milestones falling due</h3>
          {upcomingMilestones.length === 0 && <p className="empty-line">No milestones fall due inside the horizon.</p>}
          {upcomingMilestones.map((m, i) => (
            <div className="row-item tight" key={`${m.id}-${i}`}>
              <div className="row-top">
                <span className="strong">{m.name}</span>
                <span className="micro push">{fmtDate(m.dueDate)}</span>
              </div>
              <button type="button" className="meta linkish" onClick={() => onOpen(m.id)}>{m.project}</button>
            </div>
          ))}
        </article>
      </div>

      <article className="card gap-top" data-reveal>
        <h3>Committed spend by strategic pillar</h3>
        <PillarSpend data={pillars} tk={tk} />
      </article>
    </section>
  );
}
