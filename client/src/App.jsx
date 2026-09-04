import { useCallback, useEffect, useMemo, useState } from "react";
import { getJSON, deleteJSON, useLiveEvents, NotAuthenticated } from "./lib/api.js";
import { scrollToSection } from "./lib/motion.jsx";
import { fmtDate } from "./lib/format.js";
import TopBar from "./components/TopBar.jsx";
import AdminConsole from "./components/AdminConsole.jsx";
import KpiStrip from "./components/KpiStrip.jsx";
import SectionNav from "./components/SectionNav.jsx";
import SectionSuccesses from "./components/SectionSuccesses.jsx";
import SectionQRI from "./components/SectionQRI.jsx";
import SectionPriorities from "./components/SectionPriorities.jsx";
import SectionRoadmap from "./components/SectionRoadmap.jsx";
import SectionPosture from "./components/SectionPosture.jsx";
import DocumentsSection from "./components/DocumentsSection.jsx";
import ProjectTable from "./components/ProjectTable.jsx";
import ProjectDrawer from "./components/ProjectDrawer.jsx";
import UploadPanel from "./components/UploadPanel.jsx";
import EmptyState from "./components/EmptyState.jsx";
import SignIn from "./components/SignIn.jsx";

const THEMES = ["obsidian", "platinum", "sapphire", "emerald"];
const FONTS = ["arial", "aptos"];
const todayISO = () => new Date().toISOString().slice(0, 10);

/* URL controls, so a view can be linked, printed or captured exactly:
     ?snapshot=1        settled, non-live render (no event stream)
     ?theme=sapphire    open in a specific identity
     ?font=aptos        open in a specific typeface
     ?project=P-1042    open straight into a project's record
     ?table=1           expand the all-projects reference table
     ?scrollTo=posture  open scrolled to one section, for capture and print  */
const params = () =>
  new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
const snapshotMode = () => params().has("snapshot");
const paramIn = (key, allowed) => {
  const value = (params().get(key) || "").toLowerCase();
  return allowed.includes(value) ? value : null;
};

const PERIOD_TITLE = {
  daily: "Daily Executive Summary",
  weekly: "Weekly Executive Summary",
  monthly: "Monthly Executive Summary",
  yearly: "Annual Executive Summary",
};

