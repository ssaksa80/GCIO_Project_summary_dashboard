/*
 * One fetch wrapper for every admin screen.
 *
 * The error path matters more than the happy one here. These screens act on
 * access control, and a failed grant that renders as nothing is worse than one
 * that renders as an error: the admin believes the change landed. So a
 * non-2xx always throws, carrying the server's own message and code, and every
 * caller surfaces it.
 */
export async function api(url, options) {
  const res = await fetch(url, {
    ...options,
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error?.message || `request failed (${res.status})`);
    err.code = body?.error?.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

export const get = (url) => api(url);
export const post = (url, body) => api(url, { method: "POST", body: JSON.stringify(body) });
export const del = (url) => api(url, { method: "DELETE" });

/** A timestamp an operator can read at a glance, in their own timezone. */
export function when(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

/** "3 minutes ago" — the form that answers "is this session still live?". */
export function since(value) {
  if (!value) return "";
  const ms = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
