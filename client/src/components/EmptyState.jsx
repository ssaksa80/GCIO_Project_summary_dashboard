export default function EmptyState({ onUpload }) {
  return (
    <div className="card empty-hero">
      <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 3v18h18" />
        <rect x="7" y="12" width="3" height="6" rx="1" />
        <rect x="12" y="8" width="3" height="10" rx="1" />
        <rect x="17" y="5" width="3" height="13" rx="1" />
      </svg>
      <h2>Awaiting portfolio data</h2>
      <p>
        The dashboard is live and watching for workbooks. Drop Excel files into the <code>data/</code> folder
        on the server, or upload them here — single files or the whole portfolio in bulk.
      </p>
      <button type="button" className="btn primary" onClick={onUpload}>Upload workbooks</button>
    </div>
  );
}