export default function App() {
  const [period, setPeriod] = useState("weekly");
  const [date, setDate] = useState(todayISO());
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("gcio-theme");
    return paramIn("theme", THEMES) || (THEMES.includes(saved) ? saved : "obsidian");
  });
  const [font, setFont] = useState(() => {
    const saved = localStorage.getItem("gcio-font");
    return paramIn("font", FONTS) || (FONTS.includes(saved) ? saved : "arial");
  });
  const [summary, setSummary] = useState(null);
  const [health, setHealth] = useState(null);
  const [meta, setMeta] = useState(null);
  const [drawerId, setDrawerId] = useState(() => params().get("project"));
  const [uploadOpen, setUploadOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [error, setError] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  /** null = still asking the server who we are. */
  const [me, setMe] = useState(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gcio-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("data-font", font);
    localStorage.setItem("gcio-font", font);
  }, [font]);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  /* Purging an imported document. Gated the same way every other write in
     this client is: the server's requireRole("pm") admits pm and admin (see
     auth/authz.js PRECEDENCE), and TopBar already hides the Upload button on
     exactly that test. Failures are thrown on to DocumentsSection, which
     reports them against the document that failed — the page-level banner
     says "retrying on next refresh", which is not true of a delete. */
  const removeDocument = useCallback(async (documentId) => {
    await deleteJSON(`/api/documents/${encodeURIComponent(documentId)}`);
    refresh();
  }, [refresh]);
  const canPurge = me?.role === "pm" || me?.role === "admin";

  useEffect(() => {
    getJSON("/api/me")
      .then(setMe)
      .catch(() => setMe({ authenticated: false }));
  }, []);

  useEffect(() => {
    if (!me?.authenticated) return undefined;
    let cancelled = false;
    Promise.all([
      getJSON(`/api/summary?period=${period}&date=${date}`),
      getJSON("/api/health"),
      getJSON("/api/meta"),
    ])
      .then(([s, h, m]) => {
        if (cancelled) return;
        setSummary(s);
        setHealth(h);
        setMeta(m);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof NotAuthenticated) {
          setMe({ authenticated: false });
          return;
        }
        setError(err.message);
        console.error("summary fetch failed:", err);
      });
    return () => { cancelled = true; };
  }, [period, date, refreshTick, me]);

  useLiveEvents(() => refresh(), !snapshotMode() && Boolean(me?.authenticated));

  /* Land on a named section when asked — used for section-level captures. */
  useEffect(() => {
    const target = params().get("scrollTo");
    if (!target || !summary) return undefined;
    const timer = setTimeout(() => scrollToSection(target), 120);
    return () => clearTimeout(timer);
  }, [summary]);

  const hasData = (health?.projectCount ?? 0) > 0;
  const rangeLabel = useMemo(() => {
    if (!summary) return "";
    return summary.rangeStart === summary.rangeEnd
      ? fmtDate(summary.rangeStart)
      : `${fmtDate(summary.rangeStart)} — ${fmtDate(summary.rangeEnd)}`;
  }, [summary]);

  const sections = summary?.sections;

  if (me === null) {
    return <div className="shell"><main><div className="skeleton" style={{ height: 120, marginTop: 40 }} /></main></div>;
  }

  if (!me.authenticated) {
    return (
      <SignIn
        devMode={me.devMode}
        sso={me.sso}
        entra={me.entra}
        onSignedIn={(signedIn) => setMe({ authenticated: true, ...signedIn })}
      />
    );
  }

  return (
    <div className="shell">
      <TopBar
        period={period}
        onPeriod={setPeriod}
        date={date}
        onDate={setDate}
        theme={theme}
        onTheme={setTheme}
        font={font}
        onFont={setFont}
        health={health}
        me={me}
        onUpload={() => setUploadOpen(true)}
        onAdmin={() => setAdminOpen(true)}
        onSignOut={async () => {
          await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
          setMe({ authenticated: false });
        }}
      />

      {/* A sibling of the header, never a parent. <header> maps to the banner
          role only while it is NOT inside <main>, so wrapping the whole shell
          would have fixed landmark-one-main by destroying a landmark the app
          already had. The drawer and the upload panel stay outside: they are
          fixed-position modals carrying their own role="dialog", not the page's
          main content. */}
      <main>
        {error && (
          <div className="card panel error-panel">
            <span className="micro critical-ink">Connection issue</span>
            <div className="meta">{error} — retrying on next refresh.</div>
          </div>
        )}

        {!hasData && health && <EmptyState onUpload={() => setUploadOpen(true)} />}

        {hasData && summary && sections && (
          <>
            <div className="page-head">
              <h1 className="page-title display">{PERIOD_TITLE[period]}</h1>
              <span className="page-range">
                {rangeLabel}{health?.demoMode ? "  ·  demonstration portfolio" : ""}
              </span>
            </div>

            {!sections.historyAvailable && (
              <p className="empty-line no-history">
                {summary.historyStartedAt
                  ? `No change history before ${fmtDate(summary.historyStartedAt)}.`
                  : "No change history yet — it begins with the next upload."}
              </p>
            )}

            <KpiStrip
              kpis={summary.kpis}
              questionCount={sections.qri.counts.questions}
              lastIngestAt={health?.lastIngestAt}
            />

            <SectionNav />

            <SectionSuccesses data={sections.successes} charts={summary.charts} theme={theme} onOpen={setDrawerId} />
            <SectionQRI data={sections.qri} charts={summary.charts} theme={theme} onOpen={setDrawerId} />
            <SectionPriorities data={sections.priorities} onOpen={setDrawerId} />
            <SectionRoadmap data={sections.roadmap} theme={theme} onOpen={setDrawerId} />
            <SectionPosture data={sections.posture} onOpen={setDrawerId} />
            <DocumentsSection data={sections.documents} canRemove={canPurge} onRemove={removeDocument} />

            <details className="all-projects" open={params().has("table")}>
              <summary>All projects — reference table ({health.projectCount})</summary>
              <ProjectTable meta={meta} onOpen={setDrawerId} refreshTick={refreshTick} />
            </details>
          </>
        )}

        {!summary && !error && (
          <div className="skeleton-stack">
            <div className="skeleton" style={{ height: 96 }} />
            <div className="skeleton" style={{ height: 320 }} />
            <div className="skeleton" style={{ height: 280 }} />
          </div>
        )}
      </main>

      {drawerId && (
        <ProjectDrawer id={drawerId} onClose={() => setDrawerId(null)} onNavigate={setDrawerId} period={period} date={date} />
      )}

      {uploadOpen && <UploadPanel onClose={() => setUploadOpen(false)} onDone={refresh} />}
      {/* A sibling of <main>, like the drawer and the upload panel: a fixed
          modal carrying its own role="dialog", not page content. */}
      {adminOpen && <AdminConsole me={me} onClose={() => setAdminOpen(false)} />}
    </div>
  );
}
