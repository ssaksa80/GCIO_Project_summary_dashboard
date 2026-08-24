/** Client-side display formatters (mirrors server/format.js rules, SPEC §5). */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Compact AED money: 1.24B / 386M / 250K / 940. */
export function fmtMoney(value, currency = "AED") {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  let text;
  if (abs >= 1e9) text = `${(n / 1e9).toFixed(2).replace(/\.?0+$/, "")}B`;
  else if (abs >= 1e6) text = `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  else if (abs >= 1e3) text = `${Math.round(n / 1e3)}K`;
  else text = String(Math.round(n));
  return `${currency} ${text}`;
}

/** "2026-03-12" -> "12 Mar 2026". Falsy -> em dash. */
export function fmtDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "—";
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function fmtPct(value, decimals = 0) {
  const n = Number(value) || 0;
  return `${n.toFixed(decimals)}%`;
}

export function fmtInt(value) {
  return new Intl.NumberFormat("en-AE").format(Math.round(Number(value) || 0));
}

/** Relative "time ago" for the LIVE indicator. */
export function timeAgo(iso) {
  if (!iso) return "—";
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export const HEALTH_CHIP = { Green: "good", Amber: "warn", Red: "critical" };
export const SEVERITY_CHIP = { critical: "critical", serious: "serious", warning: "warn" };
