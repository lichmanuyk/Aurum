/** Shared by CashFlowPage and ReportsPage — both offer the same four
 * period presets over their respective date-ranged endpoints. */
export type RangePreset = "all" | "this_year" | "5y" | "custom";

export interface CustomYearRange {
  fromYear: number;
  toYear: number;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function computeRange(
  preset: RangePreset,
  custom?: CustomYearRange
): { startDate?: string; endDate?: string } {
  const today = new Date();
  switch (preset) {
    case "all":
      return {};
    case "this_year":
      return { startDate: `${today.getFullYear()}-01-01`, endDate: isoDate(today) };
    case "5y": {
      const start = new Date(today.getFullYear() - 5, today.getMonth(), 1);
      return { startDate: isoDate(start), endDate: isoDate(today) };
    }
    case "custom": {
      if (!custom) return {};
      return { startDate: `${custom.fromYear}-01-01`, endDate: `${custom.toYear}-12-31` };
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
