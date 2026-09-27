/** Pure helpers around the server's business-date string (see
 * docs/tasks/business-date-timezone.md and hooks/useBusinessDate.ts) —
 * `YYYY-MM-DD` in the server's business timezone (Europe/Warsaw by
 * default), never the browser's own `Date()`/`toISOString()`.
 *
 * Every function here reads the three numeric components directly out of
 * the string instead of going through `new Date(iso)` — that constructor
 * parses a bare `YYYY-MM-DD` as UTC midnight, and then `.getFullYear()`/
 * `.getMonth()`/`.getDate()` re-interpret that instant in the *browser's*
 * own local timezone. A browser west of UTC (e.g. US/Canada) would read
 * UTC midnight back as the previous calendar day — silently shifting the
 * exact business date this module exists to protect. Parsing the string
 * directly makes every one of these calendar-only comparisons immune to
 * whatever timezone the browser happens to be in.
 */

export interface BusinessDateParts {
  year: number;
  /** 1–12, not the 0–11 `Date#getMonth()` convention. */
  month: number;
  day: number;
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseBusinessDate(iso: string): BusinessDateParts {
  const match = ISO_DATE_RE.exec(iso);
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${iso}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function businessDateYear(iso: string): number {
  return parseBusinessDate(iso).year;
}

export function businessDateMonth(iso: string): number {
  return parseBusinessDate(iso).month;
}

/** `iso` formatted back exactly as `YYYY-MM-DD` — used where a computed
 * date (e.g. "N years before today") needs to round-trip through the same
 * string shape the API expects, again without ever routing through a
 * browser-local `Date`. */
export function formatBusinessDate(parts: BusinessDateParts): string {
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}
