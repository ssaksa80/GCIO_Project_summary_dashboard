/**
 * Section charts. Each is wrapped in [data-export-chart] so the export capture
 * (lib/capture.js) can lift it into the Word / Excel / HTML briefs at 2x.
 * Colours come from the theme's CSS custom properties, which are all drawn
 * from the mandated brand palette.
 */
import { useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Cell,
} from "recharts";
import { fmtInt, fmtMoney } from "../lib/format.js";

export function useTokens(theme) {
  return useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    /* Custom properties come back unresolved ("var(--p354)"), and Recharts
       writes them into SVG presentation attributes where var() means nothing.
       Follow the chain to a literal colour before handing it over. */
    const t = (name, depth = 0) => {
      const value = css.getPropertyValue(name).trim();
      const chained = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
      if (chained && depth < 6) return t(chained[1], depth + 1);
      return value;
    };
    return {
      surface: t("--chart-surface"),
      ink: t("--ink"),
      muted: t("--muted"),
      good: t("--good"),
      warn: t("--warn"),
      critical: t("--critical"),
      grid: t("--hairline"),
      series: [1, 2, 3, 4, 5, 6].map((i) => t(`--series-${i}`)),
    };
  }, [theme]);
}

function Tip({ active, payload, label, money }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip">
      {label !== undefined && <b>{label}</b>}
      {payload.map((e) => (
        <div className="row" key={e.dataKey || e.name}>
          <span className="dot" style={{ background: e.color || e.fill }} />
          {e.name}
          <span className="val">{money ? fmtMoney(e.value) : fmtInt(e.value)}</span>
        </div>
      ))}
    </div>
  );
}

const axis = (muted) => ({ fontSize: 11, fill: muted, fontFamily: "inherit" });

/** Section 1 — completions, approvals and starts across the trend buckets. */
export function DeliveryTrend({ data, tk }) {
  return (
    <div className="chart-frame" data-export-chart="delivery-trend">
      <ResponsiveContainer width="100%" height={210}>
        <LineChart data={data} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={tk.grid} vertical={false} />
          <XAxis dataKey="bucket" tick={axis(tk.muted)} tickLine={false} axisLine={false} />
          <YAxis tick={axis(tk.muted)} tickLine={false} axisLine={false} allowDecimals={false} width={34} />
          <Tooltip content={<Tip />} cursor={{ stroke: tk.grid }} />
          <Line isAnimationActive={false} type="monotone" dataKey="completed" name="Completed" stroke={tk.good} strokeWidth={2.5} dot={false} />
          <Line isAnimationActive={false} type="monotone" dataKey="approved" name="Approved" stroke={tk.series[2]} strokeWidth={2} dot={false} />
          <Line isAnimationActive={false} type="monotone" dataKey="started" name="Started" stroke={tk.series[1]} strokeWidth={2} strokeDasharray="5 4" dot={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="legend-row">
        <span className="legend-item"><i style={{ background: tk.good }} />Completed</span>
        <span className="legend-item"><i style={{ background: tk.series[2] }} />Approved</span>
        <span className="legend-item"><i style={{ background: tk.series[1] }} />Started</span>
      </div>
    </div>
  );
}

/** Section 2 — RAG mix per department, worst first. */
export function HealthByDepartment({ data, tk }) {
  return (
    <div className="chart-frame" data-export-chart="health-by-department">
      <ResponsiveContainer width="100%" height={Math.max(180, data.length * 30)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }} barSize={13}>
          <CartesianGrid stroke={tk.grid} horizontal={false} />
          <XAxis type="number" tick={axis(tk.muted)} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis type="category" dataKey="department" tick={axis(tk.muted)} tickLine={false} axisLine={false} width={128} />
          <Tooltip content={<Tip />} cursor={{ fill: tk.grid }} />
          <Bar isAnimationActive={false} dataKey="green" name="Green" stackId="h" fill={tk.good} radius={[3, 0, 0, 3]} />
          <Bar isAnimationActive={false} dataKey="amber" name="Amber" stackId="h" fill={tk.warn} />
          <Bar isAnimationActive={false} dataKey="red" name="Red" stackId="h" fill={tk.critical} radius={[0, 3, 3, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Section 4 — committed spend by strategic pillar. */
export function PillarSpend({ data, tk }) {
  return (
    <div className="chart-frame" data-export-chart="pillar-spend">
      <ResponsiveContainer width="100%" height={Math.max(170, data.length * 34)}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }} barSize={16}>
          <CartesianGrid stroke={tk.grid} horizontal={false} />
          <XAxis type="number" tick={axis(tk.muted)} tickLine={false} axisLine={false}
            tickFormatter={(v) => fmtMoney(v).replace("AED ", "")} />
          <YAxis type="category" dataKey="pillar" tick={axis(tk.muted)} tickLine={false} axisLine={false} width={132} />
          <Tooltip content={<Tip money />} cursor={{ fill: tk.grid }} />
          <Bar isAnimationActive={false} dataKey="budget" name="Committed" radius={[0, 4, 4, 0]}>
            {data.map((row, i) => <Cell key={row.pillar} fill={tk.series[i % tk.series.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
