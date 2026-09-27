import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSettings } from "@/api/settings";

/** How often an already-open tab re-checks the server's business date on
 * its own, without the user touching anything — the backstop for a tab
 * that's never blurred/refocused across a midnight rollover. Short enough
 * that the date turns over within a minute of actually changing in
 * Europe/Warsaw, long enough not to spam GET /api/settings. Coming back to
 * an already-open tab (visibility/focus) is covered immediately by
 * react-query's own `refetchOnWindowFocus`, set explicitly below rather
 * than relied on as an ambient default. */
const BUSINESS_DATE_REFRESH_MS = 60_000;

export interface BusinessDateState {
  /** `undefined` until the first successful read — deliberately never a
   * client-guessed fallback (e.g. the browser's own date). Any caller that
   * needs "today" as a default must treat `undefined` as "not ready yet",
   * never silently substitute its own idea of today. */
  businessDate: string | undefined;
  businessTimezone: string | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/** The server's current business day (see
 * docs/tasks/business-date-timezone.md) — reuses the same GET /api/settings
 * response useAppSettings() (hooks/useSettings.ts) already reads (same
 * react-query cache key, so this never duplicates the request), but adds
 * its own polling/refocus behavior on top since *this* hook's whole job is
 * noticing the day change, not just settings values the user explicitly
 * edits. */
export function useBusinessDate(): BusinessDateState {
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: fetchSettings,
    refetchInterval: BUSINESS_DATE_REFRESH_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  // react-query's own reducer leaves a query's last *successful* `data`
  // sitting in the cache even after a later background refetch actually
  // fails — `status` flips to 'error' without ever clearing `data` (see
  // query-core's Query#dispatch, `case 'error'`). Surfacing that stale
  // value here as if it were still a confirmed "today" would be exactly
  // the silent client-side fallback this hook exists to prevent: a form's
  // fill-once effect only checks "is businessDate truthy", so a stale
  // yesterday would get typed into a brand-new entry while the error
  // banner never shows (its own guard is "is the date field still blank",
  // which the stale fill already satisfied). Gating both fields on
  // `query.isError` costs nothing during an *ordinary* in-flight refetch
  // that follows a successful previous fetch — `isError` is false then
  // (query-core only flips it on an actual failed attempt), so the last
  // known value keeps showing exactly as before.
  return {
    businessDate: query.isError ? undefined : query.data?.business_date,
    businessTimezone: query.isError ? undefined : query.data?.business_timezone,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}

/** Query key prefixes whose *cached* result can go stale purely because a
 * calendar day passed — not because any of their own explicit request
 * params changed. Each one computes some part of its answer from the
 * server's "today" (see docs/tasks/business-date-timezone.md) without
 * exposing that day in its own queryKey, so a query-key change never
 * naturally triggers their refetch the way e.g. a changed startDate/
 * endDate does for Reports/Cash Flow's own date-ranged queries (see
 * lib/dateRange.ts's ComputedRange) — those need no entry here, changing
 * their own key on the next render is already enough:
 *
 *  - "dashboard-summary" / "net-worth-summary": the *current* period's own
 *    upper bound (end_date, or the trend line's last point) is clamped to
 *    "today" even when year/month are already fixed, explicit numbers.
 *  - "assets": each asset's `capital_value`/`current_value` picks the
 *    latest valuation with `as_of_date <= today` and converts it as of
 *    "today" (see api/routes/assets.py's `_to_read`) — a future-dated
 *    valuation only becomes visible once "today" reaches it.
 *  - "crypto-holdings" / "crypto-history": both exclude/price trades
 *    against `tx.date > business_today()` and value the current position
 *    as of "today" (see services/crypto_service.py's `_to_read` /
 *    `get_crypto_history`) — same future-dated-entry problem as "assets".
 *  - "asset-expenses": reuses dashboard_service._resolve_bounds, whose
 *    `end` is clamped to "today" even for an already-fixed (year, month)
 *    once that month is the *current* one (see
 *    services/asset_expense_service.py) — so, unlike "budget-status"
 *    below, an explicit year/month here does NOT make it today-independent.
 *  - "recurring": is_due/next_due_date/days_until_due are computed against
 *    "today" directly, with no date param in the key at all.
 *  - "financial-alerts" / "advice": both default to *some* current-month
 *    window server-side, again with no date param exposed.
 *  - "fx-coverage" / "quote-status": "current vs previous" freshness and
 *    `as_of` are relative to "today", with no date param exposed.
 *  - "fx-rate-period-overview": the "latest vs average" mode resolution
 *    and its own end clamp depend on "today" even for an already-fixed
 *    (year, month).
 *  - "transaction-years": the offered range's upper bound is "today"'s
 *    year.
 *
 * Deliberately NOT here: "budget-status" (the frontend always sends an
 * explicit year/month — see pages/BudgetPage.tsx — and, unlike
 * asset-expenses above, budget_service.get_budget_status never clamps its
 * bounds to today, so a *given* month's own status never depends on today
 * once requested) and "cash-flow"/"category-ranking"/
 * "category-spending-report" (their startDate/endDate are computed from
 * the business date on every render via lib/dateRange.ts's computeRange,
 * so a day change already produces a different queryKey and therefore an
 * automatic refetch on its own). */
const DATE_SENSITIVE_QUERY_KEY_PREFIXES = [
  "dashboard-summary",
  "net-worth-summary",
  "assets",
  "crypto-holdings",
  "crypto-history",
  "asset-expenses",
  "recurring",
  "financial-alerts",
  "advice",
  "fx-coverage",
  "quote-status",
  "fx-rate-period-overview",
  "transaction-years",
] as const;

/** Mounted exactly once, at the app's root (see App.tsx) — invalidates the
 * list above the moment the server's business date actually changes:
 * never on a poll that finds the same day still current (the `businessDate
 * !== previous` check below), and never for the very first load (nothing
 * cached yet is "stale" — the `previous.current` check).
 *
 * `invalidateQueries` only marks matching cached entries stale and
 * reschedules a background refetch for whichever of them happen to be
 * mounted right now — it never touches component state, so an open form's
 * typed date, a hand-picked custom year range, or an in-progress period
 * selection all survive completely untouched by this. */
export function useInvalidateOnBusinessDateChange(): void {
  const { businessDate } = useBusinessDate();
  const queryClient = useQueryClient();
  const previous = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (businessDate && previous.current && businessDate !== previous.current) {
      for (const prefix of DATE_SENSITIVE_QUERY_KEY_PREFIXES) {
        queryClient.invalidateQueries({ queryKey: [prefix] });
      }
    }
    if (businessDate) previous.current = businessDate;
  }, [businessDate, queryClient]);
}
