/**
 * Prometheus text exposition.
 *
 * Open at the application and blocked at the proxy, which is only defensible
 * while this holds nothing but numbers: no project name, no person, no
 * filename, no error text, and no label value read from a workbook. A test
 * enforces that; do not add a series that would break it.
 *
 * Everything here is read from what the app already knows. Nothing is computed
 * that the dashboard does not already compute, and a failure to read the
 * optional parts degrades to omitting them rather than failing the scrape —
 * monitoring that goes dark when the database does is worse than useless.
 */

const OUTCOMES = ["applied", "unchanged", "failed", "removed"];

const line = (name, value, labels = "") =>
  `${name}${labels ? `{${labels}}` : ""} ${value}`;

function series(out, name, help, type, rows) {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows);
}

/**
 * @param {{store: object, startedAt: number, version?: string,
 *          ingestTiming?: object|null, runOutcomes?: object|null}} input
 * @returns {Promise<string>} the exposition body
 */
export async function renderMetrics({ store, startedAt, version = "unknown", ingestTiming = null, runOutcomes = null }) {
  const out = [];

  series(out, "gcio_up", "1 when the process is serving.", "gauge", [line("gcio_up", 1)]);
  series(out, "gcio_build_info", "Build version, as a label on a constant 1.", "gauge",
    [line("gcio_build_info", 1, `version="${version}"`)]);
  series(out, "gcio_uptime_seconds", "Seconds since the process started.", "gauge",
    [line("gcio_uptime_seconds", Math.round((Date.now() - startedAt) / 1000))]);

  series(out, "gcio_ready", "1 when there is a portfolio to serve.", "gauge",
    [line("gcio_ready", store.ready ? 1 : 0)]);
  series(out, "gcio_demo_mode", "1 when serving bundled sample data rather than real workbooks.", "gauge",
    [line("gcio_demo_mode", store.demoMode ? 1 : 0)]);

  series(out, "gcio_projects", "Projects currently served.", "gauge",
    [line("gcio_projects", store.projectCount ?? 0)]);
  series(out, "gcio_source_files", "Workbooks currently contributing to the portfolio.", "gauge",
    [line("gcio_source_files", store.fileCount ?? 0)]);

  /* Always emitted, unlike the timing series below: the natural alert is
     `time() - gcio_last_ingest_timestamp_seconds > threshold`, and against a
     missing series that comparison yields an empty vector rather than a firing
     alert -- the standard Prometheus absent() trap, and exactly backwards for
     the state most worth alerting on. 0 when nothing has ever been ingested
     reads as maximally stale under that same comparison, which is the truth. */
  series(out, "gcio_last_ingest_timestamp_seconds",
    "When the portfolio last changed, or 0 if it never has.", "gauge",
    [line("gcio_last_ingest_timestamp_seconds",
      store.lastIngestAt ? Math.round(Date.parse(store.lastIngestAt) / 1000) : 0)]);

  if (runOutcomes) {
    /* All four, always — a missing series is a gap on a graph, a zero is
       "nothing failed", and those must not look the same. */
    series(out, "gcio_ingest_runs", "Ingest attempts by outcome.", "counter",
      OUTCOMES.map((o) => line("gcio_ingest_runs", runOutcomes[o] ?? 0, `outcome="${o}"`)));
  }

  if (ingestTiming) {
    /* Number.isFinite, not `!== null`: a partial shape (a field missing
       rather than explicitly null) must omit the series too, not render
       `gcio_ingest_parse_slowest_ms undefined` -- text that is not valid
       exposition and would break a scrape silently. Today's only producer
       already normalises with `?? null`, but this must be safe by
       construction, not merely safe by whoever calls it being careful. */
    if (Number.isFinite(ingestTiming.slowestParseMs)) {
      series(out, "gcio_ingest_parse_slowest_ms", "Slowest recorded workbook parse in the last 7 days.", "gauge",
        [line("gcio_ingest_parse_slowest_ms", ingestTiming.slowestParseMs)]);
    }
    if (Number.isFinite(ingestTiming.slowestPersistMs)) {
      series(out, "gcio_ingest_persist_slowest_ms", "Slowest recorded persist in the last 7 days.", "gauge",
        [line("gcio_ingest_persist_slowest_ms", ingestTiming.slowestPersistMs)]);
    }
  }

  return `${out.join("\n")}\n`;
}
