import { SEVERITY_CHIP } from "../lib/format.js";

const SEVERITY_LABEL = { critical: "Critical", serious: "Serious", warning: "Watch" };

export default function AttentionList({ items, onOpen }) {
  return (
    <section className="card panel" aria-label="Needs executive attention">
      <div className="panel-head">
        <span className="micro">Needs executive attention</span>
        <span className="micro" style={{ color: items.length ? "var(--critical)" : "var(--good)" }}>
          {items.length || "none"}
        </span>
      </div>
      <div className="attention-list">
        {items.length === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 13, padding: "18px 0" }}>
            Nothing requires escalation in this window.
          </div>
        )}
        {items.map((item) => (
          <button
            key={`${item.id}-${item.reason}`}
            type="button"
            className="attention-row"
            onClick={() => onOpen(item.id)}
          >
            <span className={`chip ${SEVERITY_CHIP[item.severity] || "neutral"}`}>
              <i />
              {SEVERITY_LABEL[item.severity] || item.severity}
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="attention-name">{item.name}</span>
              <br />
              <span className="attention-reason">{item.reason}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
