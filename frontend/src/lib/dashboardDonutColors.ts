/** Solid, distinguishable sector colors for the dashboard's spending donut
 * (see docs/tasks/dashboard-donut-colors-routing.md) — a later preference
 * replacing the hatched-pattern approach from PR #42 (see the removed
 * colorPatterns.ts): every category keeps its own real, user-chosen color
 * (the same one shown on Categories/Transactions) unless it collides with
 * another category currently on this donut, in which case the colliding
 * category borrows a slot from the app's own categorical ramp — the same
 * 8-slot, adjacent-pair-safe order used by CryptoAllocationBody and
 * net_worth_service.py's _CLASS_META (dataviz skill: blue, orange, aqua,
 * yellow, magenta, green, violet, red; see index.css --series-1..8). Not a
 * shared import from either — both keep their own local copy/behavior
 * untouched (crypto's own 7-slot ramp assigns *every* coin by rank; this
 * only ever touches colliding categories, and dashboard_service.py caps at
 * MAX_CHART_SLICES=8 real categories, one more slot than crypto ever
 * needs, hence the 8th slot here). */
interface RampSlot {
  cssVar: string;
  // Both themes' own hex value (index.css) for this slot — a real category
  // color is free-form hex, and the ramp's own values are validated,
  // memorable ones a user might well pick by hand too (indeed several of
  // this very codebase's own test fixtures do, by coincidence). Comparing
  // a candidate slot against these, not just against other already-
  // assigned var() strings, is what stops a reassigned category from
  // landing right back on a color some other real category already has —
  // in whichever theme, since this runs once for both.
  hexLight: string;
  hexDark: string;
}

const RAMP: readonly RampSlot[] = [
  { cssVar: "var(--series-1)", hexLight: "#2a78d6", hexDark: "#3987e5" },
  { cssVar: "var(--series-2)", hexLight: "#eb6834", hexDark: "#d95926" },
  { cssVar: "var(--series-3)", hexLight: "#1baf7a", hexDark: "#199e70" },
  { cssVar: "var(--series-4)", hexLight: "#eda100", hexDark: "#c98500" },
  { cssVar: "var(--series-5)", hexLight: "#e87ba4", hexDark: "#d55181" },
  { cssVar: "var(--series-6)", hexLight: "#008300", hexDark: "#008300" },
  { cssVar: "var(--series-7)", hexLight: "#4a3aa7", hexDark: "#9085e9" },
  { cssVar: "var(--series-8)", hexLight: "#e34948", hexDark: "#e34948" },
];

export interface DonutColorItem {
  key: string;
  color: string;
}

/** Category rows come back in whatever order the current sort produced (by
 * amount, which reshuffles with the period/currency) — collision
 * resolution has to be independent of that, or the same two categories
 * could swap which one "wins" its real color on every refresh. "other"
 * (the synthetic rollup, key === "other") sorts last: it already has its
 * own reserved, deliberately-muted color and should be the first to give
 * it up if it ever collides with a real category's chosen color. */
function stableSortKey(key: string): number {
  return key === "other" ? Number.POSITIVE_INFINITY : Number(key);
}

/** Assigns each item a fill color: unchanged if it's the first (by stable
 * order) claim on its real color, or the next categorical-ramp slot whose
 * value (in *either* theme) nothing else on this same donut is already
 * showing, if it's a later claim. Deterministic for a given set of (key,
 * color) pairs regardless of array order, so re-sorting by amount or
 * switching currency never changes anyone's color. Never writes anything
 * back to the category itself — purely a display-time lookup. Exported
 * for direct unit testing. */
export function resolveDonutColors(items: readonly DonutColorItem[]): Map<string, string> {
  const byStableOrder = [...items].sort((a, b) => stableSortKey(a.key) - stableSortKey(b.key));

  const resolved = new Map<string, string>();
  const winnerClaimed = new Set<string>();
  const hexInUse = new Set<string>();
  for (const item of byStableOrder) {
    const hex = item.color.toLowerCase();
    if (!winnerClaimed.has(hex)) {
      winnerClaimed.add(hex);
      resolved.set(item.key, item.color);
      hexInUse.add(hex);
    }
  }

  for (const item of byStableOrder) {
    if (resolved.has(item.key)) continue;
    const slot =
      RAMP.find((candidate) => !hexInUse.has(candidate.hexLight) && !hexInUse.has(candidate.hexDark)) ??
      RAMP[resolved.size % RAMP.length];
    resolved.set(item.key, slot.cssVar);
    hexInUse.add(slot.hexLight);
    hexInUse.add(slot.hexDark);
  }

  return resolved;
}
