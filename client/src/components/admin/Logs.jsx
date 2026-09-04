/*
 * The service logs, without a remote desktop session.
 *
 * Mirrors DEDB's Logs screen. Three files, a tail rather than the whole thing,
 * and a filter.
 *
 * Two details that are not cosmetic. The wrapper writes UTF-16LE while the
 * application writes UTF-8, so the raw files carry NUL bytes between characters
 * — the server strips them, which is what makes this readable at all. And the
 * files reach tens of megabytes, so only the end is ever read; the screen says
 * when it is showing a window rather than the whole file, because a reader who
 * believes they are seeing everything will conclude an event did not happen.
 */
import { useCallback, useEffect, useState } from "react";
import { get, when } from "./api.js";

const FILES = [
  ["out", "Application", "what the service wrote to stdout"],
  ["err", "Errors", "stderr — crashes and stack traces land here"],
  ["deploy", "Deploy", "what the installer did, and why it rolled back"],
];

const ALARM = /error|fail|refus|denied|exception|fatal|cannot|unable/i;

function bytes(n) {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Logs({ onError }) {
  const [which, setWhich] = useState("out");
  const [lines, setLines] = useState(300);
  const [filter, setFilter] = useState("");
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await get(`/api/admin/logs?which=${encodeURIComponent(which)}&lines=${lines}`));
      onError(null);
    } catch (e) { onError(e.message); }
  }, [which, lines, onError]);

  useEffect(() => { load(); }, [load]);

  const shown = data?.lines
    ? (filter.trim()
        ? data.lines.filter((l) => l.toLowerCase().includes(filter.trim().toLowerCase()))
        : data.lines)
    : [];

  return (
    <section className="card panel r-card">
      <div className="panel-head">
        <h3 className="r-h2">Logs</h3>
        <button type="button" className="btn" onClick={load}>Refresh</button>
      </div>

      <div className="filter-row">
        <label className="field">
          <span className="micro">File</span>
          <select value={which} onChange={(e) => setWhich(e.target.value)}>
            {FILES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="micro">Lines</span>
          <select value={lines} onChange={(e) => setLines(Number(e.target.value))}>
            {[100, 300, 1000, 2000].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="field admin-log-filter">
          <span className="micro">Containing</span>
          <input type="search" value={filter} placeholder="filter these lines"
            onChange={(e) => setFilter(e.target.value)} />
        </label>
      </div>

      <p className="meta">
        {(FILES.find(([id]) => id === which) || [])[2]}
        {data?.exists && <> · {bytes(data.sizeBytes)} · last written {when(data.modifiedAt)}</>}
      </p>

      {!data && <p className="meta">Loading…</p>}
      {data && !data.exists && (
        <p className="meta">
          No such file on this host. The service wrapper creates it on first run, so a
          missing file usually means this deployment has not started under the wrapper.
        </p>
      )}

      {data?.exists && data.truncated && (
        <p className="meta">
          Showing the end of the file only. Earlier entries exist and are not on this
          screen — read the file directly if you need them.
        </p>
      )}

      {data?.exists && !shown.length && (
        <p className="meta">{filter.trim() ? `Nothing in this window matches “${filter.trim()}”.` : "The file is empty."}</p>
      )}

      {!!shown.length && (
        <pre className="admin-log">
          {shown.map((l, i) => (
            <div key={i} className={ALARM.test(l) ? "log-line alarm" : "log-line"}>{l}</div>
          ))}
        </pre>
      )}
    </section>
  );
}
