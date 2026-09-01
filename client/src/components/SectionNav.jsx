/** Sticky section rail — the CIO's sections, always in order. */
import { scrollToSection, useScrollSpy } from "../lib/motion.jsx";

export const SECTIONS = [
  { id: "successes", n: 1, label: "Successes" },
  { id: "questions", n: 2, label: "Questions, Risks & Issues" },
  { id: "priorities", n: 3, label: "Priorities" },
  { id: "roadmap", n: 4, label: "Roadmap / Planned" },
  { id: "posture", n: 5, label: "Security Posture" },
  { id: "documents", n: 6, label: "Documents" },
];

const IDS = SECTIONS.map((s) => s.id);

export default function SectionNav() {
  const active = useScrollSpy(IDS);

  return (
    <nav className="sec-nav" aria-label="Report sections">
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`sec-pill ${active === s.id ? "on" : ""}`}
          aria-current={active === s.id ? "true" : undefined}
          onClick={() => scrollToSection(s.id)}
        >
          <span className="n">{s.n}</span>
          {s.label}
        </button>
      ))}
    </nav>
  );
}
