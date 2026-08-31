import { fmtMoney, fmtInt, fmtPct } from "../lib/format.js";

const PERIOD_WORD = { daily: "today", weekly: "this week", monthly: "this month", yearly: "this year" };

export default function KpiRow({ kpis, period }) {
  const word = PERIOD_WORD[period] || "this period";
  const healthy = kpis.totalProjects ? Math.round((kpis.health.green / kpis.totalProjects) * 100) : 0;

  const tiles = [
    {
      label: "Active projects",
      value: fmtInt(kpis.active),
      sub: `${fmtInt(kpis.totalProjects)} total · ${fmtInt(kpis.onHold)} on hold`,
    },
    {
      label: "Portfolio health",
      value: fmtPct(healthy),
      sub: (
        <>
          <span className="chip good"><i />{kpis.health.green} G</span>
          <span className="chip warn"><i />{kpis.health.amber} A</span>
          <span className="chip critical"><i />{kpis.health.red} R</span>
        </>
      ),
    },
    {
      label: "Budget consumed",
      value: fmtMoney(kpis.spentTotal),
      sub: `of ${fmtMoney(kpis.budgetTotal)} committed`,
      bar: Math.min(100, kpis.budgetUtilizationPct),
    },
    {
      label: `Delivered ${word}`,
      value: fmtInt(kpis.completedInPeriod),
      sub: `${fmtInt(kpis.approvedInPeriod)} approved · ${fmtInt(kpis.startedInPeriod)} started`,
    },
    {
      label: "Overdue",
      value: fmtInt(kpis.overdue),
      sub: `${fmtInt(kpis.milestonesOverdue)} milestones slipped`,
      alert: kpis.overdue > 0,
    },
    {
      label: "Open risks",
      value: fmtInt(kpis.openRisks),
      sub: `${fmtInt(kpis.criticalRisks)} critical`,
      alert: kpis.criticalRisks > 0,
    },
  ];

  return (
    <section className="grid-kpi" aria-label="Key indicators">
      {tiles.map((t) => (
        <div key={t.label} className="card kpi">
          <span className="micro">{t.label}</span>
          <span className="hero-num" style={t.alert ? { color: "var(--critical-ink)" } : undefined}>{t.value}</span>
          <span className="kpi-sub">{t.sub}</span>
          {t.bar !== undefined && (
            <span className="kpi-bar"><i style={{ width: `${t.bar}%` }} /></span>
          )}
        </div>
      ))}
    </section>
  );
}
