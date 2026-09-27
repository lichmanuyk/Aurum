import { useSectionFormat } from "@/lib/displayCurrency";
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { getCategoryIcon } from "@/lib/icons";
import { useChartSelection } from "@/lib/chartSelection";
import { cn } from "@/lib/utils";

import { useTranslation, type TranslationKey } from "@/lib/i18n";
import type { NetWorthBreakdownItem } from "@/types";

interface AssetAllocationCardProps {
  breakdown: NetWorthBreakdownItem[];
  isLoading: boolean;
  // Today's total across every owed_by_me Debt (see
  // docs/tasks/debt-tracking.md and NetWorthSummary.total_liabilities) —
  // deliberately never one of the `breakdown` slices above (see
  // net_worth_service.get_net_worth_summary's own comment on why a negative
  // donut slice would misrepresent money owed): rendered as its own
  // clearly-negative callout instead, directly under the positive
  // breakdown it's already subtracted out of.
  totalLiabilities?: string;
}

// Breakdown items come from the backend with a machine-readable `key`
// ("cash" or an AssetClass value) — translate the label locally instead of
// showing the backend's (Russian-only) pre-rendered `name`.
function breakdownLabelKey(key: string): TranslationKey {
  return `netWorth.assetClass.${key}` as TranslationKey;
}

export function AssetAllocationCard({ breakdown, isLoading, totalLiabilities }: AssetAllocationCardProps) {
  const { formatCurrency } = useSectionFormat();
  const liabilities = Number(totalLiabilities ?? 0);
  const { t } = useTranslation();
  const total = breakdown.reduce((sum, item) => sum + Number(item.amount), 0);

  // A copy, sorted descending by value — the bar's segments, the legend and
  // the detail rows below all read from this same array, so all three agree
  // on one order (see docs/tasks/capital-allocation-interaction.md). Totals,
  // shares, classes and colors are untouched; only display order changes,
  // and only here — the backend's own breakdown order (cash, then a fixed
  // AssetClass sequence chosen for adjacent-color safety) is never mutated.
  const sorted = useMemo(() => [...breakdown].sort((a, b) => Number(b.amount) - Number(a.amount)), [breakdown]);

  // Same hover/pin mechanism as the donut+list pairs (PR #42) — a
  // segmented bar has no donut sectors to connect a line to, so only
  // useChartSelection is reused here, not sectorConnector.
  const validIds = useMemo(() => new Set(sorted.map((item) => item.key)), [sorted]);
  const selection = useChartSelection<string>(validIds);
  const { activeId, pinnedId } = selection;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t("netWorth.assetsTitlePrefix")} · {formatCurrency(total)}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-10 text-center text-sm text-text-muted">{t("common.loading")}</p>
        ) : (
          <>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
              {sorted.map((item) => {
                if (item.percent <= 0) return null;
                const isActive = activeId === item.key;
                const dimmed = activeId !== null && !isActive;
                return (
                  <div
                    key={item.key}
                    style={{ width: `${item.percent}%`, backgroundColor: item.color, opacity: dimmed ? 0.35 : 1 }}
                    className={cn(
                      "h-full first:rounded-l-full last:rounded-r-full transition-opacity",
                      isActive && "relative z-10 ring-2 ring-inset ring-text-primary"
                    )}
                    tabIndex={0}
                    role="button"
                    aria-label={`${t(breakdownLabelKey(item.key))}, ${formatCurrency(item.amount)}, ${item.percent.toFixed(0)}%`}
                    aria-pressed={pinnedId === item.key}
                    onMouseEnter={() => selection.enter(item.key)}
                    onMouseLeave={selection.leave}
                    onFocus={() => selection.enter(item.key)}
                    onBlur={selection.leave}
                    onClick={() => selection.togglePin(item.key)}
                    onKeyDown={(event) => selection.onKeyDown(event, item.key)}
                  />
                );
              })}
            </div>

            <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-text-secondary">
              {sorted.map((item) => (
                <li key={item.key} className="flex items-center gap-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                  {t(breakdownLabelKey(item.key))} {item.percent.toFixed(0)}%
                </li>
              ))}
            </ul>

            <ul className="mt-4 divide-y divide-gridline border-t border-gridline">
              {sorted.map((item) => {
                const Icon = getCategoryIcon(item.icon);
                const isActive = activeId === item.key;
                const dimmed = activeId !== null && !isActive;
                return (
                  <li key={item.key} className="first:pt-1">
                    <button
                      type="button"
                      aria-pressed={pinnedId === item.key}
                      onMouseEnter={() => selection.enter(item.key)}
                      onMouseLeave={selection.leave}
                      onFocus={() => selection.enter(item.key)}
                      onBlur={selection.leave}
                      onClick={() => selection.togglePin(item.key)}
                      onKeyDown={(event) => selection.onKeyDown(event, item.key)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md py-2 text-left transition-opacity",
                        dimmed && "opacity-40",
                        isActive && "bg-surface-2"
                      )}
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                        style={{ backgroundColor: `${item.color}26` }}
                      >
                        <Icon size={15} style={{ color: item.color }} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                        {t(breakdownLabelKey(item.key))}
                      </span>
                      <span className="hidden w-24 shrink-0 items-center gap-2 sm:flex">
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <span
                            className="block h-full rounded-full"
                            style={{ width: `${item.percent}%`, backgroundColor: item.color }}
                          />
                        </span>
                        <span className="w-9 shrink-0 text-right text-xs text-text-muted tabular-nums">
                          {item.percent.toFixed(0)}%
                        </span>
                      </span>
                      <span className="w-14 shrink-0 text-right text-xs text-text-muted tabular-nums sm:hidden">
                        {item.percent.toFixed(0)}%
                      </span>
                      <span className="shrink-0 text-sm font-medium tabular-nums text-text-primary">
                        {formatCurrency(item.amount)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {liabilities > 0 && (
              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
                <span className="text-xs font-medium text-danger">
                  {t("netWorth.liabilitiesCallout")}
                  <span className="ml-1 block font-normal text-text-muted sm:inline">{t("netWorth.liabilitiesCalloutHint")}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-danger">-{formatCurrency(liabilities)}</span>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
