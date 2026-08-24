export default function NarrativePanel({ narrative }) {
  if (!narrative) return null;
  return (
    <section className="card panel" aria-label="Executive briefing">
      <div className="panel-head">
        <span className="micro">Executive briefing</span>
      </div>
      <p className="narrative-headline">{narrative.headline}</p>

      {narrative.bullets.length > 0 && (
        <ul className="narrative-bullets">
          {narrative.bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}

      {(narrative.wins.length > 0 || narrative.risks.length > 0) && (
        <div className="ww-grid">
          <div className="ww-col wins">
            <h4 className="micro">Wins</h4>
            <ul>
              {narrative.wins.length ? narrative.wins.map((w) => <li key={w}>{w}</li>) : <li>No completions recorded in this window.</li>}
            </ul>
          </div>
          <div className="ww-col watch">
            <h4 className="micro">Watch-list</h4>
            <ul>
              {narrative.risks.length ? narrative.risks.map((r) => <li key={r}>{r}</li>) : <li>No red-flag items in this window.</li>}
            </ul>
          </div>
        </div>
      )}

      <p className="outlook">{narrative.outlook}</p>
    </section>
  );
}
