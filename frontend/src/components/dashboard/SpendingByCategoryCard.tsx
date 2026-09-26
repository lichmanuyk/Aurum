import { useSectionFormat } from "@/lib/displayCurrency";
import { useMemo, useRef, useState } from "react";
import { SquareDivide } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { CategoryBreakdownModal } from "@/components/categories/CategoryBreakdownModal";
import { getCategoryIcon } from "@/lib/icons";
import { liveId, useChartSelection } from "@/lib/chartSelection";
import { sectorMidpointFraction, useSectorConnectorLine } from "@/lib/sectorConnector";
import { cn } from "@/lib/utils";

import { useTranslation } from "@/lib/i18n";
import { translateCategoryName } from "@/lib/categoryLabels";
import type { CategoryBreakdownItem } from "@/types";

interface SpendingByCategoryCardProps {
  items: CategoryBreakdownItem[];
}

function rowKey(item: { category_id: number | null }): string {
  return item.category_id !== null ? String(item.category_id) : "other";
}

function DonutTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: CategoryBreakdownItem }> }) {
  const { formatCurrency } = useSectionFormat();
  if (!active || !payload?.length) return null;
  const item = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm shadow-md">
      <p className="font-medium text-text-primary">{translateCategoryName(item.name)}</p>
      <p className="text-text-secondary">
        {formatCurrency(item.amount)} · {item.percent.toFixed(1)}%
      </p>
    </div>
  );
}

export function SpendingByCategoryCard({ items }: SpendingByCategoryCardProps) {
  const { formatCurrency } = useSectionFormat();
  const { t } = useTranslation();
  // Only the id is kept, not a snapshot of the item itself — `items` gets
  // refetched (with different amounts) whenever the display currency or
  // period changes, and re-deriving the open item from the *current*
  // `items` on every render is what stops the modal from showing
  // yesterday's amounts under today's currency label. If the id isn't in
  // the current `items` (e.g. mid-refetch, or the category dropped out of
  // the period entirely), the modal just closes instead of showing stale
  // numbers — same fix already applied to CategoryRankingCard.
  const [breakdownCategoryId, setBreakdownCategoryId] = useState<number | null>(null);
  const breakdownItem = breakdownCategoryId !== null
    ? items.find((item) => item.category_id === breakdownCategoryId) ?? null
    : null;

  const hasData = items.length > 0;
  // Recharts needs a numeric dataKey — API amounts arrive as strings (Decimal
  // is serialized as string to avoid float precision loss).
  const chartData = items.map((item) => ({ ...item, amount: Number(item.amount) }));

  const selection = useChartSelection<string>();
  const validIds = useMemo(() => new Set(items.map(rowKey)), [items]);
  const activeId = liveId(selection.activeId, validIds);
  const pinnedId = liveId(selection.pinnedId, validIds);

  const containerRef = useRef<HTMLDivElement>(null);
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const [activeRowEl, setActiveRowEl] = useState<HTMLButtonElement | null>(null);
  const activeIndex = activeId !== null ? chartData.findIndex((item) => rowKey(item) === activeId) : -1;
  const midpoint = activeIndex >= 0 ? sectorMidpointFraction(chartData.map((item) => item.amount), activeIndex) : null;
  const connectorLine = useSectorConnectorLine(containerRef, chartAreaRef, activeRowEl, midpoint);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("dashboard.spendingByCategoryTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="py-10 text-center text-sm text-text-muted">{t("dashboard.noExpensesThisMonth")}</p>
        ) : (
          <div ref={containerRef} className="relative flex flex-col items-center gap-6 sm:flex-row sm:items-center">
            {connectorLine && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
                <line
                  x1={connectorLine.x1} y1={connectorLine.y1} x2={connectorLine.x2} y2={connectorLine.y2}
                  stroke="var(--text-muted)" strokeWidth={1}
                />
              </svg>
            )}
            <div ref={chartAreaRef} className="h-56 w-56 shrink-0 sm:h-64 sm:w-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    dataKey="amount"
                    nameKey="name"
                    innerRadius="62%"
                    outerRadius="100%"
                    paddingAngle={2}
                    stroke="var(--surface-1)"
                    strokeWidth={2}
                    isAnimationActive={false}
                  >
                    {items.map((item) => {
                      const key = rowKey(item);
                      const isActive = activeId === key;
                      const dimmed = activeId !== null && !isActive;
                      return (
                        <Cell
                          key={key}
                          fill={item.color}
                          fillOpacity={dimmed ? 0.35 : 1}
                          stroke={isActive ? "var(--text-primary)" : "var(--surface-1)"}
                          strokeWidth={isActive ? 3 : 2}
                          tabIndex={0}
                          role="button"
                          aria-label={`${translateCategoryName(item.name)}, ${formatCurrency(item.amount)}, ${item.percent.toFixed(0)}%`}
                          aria-pressed={pinnedId === key}
                          onMouseEnter={() => selection.enter(key)}
                          onMouseLeave={selection.leave}
                          onFocus={() => selection.enter(key)}
                          onBlur={selection.leave}
                          onClick={() => selection.togglePin(key)}
                          onKeyDown={(event) => selection.onKeyDown(event, key)}
                        />
                      );
                    })}
                  </Pie>
                  <Tooltip content={<DonutTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <ul className="w-full min-w-0 flex-1 divide-y divide-gridline">
              {items.map((item) => {
                const Icon = getCategoryIcon(item.icon);
                const hasChildren = item.children.length > 0;
                const key = rowKey(item);
                const isActive = activeId === key;
                const dimmed = activeId !== null && !isActive;
                return (
                  <li key={key} className="flex items-center gap-1 py-2 first:pt-0 last:pb-0">
                    {/* Fixed-width slot on every row, populated or not — the
                        amount column at the row's end must stay flush right
                        the same way whether or not this row has a
                        breakdown to open. Kept as a sibling of the
                        selection button below, never nested inside it. */}
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                      {hasChildren && (
                        <button
                          type="button"
                          aria-label={t("common.expand")}
                          onClick={() => setBreakdownCategoryId(item.category_id)}
                          className="rounded-md p-0.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"
                        >
                          <SquareDivide size={15} />
                        </button>
                      )}
                    </span>
                    <button
                      type="button"
                      ref={isActive ? setActiveRowEl : undefined}
                      aria-pressed={pinnedId === key}
                      onMouseEnter={() => selection.enter(key)}
                      onMouseLeave={selection.leave}
                      onFocus={() => selection.enter(key)}
                      onBlur={selection.leave}
                      onClick={() => selection.togglePin(key)}
                      onKeyDown={(event) => selection.onKeyDown(event, key)}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 pl-1 text-left transition-opacity",
                        dimmed && "opacity-40",
                        isActive && "bg-surface-2"
                      )}
                    >
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                        style={{ backgroundColor: `${item.color}26` }}
                      >
                        <Icon size={14} style={{ color: item.color }} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                        {translateCategoryName(item.name)}
                      </span>
                      <span className="shrink-0 text-sm font-medium tabular-nums text-text-primary">
                        {formatCurrency(item.amount)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>

      {breakdownItem && breakdownItem.category_id !== null && (
        <CategoryBreakdownModal
          open
          onClose={() => setBreakdownCategoryId(null)}
          categoryId={breakdownItem.category_id}
          categoryName={breakdownItem.name}
          totalAmount={breakdownItem.amount}
          children={breakdownItem.children}
        />
      )}
    </Card>
  );
}
