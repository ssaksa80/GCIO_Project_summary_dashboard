import { useEffect, useRef, useState } from "react";
import { downloadExport } from "../lib/api.js";
import { captureCharts } from "../lib/capture.js";
import { timeAgo } from "../lib/format.js";

const PERIODS = [
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["yearly", "Yearly"],
];

/* Every identity is built from the mandated palette: Pantone 281 C grounds,
   354 C accents, 375 C highlights, secondaries for status and series. */
const THEME_SWATCHES = [
  ["obsidian", "linear-gradient(135deg,#00132f 50%,#00B140 50%)", "Obsidian — midnight navy & green"],
  ["platinum", "linear-gradient(135deg,#f5f7fb 50%,#00205B 50%)", "Platinum — ivory boardroom"],
  ["sapphire", "linear-gradient(135deg,#00205B 50%,#F6BE00 50%)", "Sapphire — navy & gold"],
  ["emerald", "linear-gradient(135deg,#1b1e1c 50%,#97D700 50%)", "Emerald — graphite & lime"],
];

const FONT_OPTIONS = [["arial", "Arial"], ["aptos", "Aptos"]];

const EXPORTS = [
  ["pptx", "PowerPoint deck", "Six-slide board deck in the CIO's four-section order"],
  ["xlsx", "Excel workbook", "Styled portfolio workbook with KPI, RAG fills & charts"],
  ["docx", "Word briefing", "Boardroom briefing document with project briefs"],
  ["html", "HTML brief", "Self-contained page — email or print ready"],
];

export default function TopBar({ period, onPeriod, date, onDate, theme, onTheme, font, onFont, health, onUpload }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const runExport = async (format) => {
    setBusy(format);
    try {
      const images = await captureCharts();
      await downloadExport(format, { period, date, theme, images });
      setMenuOpen(false);
    } catch (err) {
      console.error("export failed:", err);
      alert(`Export failed: ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-name display">GCIO</span>
          <span className="brand-sub">Project Intelligence</span>
        </div>

        <nav className="period-tabs" aria-label="Reporting period">
          {PERIODS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`period-tab${period === key ? " active" : ""}`}
              onClick={() => onPeriod(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        <input
          className="date-input"
          type="date"
          value={date}
          max="2099-12-31"
          onChange={(e) => e.target.value && onDate(e.target.value)}
          aria-label="Anchor date"
        />

        <div className="spacer" />

        <div className="live" title={health?.lastIngestAt ? `Last ingest ${new Date(health.lastIngestAt).toLocaleString()}` : "Waiting for data"}>
          <span className="live-dot" />
          <span>
            LIVE · {health ? `${health.projectCount} projects` : "connecting"}
            {health?.lastIngestAt ? ` · ${timeAgo(health.lastIngestAt)}` : ""}
          </span>
        </div>

        <div className="font-toggle" role="group" aria-label="Typeface">
          {FONT_OPTIONS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`font-btn${font === key ? " active" : ""}`}
              onClick={() => onFont(key)}
              title={key === "aptos" ? "Aptos — Microsoft 365 default (falls back to Segoe UI)" : "Arial — universal standard"}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="theme-swatches" role="group" aria-label="Theme">
          {THEME_SWATCHES.map(([key, bg, label]) => (
            <button
              key={key}
              type="button"
              className={`swatch${theme === key ? " active" : ""}`}
              style={{ background: bg }}
              title={label}
              onClick={() => onTheme(key)}
            />
          ))}
        </div>

        <button
          type="button"
          className="btn ppt"
          onClick={() => runExport("pptx")}
          disabled={Boolean(busy)}
          title="One-click PowerPoint deck of this report"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
          {busy === "pptx" ? "Building deck…" : "PPT"}
        </button>

        <a
          className="btn"
          href="/api/template"
          download
          title="Download the portfolio workbook template — every sheet and column, with an example row"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="12" x2="12" y2="18" /><polyline points="9 15 12 18 15 15" /></svg>
          Template
        </a>

        <button type="button" className="btn" onClick={onUpload}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
          Upload
        </button>

        <div className="menu-wrap" ref={menuRef}>
          <button type="button" className="btn primary" onClick={() => setMenuOpen((o) => !o)} disabled={Boolean(busy)}>
            {busy ? `Preparing ${busy}…` : "Export brief"}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          {menuOpen && (
            <div className="menu">
              {EXPORTS.map(([format, title, sub]) => (
                <button key={format} type="button" className="menu-item" onClick={() => runExport(format)} disabled={Boolean(busy)}>
                  <b>{title}</b>
                  <span>{sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
