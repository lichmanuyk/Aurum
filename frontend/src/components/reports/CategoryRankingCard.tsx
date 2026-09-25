import { useState } from "react";
import { Link } from "react-router-dom";
import { SquareDivide } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { CategoryBreakdownModal } from "@/components/categories/CategoryBreakdownModal";
import { getCategoryIcon } from "@/lib/icons";
import { useSectionFormat } from "@/lib/displayCurrency";
import { useTranslation } from "@/lib/i18n";
import { translateCategoryName } from "@/lib/categoryLabels";
import type { CategoryRankingItem } from "@/types";

interface CategoryRankingCardProps {
  items: CategoryRankingItem[];
  isLoading: boolean;
  /** Overrides the default "Top categories for period" heading — Cash Flow
   * uses this for its separate income/expense lists. */
  title?: string;
  emptyMessage?: string;
  /** Reports' own usage: clicking a row selects the category in place
   * (highlighted via `selectedCategoryId`). Mutually exclusive with
   * `linkTo` below — a row is either a same-page selector or a link out,
   * never both. */
  selectedCategoryId?: number | null;
  onSelectCategory?: (categoryId: number) => void;
  /** Cash Flow's own usage: clicking a row navigates to Reports with the
   * category (and Cash Flow's own period) carried over as query params, so
   * the destination survives a reload — see CashFlowPage.tsx. */
  linkTo?: (categoryId: number) => string;
}

/** Ranks every category of one kind by total over the currently selected
 * period — unlike the Dashboard breakdown (locked to one month) or the
 * detail chart below (locked to one category), this is "which category
 * costs/earns the most" across the whole range at once. Reused by both
 * Reports (select a category in place) and Cash Flow (link out to
 * Reports) — see `linkTo` above. */
export function CategoryRankingCard({
  items, isLoading, title, emptyMessage, selectedCategoryId, onSelectCategory, linkTo,
}: CategoryRankingCardProps) {
  const { t } = useTranslation();
  const { formatCurrency } = useSectionFormat();
  // The subcategory breakdown lives in a modal, not expanded inline — a
  // category with many subcategories would otherwise push the whole ranking
  // list taller and shift every row below it. Only the id is kept, not a
  // snapshot of the item itself — `items` gets refetched (with different
  // amounts) whenever the display currency changes, and re-deriving the
  // open item from the *current* `items` on every render is what stops the
  // modal from showing yesterday's amounts under today's currency label. If
  // the id isn't in the current `items` (e.g. mid-refetch), the modal just
  // closes instead of showing stale numbers.
  const [breakdownCategoryId, setBreakdownCategoryId] = useState<number | null>(null);
  const breakdownItem = breakdownCategoryId !== null
    ? items.find((item) => item.category_id === breakdownCategoryId) ?? null
    : null;

  const rowContent = (item: CategoryRankingItem, index: number) => {
    const Icon = getCategoryIcon(item.icon);
    return (
      <>
        <span className="w-4 shrink-0 text-right text-xs tabular-nums text-text-muted">{index + 1}</span>
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: `${item.color}26` }}
        >
          <Icon size={15} style={{ color: item.color }} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
          {translateCategoryName(item.name)}
        </span>
        {/* The bar is a decorative width preview — safe to drop on a phone.
            The percentage itself is required at every width (each list's
            share of its own kind), so it stays outside the `sm:flex` gate
            that hides the bar. */}
        <span className="hidden w-16 shrink-0 items-center sm:flex">
          <span className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full"
              style={{ width: `${item.percent}%`, backgroundColor: item.color }}
            />
          </span>
        </span>
        <span className="w-9 shrink-0 text-right text-xs text-text-muted tabular-nums">
          {item.percent.toFixed(0)}%
        </span>
        <span className="shrink-0 text-sm font-medium tabular-nums text-text-primary">
          {formatCurrency(item.amount)}
        </span>
      </>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title ?? t("reports.categoryRankingTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-10 text-center text-sm text-text-muted">{t("common.loading")}</p>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-text-muted">{emptyMessage ?? t("reports.noRankingData")}</p>
        ) : (
          <ul className="divide-y divide-gridline">
            {items.map((item, index) => {
              const isSelected = item.category_id === selectedCategoryId;
              const hasChildren = item.children.length > 0;
              return (
                <li key={item.category_id}>
                  <div
                    className={`flex items-center gap-1 rounded-lg transition-colors hover:bg-surface-2 ${
                      isSelected ? "bg-surface-2" : ""
                    }`}
                  >
                    {/* Fixed-width slot on every row, populated or not — the
                        amount column at the row's end must stay flush right
                        the same way whether or not this row has a
                        breakdown to open. */}
                    <span className="ml-1 flex h-8 w-7 shrink-0 items-center justify-center">
                      {hasChildren && (
                        <button
                          type="button"
                          aria-label={t("common.expand")}
                          onClick={() => setBreakdownCategoryId(item.category_id)}
                          className="rounded-md p-1.5 text-text-muted hover:text-text-primary"
                        >
                          <SquareDivide size={14} />
                        </button>
                      )}
                    </span>
                    {linkTo ? (
                      <Link to={linkTo(item.category_id)} className="flex flex-1 items-center gap-3 py-2.5 text-left">
                        {rowContent(item, index)}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelectCategory?.(item.category_id)}
                        className="flex flex-1 items-center gap-3 py-2.5 text-left"
                      >
                        {rowContent(item, index)}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {breakdownItem && (
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
