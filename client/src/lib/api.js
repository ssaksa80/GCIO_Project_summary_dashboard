/** Fetch helpers, export download, and the SSE live-events hook (SPEC §8). */
import { useEffect, useRef } from "react";

export async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** POST an export request and trigger a browser download of the result. */
export async function downloadExport(format, body) {
  const res = await fetch(`/api/export/${format}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `export failed (${res.status})`);
  }
  const blob = await res.blob();
  const dispo = res.headers.get("content-disposition") || "";
  const match = /filename="?([^";]+)"?/.exec(dispo);
  const name = match ? match[1] : `GCIO_Portfolio_Brief.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Upload workbook File objects to the ingestion endpoint. */
export async function uploadWorkbooks(files) {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const res = await fetch("/api/ingest/upload", { method: "POST", body: form });
  const body = await res.json().catch(() => ({ ok: false, ingested: [], errors: [{ file: "upload", error: `${res.status}` }] }));
  return body;
}

/**
 * Subscribe to the server's SSE channel with automatic reconnect.
 * onIngest fires with {files, projectCount, at} whenever new data lands.
 * `enabled` is false for snapshot/print rendering, where an open stream would
 * keep the page from ever reaching a settled load state.
 */
export function useLiveEvents(onIngest, enabled = true) {
  const handler = useRef(onIngest);
  handler.current = onIngest;

  useEffect(() => {
    if (!enabled) return undefined;
    let source = null;
    let retryMs = 2000;
    let closed = false;
    let retryTimer = null;

    const connect = () => {
      if (closed) return;
      source = new EventSource("/api/events");
      source.addEventListener("ingest", (e) => {
        try {
          handler.current(JSON.parse(e.data));
        } catch {
          /* malformed event — ignore */
        }
      });
      source.onopen = () => {
        retryMs = 2000;
      };
      source.onerror = () => {
        source.close();
        if (!closed) {
          retryTimer = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 30000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (source) source.close();
    };
  }, [enabled]);
}
