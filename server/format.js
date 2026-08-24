/**
 * Shared server-side formatters for the GCIO Project Intelligence platform.
 * Tiny, dependency-free except dayjs. Used by summarize.js and the exporters.
 */
import dayjs from "dayjs";

/**
 * Format a monetary amount in compact executive style.
 * >= 1e9 -> "AED 1.24B", >= 1e6 -> "AED 386M" (1dp, trailing .0 trimmed),
 * >= 1e3 -> "AED 250K", else integer ("AED 740").
 * @param {number|string} value - Amount in whole currency units.
 * @param {string} [currency="AED"] - ISO-ish currency prefix.
 * @returns {string} Formatted money string.
 */
export function fmtMoney(value, currency = "AED") {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${currency} 0`;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const trim = (s) => s.replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  if (abs >= 1e9) return `${sign}${currency} ${trim((abs / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${sign}${currency} ${trim((abs / 1e6).toFixed(1))}M`;
  if (abs >= 1e3) return `${sign}${currency} ${Math.round(abs / 1e3)}K`;
  return `${sign}${currency} ${Math.round(abs)}`;
}

/**
 * Format an ISO date (yyyy-mm-dd) as an executive-readable date, e.g. "12 Mar 2026".
 * @param {string|Date|null|undefined} iso - ISO date string or Date.
 * @returns {string} Formatted date, or "" when the input is empty/invalid.
 */
export function fmtDate(iso) {
  if (iso === null || iso === undefined || iso === "") return "";
  const d = dayjs(iso);
  return d.isValid() ? d.format("D MMM YYYY") : "";
}

/**
 * Format a percentage number with a fixed number of decimals and a "%" suffix.
 * @param {number|string} value - Percentage value (already 0..100 scale).
 * @param {number} [decimals=1] - Decimal places.
 * @returns {string} e.g. "61.3%".
 */
export function fmtPct(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0%";
  const s = n.toFixed(decimals).replace(/\.0+$/, "");
  return `${s}%`;
}

/**
 * Round a number to one decimal place (used for KPI math per the spec).
 * @param {number} value - Any finite number.
 * @returns {number} Value rounded to 1 decimal place; 0 for non-finite input.
 */
export function round1(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10) / 10;
}
