/*
 * The version footer, and what is behind it.
 *
 * Ports DEDB's About: an unobtrusive "name vX.Y.Z · About" line, and a modal
 * with the build details and the maintainer credit.
 *
 * FAIL-SOFT BY DESIGN, which is the part worth keeping. Every failure mode -
 * offline, non-200, a body that will not parse - leaves the footer hidden
 * rather than throwing into the shell around it. A version line is a courtesy;
 * it must never be the reason a page fails to render.
 *
 * It reads the PUBLIC /api/about, so it works on the sign-in screen too. A
 * version number is the first thing anyone is asked for when reporting a
 * problem, and requiring a session to see it would hide it from exactly the
 * people who cannot get in.
 */
import { useEffect, useRef, useState } from "react";

export default function About() {
  const [info, setInfo] = useState(null);
  const [open, setOpen] = useState(false);
  const dialogRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/about", { credentials: "include" });
        if (!res || !res.ok || typeof res.json !== "function") return;
        const data = await res.json();
        if (alive && data && data.version) setInfo(data);
      } catch {
        /* hidden, deliberately: see the note above */
      }
    })();
    return () => { alive = false; };
  }, []);

  /* Escape closes, and focus moves into the dialog, matching the drawer and the
     admin console. A modal that traps neither is one a keyboard user cannot
     leave. */
  useEffect(() => {
    if (!open) return undefined;
    const node = dialogRef.current;
    const previous = document.activeElement;
    node?.focus();
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  if (!info) return null;

  return (
    <>
      <footer className="about-foot">
        <span>{info.name} v{info.version}</span>
        <span aria-hidden="true">·</span>
        <button type="button" className="about-link" onClick={() => setOpen(true)}>About</button>
      </footer>

      {open && (
        <div className="backdrop" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="card modal about-modal" role="dialog" aria-modal="true"
               aria-label={`About ${info.name}`} tabIndex={-1} ref={dialogRef}>
            <h2 className="display about-title">{info.name}</h2>
            <p className="meta about-version">
              Version {info.version}{info.node ? ` · Node ${info.node}` : ""}
            </p>

            {info.description && <p className="about-body">{info.description}</p>}
            {info.support && <p className="meta about-body">{info.support}</p>}

            {/* Authorship, not runtime metadata, so it renders even when the
                endpoint returns a minimal payload. */}
            <div className="about-credit">
              <span className="micro">Maintained &amp; developed by</span>
              <strong>SHAIKH SHOAIB</strong>
              <span>Sr. Advisor Delivery Specialist</span>
              <span>DELL Technologies</span>
            </div>

            <div className="about-actions">
              <button type="button" className="btn primary" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
