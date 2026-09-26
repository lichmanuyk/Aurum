import { Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { getCategoryIcon } from "@/lib/icons";
import { formatMoney, formatTransactionDate } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import { categoryPath, translateCategoryName } from "@/lib/categoryLabels";
import { dashboardLinkFor, periodEndDate, type DashboardPeriod } from "@/lib/dashboardPeriod";
import { useTransactions } from "@/hooks/useTransactions";
import { useCategories } from "@/hooks/useCategories";

type RecentTransactionsCardProps = DashboardPeriod;

export function RecentTransactionsCard({ year, month }: RecentTransactionsCardProps) {
  const { t } = useTranslation();
  const { data, isLoading } = useTransactions({
    year: year ?? undefined, month: month ?? undefined,
    // Same "ends today" clamp the Dashboard's own totals already apply —
    // otherwise a future-dated transaction excluded from those totals
    // would still show up here (see docs/tasks/dashboard-periods.md's
    // review notes).
    end_date: periodEndDate({ year, month }),
    page: 1, page_size: 6,
  });
  const { data: categories } = useCategories();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("dashboard.recentTransactionsTitle")}</CardTitle>
        <Link
          to={dashboardLinkFor({ year, month })}
          className="text-xs font-medium text-series-1 hover:underline"
        >
          {t("dashboard.allTransactionsLink")}
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-10 text-center text-sm text-text-muted">{t("common.loading")}</p>
        ) : !data?.items.length ? (
          <p className="py-10 text-center text-sm text-text-muted">{t("dashboard.noTransactionsYet")}</p>
        ) : (
          <ul className="divide-y divide-gridline">
            {data.items.map((tx) => {
              const isSplit = tx.splits.length > 0;
              const Icon = getCategoryIcon(tx.category?.icon);
              const isTransfer = tx.type === "transfer";
          const isAdjustment = tx.type === "adjustment";
              const isExpense = tx.type === "expense";
              const color = tx.category?.color ?? "var(--text-muted)";
              const categoryLabel = isSplit
                ? tx.splits.map((split) => (split.category ? translateCategoryName(split.category.name) : "?")).join(" + ")
                : tx.category
                  ? categoryPath(tx.category, categories)
                  : null;
              return (
                <li key={tx.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                    style={{ backgroundColor: `${color}26` }}
                  >
                    <Icon size={15} style={{ color }} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text-primary">{tx.description}</span>
                    <span className="block truncate text-xs text-text-muted">
                      {formatTransactionDate(tx.date)} · {tx.account.name}
                      {isAdjustment ? ` · ${t("transactions.form.typeAdjustment")}` : ""}
                  {categoryLabel ? ` · ${categoryLabel}` : ""}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 text-sm font-medium tabular-nums ${
                      isTransfer || isAdjustment ? "text-text-muted" : isExpense ? "text-text-primary" : "text-success"
                    }`}
                  >
                    {isAdjustment ? (Number(tx.amount) > 0 ? "+" : "") : isTransfer ? "" : isExpense ? "-" : "+"}
                    {formatMoney(tx.amount, tx.account.currency)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
