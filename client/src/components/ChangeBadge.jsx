/**
 * What moved, in as few characters as a slide can carry.
 *
 * `change` is one of two shapes, or absent entirely:
 *   - { trackedSince }                       first seen inside this period — no comparison to show
 *   - { fields, headline, worst, since, ... } it moved; `worst` is "worse" | "better" | "neutral"
 *
 * Three states, and they mean different things: a change (say what and which
 * way), newly tracked (say since when — NOT "no change", which we cannot
 * claim), and nothing at all when the item did not move.
 *
 * `change` is read-only here. `annotateChanges` puts the SAME object reference
 * on every section item sharing a project id, so mutating it would leak into
 * every other place that project appears.
 */
import { fmtDate } from "../lib/format.js";

export default function ChangeBadge({ change }) {
  if (!change) return null;

  if (change.trackedSince) {
    const since = fmtDate(change.trackedSince);
    return <span className="change change-new" title={`First recorded ${since}`}>new since {since}</span>;
  }

  /* Three states, not two. A neutral move — an ordinary status transition, a
     budget that changed for reasons we cannot read — is neither an improvement
     nor a regression, and painting it green would tell the CIO something the
     data does not support. */
  const mark = change.worst === "worse" ? "▲" : change.worst === "better" ? "▼" : "•";

  return (
    <span className={`change change-${change.worst}`} title={describe(change)}>
      {mark} {change.headline}
    </span>
  );
}

function describe(change) {
  return Object.entries(change.fields)
    .map(([field, f]) => `${field}: ${f.from} → ${f.to}`)
    .join("\n");
}
