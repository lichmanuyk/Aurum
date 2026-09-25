import { getMonthLabels } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

interface MonthSelectorProps {
  month: number | null; // 1-12, or null for "every month" (see lib/dashboardPeriod.ts)
  onChange: (month: number | null) => void;
  // Only the first `maxMonth` month pills render at all — the current
  // year stops at the current month (see lib/dashboardPeriod.ts's
  // visibleMonthCount), so a future month is never offered, not just
  // disabled. Defaults to all 12, e.g. for a past year.
  maxMonth?: number;
  // Budgets are always exactly one month — no "every month" concept there
  // — so the pill (and ever calling onChange with null) is opt-in, not
  // the default, for every other existing caller of this shared component.
  allowAll?: boolean;
}

export function MonthSelector({ month, onChange, maxMonth = 12, allowAll = false }: MonthSelectorProps) {
  const { t, language } = useTranslation();
  const monthLabels = getMonthLabels(language).slice(0, maxMonth);

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {allowAll && (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={month === null}
          className={cn(
            "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
            month === null
              ? "border-series-6 bg-series-6 text-white"
              : "border-border bg-surface-1 text-text-secondary hover:bg-surface-2"
          )}
        >
          {t("dashboard.allMonths")}
        </button>
      )}
      {monthLabels.map((label, index) => {
        const value = index + 1;
        const active = value === month;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onChange(value)}
            aria-pressed={active}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
              active
                ? "border-series-6 bg-series-6 text-white"
                : "border-border bg-surface-1 text-text-secondary hover:bg-surface-2"
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
