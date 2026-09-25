/** Dashboard's own period model — month-granular, unlike CashFlow/Reports'
 * whole-year RangePreset in dateRange.ts. `year: null` means "all time";
 * `month: null` means "every month of `year`" (only meaningful once `year`
 * isn't null). Shared by DashboardPage, RecentTransactionsCard (the "all
 * transactions" link) and TransactionsPage (the link's own landing page),
 * so the link-building and link-parsing halves can never drift apart. */
export interface DashboardPeriod {
  year: number | null;
  month: number | null;
}

/** How many months of `year` should ever be offered/counted — every past
 * year has all 12; the current year stops at the current month, so a
 * future month is never offered by the picker nor silently averaged in as
 * a zero. */
export function visibleMonthCount(year: number): number {
  const now = new Date();
  return year === now.getFullYear() ? now.getMonth() + 1 : 12;
}

/** Builds a "/transactions?..." link carrying the exact same period a
 * Dashboard view is showing, in a shape TransactionsPage's own
 * parseDashboardPeriodParams below understands. A specific month keeps
 * today's plain `year=&month=` shape byte-for-byte (see
 * dashboard-to-transactions-deeplink.spec.ts) — only the two new modes
 * (all time, whole year) need the extra `period`/omitted-month signal. */
export function dashboardLinkFor(period: DashboardPeriod): string {
  if (period.year === null) return "/transactions?period=all";
  if (period.month === null) return `/transactions?year=${period.year}`;
  return `/transactions?year=${period.year}&month=${period.month}`;
}

/** The inverse of dashboardLinkFor — but also has to keep resolving a bare
 * `/transactions` (no params at all, e.g. from the nav sidebar) to
 * `fallback`, exactly as it always has, since that shape predates this
 * period model and isn't produced by dashboardLinkFor above (an all-time
 * link is always explicit `period=all`, never just an empty query string). */
export function parseDashboardPeriodParams(
  searchParams: URLSearchParams,
  fallback: { year: number; month: number }
): DashboardPeriod {
  if (searchParams.get("period") === "all") return { year: null, month: null };
  const yearParam = searchParams.get("year");
  if (yearParam === null) return fallback;
  const parsedYear = Number(yearParam);
  const year = Number.isInteger(parsedYear) && parsedYear > 0 ? parsedYear : fallback.year;
  const monthParam = searchParams.get("month");
  if (monthParam === null || monthParam === "all") return { year, month: null };
  const parsedMonth = Number(monthParam);
  const month = Number.isInteger(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12 ? parsedMonth : null;
  return { year, month };
}
