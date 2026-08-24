import { useMemo } from "react";
import {
  ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { fmtMoney, fmtInt } from "../lib/format.js";

/** Read live CSS custom properties; recomputed whenever the theme changes. */
function useThemeTokens(theme) {
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const t = (name) => css.getPropertyValue(name).trim();
    return {
      surface: t("--chart-surface"),
      ink: t("--ink"),
      ink2: t("--ink-2"),
      muted: t("--muted"),
      good: t("--good"),
      warn: t("--warn"),
      critical: t("--critical"),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => t(`--series-${i}`)),
      grid: "color-mix(in srgb, currentColor 10%, transparent)",
    };
  }, [theme]);
}

function ChartTip({ active, payload, label, money }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="tip">
      {label !== undefined && <b>{label}</b>}
      {payload.map((entry) => (
        <div className="row" key={entry.dataKey || entry.name}>
          <span className="dot" style={{ background: entry.color || entry.payload?.fill }} />
          {entry.name}
          <span className="val">{money ? fmtMoney(entry.value) : fmtInt(entry.value)}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ entries }) {
  return (
    <div className="legend-row">
      {entries.map(([label, color]) => (
        <span className="legend-item" key={label}>
          <span className="legend-swatch" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

const AXIS_STYLE = { fontSize: 11, fontFamily: "inherit" };

export default function ChartsGrid({ charts, theme, onOpenProject }) {
  const tk = useThemeTokens(theme);
  const axisTick = { ...AXIS_STYLE, fill: tk.muted };
  const gridStroke = `${tk.ink}1a`; // ~10% ink hairline

  const donutTotal = charts.statusBreakdown.reduce((a, s) => a + s.value, 0);
  const trendKeys = [
    ["completed", "Completed", tk.series[0]],
    ["approved", "Approved", tk.series[1]],
    ["started", "Started", tk.series[2]],
  ];

  return (
    <section className="grid-charts" aria-label="Portfolio charts">
      {/* Status mix — donut with center total */}
      <div className="card panel">
        <div className="panel-head"><span className="micro">Portfolio status mix</span></div>
        <div className="chart-box" data-export-chart="status-mix">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={charts.statusBreakdown}
                dataKey="value"
                nameKey="label"
                innerRadius="58%"
                outerRadius="86%"
                paddingAngle={1.5}
                stroke={tk.surface}
                strokeWidth={2}
                isAnimationActive={false}
              >
                {charts.statusBreakdown.map((entry, i) => (
                  <Cell key={entry.label} fill={tk.series[i % 8]} />
                ))}
              </Pie>
              <text x="50%" y="47%" textAnchor="middle" className="donut-center">{donutTotal}</text>
              <text x="50%" y="58%" textAnchor="middle" className="donut-center-sub">projects</text>
              <Tooltip content={<ChartTip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <Legend entries={charts.statusBreakdown.map((s, i) => [`${s.label} (${s.value})`, tk.series[i % 8]])} />
      </div>

      {/* Delivery trend — lines */}
      <div className="card panel">
        <div className="panel-head"><span className="micro">Delivery trend</span></div>
        <div className="chart-box" data-export-chart="delivery-trend">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={charts.completionTrend} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={gridStroke} vertical={false} />
              <XAxis dataKey="bucket" tick={axisTick} tickLine={false} axisLine={{ stroke: gridStroke }} interval="preserveStartEnd" />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTip />} cursor={{ stroke: tk.muted, strokeDasharray: "3 3" }} />
              {trendKeys.map(([key, name, color]) => (
                <Line key={key} dataKey={key} name={name} stroke={color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <Legend entries={trendKeys.map(([, name, color]) => [name, color])} />
      </div>

      {/* Budget vs spent by department — grouped thin bars */}
      <div className="card panel">
        <div className="panel-head"><span className="micro">Budget vs spent · by department</span></div>
        <div className="chart-box" data-export-chart="budget-dept">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={charts.budgetByDepartment} margin={{ top: 8, right: 12, left: 6, bottom: 0 }} barGap={3}>
              <CartesianGrid stroke={gridStroke} vertical={false} />
              <XAxis
                dataKey="department"
                tick={{ ...axisTick, width: 110 }}
                tickLine={false}
                axisLine={{ stroke: gridStroke }}
                interval={0}
                tickFormatter={(v) => (v.length > 13 ? `${v.slice(0, 12)}…` : v)}
              />
              <YAxis tick={axisTick} tickLine={false} axisLine={false} tickFormatter={(v) => fmtMoney(v).replace("AED ", "")} width={54} />
              <Tooltip content={<ChartTip money />} cursor={{ fill: `${tk.ink}0d` }} />
              <Bar dataKey="budget" name="Budget" fill={tk.series[0]} radius={[4, 4, 0, 0]} maxBarSize={16} isAnimationActive={false} />
              <Bar dataKey="spent" name="Spent" fill={tk.series[1]} radius={[4, 4, 0, 0]} maxBarSize={16} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <Legend entries={[["Budget", tk.series[0]], ["Spent", tk.series[1]]]} />
      </div>

      {/* Health by department — stacked horizontal RAG */}
      <div className="card panel">
        <div className="panel-head"><span className="micro">Health by department</span></div>
        <div className="chart-box" data-export-chart="health-dept">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={charts.healthByDepartment} layout="vertical" margin={{ top: 4, right: 18, left: 30, bottom: 0 }}>
              <CartesianGrid stroke={gridStroke} horizontal={false} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="department"
                tick={{ ...axisTick, width: 128 }}
                tickLine={false}
                axisLine={{ stroke: gridStroke }}
                width={132}
                tickFormatter={(v) => (v.length > 17 ? `${v.slice(0, 16)}…` : v)}
              />
              <Tooltip content={<ChartTip />} cursor={{ fill: `${tk.ink}0d` }} />
              <Bar dataKey="green" name="Green" stackId="rag" fill={tk.good} stroke={tk.surface} strokeWidth={2} maxBarSize={14} isAnimationActive={false} />
              <Bar dataKey="amber" name="Amber" stackId="rag" fill={tk.warn} stroke={tk.surface} strokeWidth={2} maxBarSize={14} isAnimationActive={false} />
              <Bar dataKey="red" name="Red" stackId="rag" fill={tk.critical} stroke={tk.surface} strokeWidth={2} maxBarSize={14} radius={[0, 4, 4, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <Legend entries={[["Green", tk.good], ["Amber", tk.warn], ["Red", tk.critical]]} />
      </div>
    </section>
  );
}
