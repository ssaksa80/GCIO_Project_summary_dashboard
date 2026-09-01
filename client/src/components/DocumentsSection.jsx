/**
 * Section 6 — Documents.
 *
 * The shell is SectionPosture's, deliberately: the same .sec / .sec-head /
 * .card structure, the same available-vs-absent fork, the same .sub-h card
 * labels and the same h2 → h3 → h4 order. That is what carries the brand
 * palette, the print rules (@media print hides .btn, so the remove control
 * never prints) and the heading order the accessibility suite walks. A
 * bespoke layout here would have quietly lost all three.
 *
 * Three things in here are load-bearing rather than incidental:
 *
 * 1. The heading over the selected sentences reads "Extracted from the
 *    document", never "Summary". A scorer picked these sentences out of the
 *    file; nothing wrote them and nothing read the document. Calling the
 *    block a summary would tell the reader that something understood it.
 *
 * 2. The React key is doc.documentId, and no `id` is ever put on one of these
 *    nodes. annotateChanges walks the whole summary tree and annotates any
 *    node whose `projectId || id` names a project, so a document carrying an
 *    `id` would collect some other record's change badge. The field name is
 *    the only guard there is.
 *
 * 3. pageCount and page are null for .docx, .txt and .md — those formats have
 *    no pages until something renders them. Every page clause is dropped
 *    rather than printed, because "page null" and "0 pages" both read as data.
 */
import { useState } from "react";
import { fmtDate, fmtInt } from "../lib/format.js";
import { useReveal } from "../lib/motion.jsx";

/** ", page 4" for a PDF; nothing at all for a format that has no pages. */
const pageSuffix = (page) => (page == null ? "" : `, page ${page}`);

/** Unique, in first-seen order, capped — the extractor caps neither. */
function firstFew(values, limit = 8) {
  const seen = [];
  for (const value of values) if (!seen.includes(value)) seen.push(value);
  return { shown: seen.slice(0, limit), more: Math.max(0, seen.length - limit) };
}

function FactLine({ label, values, note }) {
  if (!values.length) return null;
  const { shown, more } = firstFew(values);
  return (
    <p className="meta doc-facts">
      <span className="micro doc-facts-label">{label}</span>
      {shown.join(" · ")}
      {more > 0 ? <span className="micro">{` +${more} more`}</span> : null}
      {note ? <span className="micro">{` — ${note}`}</span> : null}
    </p>
  );
}

export default function DocumentsSection({ data, canRemove = false, onRemove }) {
  const ref = useReveal([data]);
  const [busyId, setBusyId] = useState(null);
  const [failure, setFailure] = useState(null);

  const remove = async (documentId) => {
    setBusyId(documentId);
    setFailure(null);
    try {
      await onRemove?.(documentId);
    } catch (err) {
      setFailure({ documentId, message: err.message });
    } finally {
      setBusyId(null);
    }
  };

  if (!data?.available) {
    return (
      <section className="sec" id="documents" data-section="documents" ref={ref}>
        <header className="sec-head">
          <span className="sec-n">6</span>
          <h2 className="sec-title display">Documents</h2>
        </header>
        <article className="card" data-reveal>
          <p className="empty-line">
            {data?.headline || "No documents have been imported yet."} Drop a PDF, Word,
            text or Markdown file into the same upload panel the workbooks use, and this
            section fills itself in.
          </p>
        </article>
      </section>
    );
  }

  const { documents, headline } = data;

  return (
    <section className="sec" id="documents" data-section="documents" ref={ref}>
      <header className="sec-head">
        <span className="sec-n">6</span>
        <h2 className="sec-title display">Documents</h2>
        <p className="sec-sub">{headline}</p>
      </header>

      {documents.map((doc, i) => (
        <article className={`card${i ? " gap-top" : ""}`} data-reveal key={doc.documentId}>
          <div className="row-top">
            <h3 className="doc-title">{doc.title}</h3>
            <span className="chip muted">{doc.kind}</span>
            {canRemove && (
              <button
                type="button"
                className="btn push"
                onClick={() => remove(doc.documentId)}
                disabled={busyId === doc.documentId}
              >
                {busyId === doc.documentId ? "Removing…" : "Remove this document"}
              </button>
            )}
          </div>

          <p className="micro doc-meta">
            {doc.fileName}
            {/* No page clause at all when the format has no pages. */}
            {doc.pageCount == null ? "" : ` · ${doc.pageCount} page${doc.pageCount === 1 ? "" : "s"}`}
            {` · ${fmtInt(doc.wordCount)} words`}
            {doc.extractedAt ? ` · read ${fmtDate(doc.extractedAt)}` : ""}
          </p>

          {failure?.documentId === doc.documentId && (
            <p className="micro critical-ink doc-meta">
              Could not remove this document: {failure.message}
            </p>
          )}

          {/* A scan with no text layer arrives with an empty summary and a
              warning. It has to render as a document that says why it is
              thin, not as a blank card. */}
          {doc.warnings.length > 0 && (
            <ul className="doc-warnings">
              {doc.warnings.map((w, wi) => (
                <li key={`${doc.documentId}-w-${wi}`}>{w}</li>
              ))}
            </ul>
          )}

          <h4 className="sub-h">Extracted from the document</h4>
          {doc.summary.length > 0 ? (
            <ul className="doc-extract">
              {doc.summary.map((s, si) => (
                <li key={`${doc.documentId}-s-${si}`}>
                  <q className="doc-quote">{s.text}</q>
                  <span className="micro doc-provenance">
                    {s.heading || "document"}{pageSuffix(s.page)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-line">
              {doc.warnings.length > 0
                ? "No sentence could be selected from this file — see the warning above."
                : "No sentence could be selected from this file."}
            </p>
          )}

          {/* Reported as the strings they are. Nothing here resolves a
              reference to a project record: a wrong attachment would file
              misleading evidence under a real project. */}
          <FactLine
            label="Mentions"
            values={doc.projectRefs}
            note="reported as written, not linked to a project record"
          />
          <FactLine label="Dates found" values={doc.dates.map((d) => fmtDate(d.iso))} />
          {/* money.amount is the matched string, commas and all — the literal
              text is what gets shown, never a number parsed out of it. */}
          <FactLine label="Amounts found" values={doc.money.map((m) => m.text)} />
        </article>
      ))}
    </section>
  );
}
