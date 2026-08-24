/** Slim portfolio KPI strip — the only thing above section 1. */
import { fmtMoney } from "../lib/format.js";
import { CountUp, usePulse } from "../lib/motion.jsx";

export default function KpiStrip({ kpis, questionCount, lastIngestAt }) {
  const pulseRef = usePulse(lastIngestAt);
  const healthyPct = kpis.totalProjects ? Math.round((kpis.health.green / kpis.totalProjects) * 100) : 0;

  return (
    <div className="kpi-strip" ref={pulseRef}>
      <div className="kpi">
        <span className="lab">Portfolio</span>
        <span className="val"><CountUp value={kpis.totalProjects} /></span>
        <span className="sub">{kpis.active} active · {kpis.onHold} on hold</span>
      </div>

      <div className="kpi">
        <span className="lab">Health mix</span>
        <span className="rag">
          <i className="good" /><b>{kpis.health.green}</b>
          <i className="warn" /><b>{kpis.health.amber}</b>
          <i className="critical" /><b>{kpis.health.red}</b>
        </span>
        <span className="sub">{healthyPct}% healthy</span>
      </div>

      <div className="kpi">
        <span className="lab">Committed</span>
        <span className="val">{fmtMoney(kpis.budgetTotal)}</span>
        <span className="sub">{Math.round(kpis.budgetUtilizationPct)}% consumed</span>
      </div>

      <div className="kpi">
        <span className="lab">Delivered this period</span>
        <span className="val"><CountUp value={kpis.completedInPeriod} /></span>
        <span className="sub">{kpis.approvedInPeriod} approved · {kpis.startedInPeriod} started</span>
      </div>

      <div className="kpi">
        <span className="lab">Overdue</span>
        <span className="val critical-ink"><CountUp value={kpis.overdue} /></span>
        <span className="sub">{kpis.milestonesOverdue} milestones slipped</span>
      </div>

      <div className="kpi">
        <span className="lab">Open questions</span>
        <span className="val"><CountUp value={questionCount} /></span>
        <span className="sub">awaiting a decision</span>
      </div>
    </div>
  );
}
