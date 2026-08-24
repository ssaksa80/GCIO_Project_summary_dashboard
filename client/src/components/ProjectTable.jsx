import { useEffect, useMemo, useState } from "react";
import { getJSON } from "../lib/api.js";
import { fmtMoney, fmtDate, HEALTH_CHIP } from "../lib/format.js";

const COLUMNS = [
  ["name", "Project"],
  ["department", "Department"],
  ["owner", "Owner"],
  ["status", "Status"],
  ["health", "Health"],
  ["budget", "Budget"],
  ["budgetUtilization", "Utilization"],
  ["percentComplete", "Complete"],
  ["targetEndDate", "Target end"],
];

const STATUS_CHIP = {
  "In Progress": "neutral",
  Approved: "good",
  Proposed: "neutral",
  "On Hold": "warn",
  Completed: "good",
  Cancelled: "neutral",
};

export default function ProjectTable({ meta, onOpen, refreshTick }) {
  const [rows, setRows] = useState([]);
  const [department, setDepartment] = useState("");
  const [status, setStatus] = useState("");
  const [health, setHealth] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("-budget");

  useEffect(() => {
    const params = new URLSearchParams();
    if (department) params.set("department", department);
    if (status) params.set("status", status);
    if (health) params.set("health", health);
    if (q) params.set("q", q);
    params.set("sort", sort);
    const timer = setTimeout(() => {
      getJSON(`/api/projects?${params}`)
        .then((res) => setRows(res.projects))
        .catch((err) => console.error("projects fetch failed:", err));
    }, q ? 200 : 0);
    return () => clearTimeout(timer);
  }, [department, status, health, q, sort, refreshTick]);

  const toggleSort = (field) => {
    setSort((cur) => (cur === `-${field}` ? field : `-${field}`));
  };

  const sortGlyph = useMemo(() => {
    const desc = sort.startsWith("-");
    return { field: desc ? sort.slice(1) : sort, glyph: desc ? "↓" : "↑" };
  }, [sort]);

  const utilizationColor = (u) => (u > 100 ? "var(--critical)" : u > 85 ? "var(--warn)" : "var(--accent)");

  return (
    <section className="card panel" aria-label="Project portfolio">
      <div className="panel-head">
        <span className="micro">Project portfolio</span>
        <span className="micro">{rows.length} shown</span>
      </div>

      <div className="filter-row">
        <select value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department filter">
          <option value="">All departments</option>
          {(meta?.departments || []).map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
          <option value="">All statuses</option>
          {(meta?.statuses || []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={health} onChange={(e) => setHealth(e.target.value)} aria-label="Health filter">
          <option value="">All health</option>
          {["Green", "Amber", "Red"].map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <input
          type="search"
          placeholder="Search project, ID, owner, sponsor…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search projects"
        />
      </div>

      <div className="table-wrap">
        <table className="projects">
          <thead>
            <tr>
              {COLUMNS.map(([field, label]) => (
                <th key={field} onClick={() => toggleSort(field)}>
                  {label}{sortGlyph.field === field ? ` ${sortGlyph.glyph}` : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} onClick={() => onOpen(p.id)}>
                <td className="cell-name" title={p.name}>
                  {p.name}
                  <div className="cell-sub">{p.id}{p.program ? ` · ${p.program}` : ""}</div>
                </td>
                <td>{p.department}</td>
                <td>{p.owner || "—"}</td>
                <td><span className={`chip ${STATUS_CHIP[p.status] || "neutral"}`}><i />{p.status}</span></td>
                <td><span className={`chip ${HEALTH_CHIP[p.health] || "neutral"}`}><i />{p.health}</span></td>
                <td className="num">{fmtMoney(p.budget)}</td>
                <td>
                  <span className="mini-bar" title={`${p.budgetUtilization}% of budget spent`}>
                    <i style={{ width: `${Math.min(100, p.budgetUtilization)}%`, background: utilizationColor(p.budgetUtilization) }} />
                  </span>
                  <span className="num" style={{ marginLeft: 8, fontSize: 11, color: "var(--muted)" }}>{Math.round(p.budgetUtilization)}%</span>
                </td>
                <td>
                  <span className="mini-bar">
                    <i style={{ width: `${p.percentComplete}%`, background: "var(--accent-2)" }} />
                  </span>
                  <span className="num" style={{ marginLeft: 8, fontSize: 11, color: "var(--muted)" }}>{Math.round(p.percentComplete)}%</span>
                </td>
                <td className="num" style={p.overdue ? { color: "var(--critical)", fontWeight: 600 } : undefined}>
                  {fmtDate(p.targetEndDate)}{p.overdue ? " ⚠" : ""}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={COLUMNS.length} style={{ textAlign: "center", color: "var(--muted)", padding: 26 }}>No projects match the current filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
