import { formatBusinessDate, parseBusinessDate } from "@/lib/businessDate";

/** Shared by CashFlowPage and ReportsPage — both offer the same four
 * period presets over their respective date-ranged endpoints. */
export type RangePreset = "all" | "this_year" | "5y" | "custom";

/** Every mode but "Всё время"/"all" needs the server's business date (see
 * docs/tasks/business-date-timezone.md) for a correct bound — "this_year"/
 * "5y" to compute their own bound at all, "custom" to seed a sane starting
 * year the first time its picker opens. Shared by CashFlowPage/ReportsPage
 * to disable exactly these three options (via PillSelector's own
 * `disabledValues`) until it's actually safe to switch to one. */
export const DATE_DEPENDENT_RANGE_PRESETS: readonly RangePreset[] = ["this_year", "5y", "custom"];

export interface CustomYearRange {
  fromYear: number;
  toYear: number;
}

/** `computeRange`'s result — a discriminated union rather than a plain
 * `{ startDate?, endDate? }`, specifically so "no bound yet because the
 * business date (see docs/tasks/business-date-timezone.md) hasn't loaded"
 * can never be confused with "no bound because the user picked 'Всё
 * время'" — the two used to collapse onto the exact same `{}` shape,
 * which silently showed unbounded "all" data mislabeled under whichever
 * date-relative preset ("Этот год"/"5 лет") was actually selected. Callers
 * must branch on `status` before reading `startDate`/`endDate` at all. */
export type ComputedRange =
  | { status: "ready"; startDate?: string; endDate?: string }
  | { status: "pending" };

/** `businessDate` is the server's own current day (see
 * docs/tasks/business-date-timezone.md, useBusinessDate()) — `endDate`
 * below is sent straight through to GET /reports and /cash-flow as an
 * inclusive upper bound (see routes/reports.py, routes/cash_flow.py),
 * which apply it exactly as given rather than re-deriving their own
 * "today". A browser-computed `new Date()` here (the previous
 * implementation) could therefore silently exclude the business-today's
 * own transactions from "This year"/"Last 5 years" whenever the browser's
 * timezone reads a day behind Europe/Warsaw.
 *
 * "all" never needs `businessDate` and is always immediately `"ready"`
 * (with no bound at all — that's the whole point of "Всё время"). "custom"
 * likewise only ever needs the caller-supplied `custom` years, never
 * `businessDate` — but see CustomYearRange's own callers for where *that*
 * pair's own one-time default comes from. "this_year"/"5y" are `"pending"`
 * for as long as `businessDate` is `undefined` (useBusinessDate() never
 * fabricates one) — callers must not run their query at all while pending
 * (see the `enabled` option on useCashFlow/useCategoryRanking below), and
 * should show an explicit loading/error state instead of silently
 * rendering unbounded data under a "this year"/"5 years" label. */
export function computeRange(
  preset: RangePreset,
  businessDate: string | undefined,
  custom?: CustomYearRange
): ComputedRange {
  switch (preset) {
    case "all":
      return { status: "ready" };
    case "this_year": {
      if (!businessDate) return { status: "pending" };
      const { year } = parseBusinessDate(businessDate);
      return { status: "ready", startDate: `${year}-01-01`, endDate: businessDate };
    }
    case "5y": {
      if (!businessDate) return { status: "pending" };
      const today = parseBusinessDate(businessDate);
      return {
        status: "ready",
        startDate: formatBusinessDate({ year: today.year - 5, month: today.month, day: 1 }),
        endDate: businessDate,
      };
    }
    case "custom": {
      if (!custom) return { status: "ready" };
      return { status: "ready", startDate: `${custom.fromYear}-01-01`, endDate: `${custom.toYear}-12-31` };
    }
  }
}

/** Builds a "/reports?..." link that survives a reload — see
 * ReportsPage.tsx's own `useSearchParams()` read on mount, and
 * CashFlowPage.tsx's category lists (the one place that links out today). */
export function reportsLinkFor(categoryId: number, range: RangePreset, custom: CustomYearRange): string {
  // A ranking row's own id is always a top-level category (see
  // category_rollup.py), and its amount already rolls up direct
  // subcategories — so the transactions table it links to must match the
  // same set, not just the exact id, or subcategory-only rows disappear.
  const params = new URLSearchParams({ category_id: String(categoryId), range, include_subcategories: "1" });
  if (range === "custom") {
    params.set("from_year", String(custom.fromYear));
    params.set("to_year", String(custom.toYear));
  }
  return `/reports?${params.toString()}`;
}

/** The inverse of reportsLinkFor's range params — parses a `range` query
 * param, falling back to `fallback` for anything missing or invalid (e.g.
 * a hand-edited URL), same defensive shape as TransactionsPage.tsx's own
 * parseYearParam/parseMonthParam. */
export function parseRangeParam(value: string | null, fallback: RangePreset): RangePreset {
  return value === "all" || value === "this_year" || value === "5y" || value === "custom" ? value : fallback;
}

export function parseYearRangeParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
