import { useRef, useState } from "react";
import { uploadWorkbooks } from "../lib/api.js";

/* Workbooks and documents go through one route: /api/ingest/upload forks on
   the extension, so widening the picker is all the client has to do. Keep in
   step with DOCUMENT_EXTENSIONS in server/documents/extract.js. */
const ACCEPT = ".xlsx,.xls,.xlsm,.csv,.pdf,.docx,.txt,.md";

/**
 * The two forks of the upload route report different things: a workbook comes
 * back with a project count, a document with the title it was read as and any
 * warnings. Reading `r.projects` off a document printed "undefined projects
 * ingested", so the shape is what decides which sentence is true.
 */
function noteFor(result) {
  if (typeof result.projects === "number") return `${result.projects} projects ingested`;
  const title = result.document ? `imported as "${result.document}"` : "imported";
  return result.warnings?.length ? `${title} · ${result.warnings.join(" · ")}` : title;
}

export default function UploadPanel({ onClose, onDone }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);
  const inputRef = useRef(null);

  const handleFiles = async (fileList) => {
    const files = [...fileList].slice(0, 20);
    if (!files.length) return;
    setBusy(true);
    try {
      const res = await uploadWorkbooks(files);
      setResults([
        ...res.ingested.map((r) => ({ file: r.file, ok: true, note: noteFor(r) })),
        ...res.errors.map((r) => ({ file: r.file, ok: false, note: r.error })),
      ]);
      if (res.ingested.length) onDone();
    } catch (err) {
      setResults([{ file: "upload", ok: false, note: err.message }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal">
      <div className="backdrop" onClick={onClose} />
      <div className="card modal-card">
        <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">✕</button>
        <span className="micro">Data ingestion</span>
        <h2 className="display" style={{ fontSize: 21, margin: "6px 0 14px" }}>Upload workbooks and documents</h2>

        <div
          className={`dropzone${over ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && inputRef.current?.click()}
        >
          <b>{busy ? "Ingesting…" : "Drop workbooks or documents here, or click to browse"}</b>
          <p>Single or bulk · .xlsx, .xls, .xlsm, .csv · .pdf, .docx, .txt, .md · up to 20 files · workbook headers are matched intelligently</p>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
          />
        </div>

        {results.length > 0 && (
          <div className="upload-results">
            {results.map((r) => (
              <div key={`${r.file}-${r.note}`} className={`upload-result${r.ok ? "" : " err"}`}>
                <b style={{ fontWeight: 560 }}>{r.file}</b>
                <span style={{ color: r.ok ? "var(--good)" : "var(--critical-ink)" }}>{r.note}</span>
              </div>
            ))}
          </div>
        )}

        <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 16, lineHeight: 1.55 }}>
          Workbooks are stored in the watched <code>data/</code> folder — the dashboard also ingests anything dropped
          there directly, 24×7. Documents are kept separately and read for their dates, amounts and key sentences;
          they appear in the Documents section. Need the canonical workbook format?{" "}
          <a href="/api/template" style={{ color: "var(--accent)" }}>Download the template</a>.
        </p>
      </div>
    </div>
  );
}
