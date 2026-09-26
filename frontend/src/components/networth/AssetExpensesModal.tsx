import { Fragment, useEffect, useState } from "react";
import { Receipt } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { MonthSelector } from "@/components/layout/MonthSelector";
import { YearSelector } from "@/components/layout/YearSelector";
import { PillSelector } from "@/components/layout/PillSelector";
import { RecurringPaymentModal } from "@/components/recurring/RecurringPaymentModal";
import { useAssetExpenses } from "@/hooks/useAssets";
import { useTransactionYears } from "@/hooks/useTransactions";
import { useSectionCurrency } from "@/lib/displayCurrency";
import { visibleMonthCount } from "@/lib/dashboardPeriod";
import { formatMoney, formatTransactionDate } from "@/lib/format";
import { useTranslation, type TranslationKey } from "@/lib/i18n";
import type { Asset, RecurringTransaction } from "@/types";

interface AssetExpensesModalProps {
  open: boolean;
  onClose: () => void;
  asset: Asset | null;
}

type PeriodMode = "all" | "year";
const PAGE_SIZE = 10;

/** A manually-tracked asset's own actual spending — see
 * docs/tasks/property-expense-links.md. Read-only aggregation over
 * Transactions/split lines/recurring templates already linked to this
 * asset (see routes/assets.py's get_asset_expenses); this dialog itself
 * never creates or edits a link, only "Pay" on a linked template (which
 * reuses the existing recurring-payment flow unchanged). */
export function AssetExpensesModal({ open, onClose, asset }: AssetExpensesModalProps) {
  const { t } = useTranslation();
  // Same section currency the capital summary itself uses (see
  // useSectionCurrency) — the report's own total is then directly
  // comparable to the asset's own capital_value shown in AssetsTable.
  const currency = useSectionCurrency();
  const { data: years } = useTransactionYears();

  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [payingTemplate, setPayingTemplate] = useState<RecurringTransaction | null>(null);

  // Every fresh open starts on "all time" for whichever asset was picked —
  // switching assets (or reopening) never keeps a stale period/page from a
  // previous look, matching Dashboard's own "always starts here" rule.
  useEffect(() => {
    if (!open) return;
    setYear(null);
    setMonth(null);
    setPage(1);
  }, [open, asset?.id]);

  const assetId = open ? asset?.id ?? null : null;
  const { data: report, isLoading, isError, error, refetch } = useAssetExpenses(assetId, {
    year: year ?? undefined,
    month: month ?? undefined,
    page,
    page_size: PAGE_SIZE,
    currency,
  });

  if (!asset) return null;

  const mode: PeriodMode = year === null ? "all" : "year";
  const MODE_OPTIONS: Array<{ value: PeriodMode; label: string }> = [
    { value: "all", label: t("reports.rangeAll") },
    { value: "year", label: t("dashboard.periodYear") },
  ];

  function handleModeChange(value: PeriodMode) {
    setPage(1);
    if (value === "all") {
      setYear(null);
      setMonth(null);
    } else {
      setYear(new Date().getFullYear());
      setMonth(null);
    }
  }

  function handleYearChange(newYear: number) {
    setYear(newYear);
    setMonth((current) => (current !== null && current > visibleMonthCount(newYear) ? null : current));
    setPage(1);
  }

  const totalPages = report ? Math.max(1, Math.ceil(report.total / PAGE_SIZE)) : 1;

  return (
    // RecurringPaymentModal is a sibling, not a child, of this Dialog —
    // both render their own independent role="dialog" overlay, and
    // nesting one inside the other's children would make the outer
    // dialog's accessible text/DOM tree include the inner one's (Dialog
    // isn't portal-based), which is confusing for both screen readers and
    // any test locating "the dialog" by its title text.
    <Fragment>
      <Dialog open={open} onClose={onClose} title={t("netWorth.expenses.title", { name: asset.name })} size="lg">
        <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <PillSelector options={MODE_OPTIONS} value={mode} onChange={handleModeChange} />
          {year !== null && (
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="min-w-0 flex-1">
                <MonthSelector
                  month={month}
                  onChange={(value) => {
                    setMonth(value);
                    setPage(1);
                  }}
                  maxMonth={visibleMonthCount(year)}
                  allowAll
                />
              </div>
              <YearSelector years={years ?? [new Date().getFullYear()]} year={year} onChange={handleYearChange} />
            </div>
          )}
        </div>

        {isError && (
          <div role="alert" className="rounded-lg border border-danger/30 p-3 text-sm text-danger">
            <p>{error.message}</p>
            <button type="button" className="mt-1 underline" onClick={() => refetch()}>
              {t("netWorth.expenses.retry")}
            </button>
          </div>
        )}

        {!isError && (
          <>
            <div className="rounded-lg border border-border bg-surface-2 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                {t("netWorth.expenses.totalLabel")}
              </p>
              <p className="mt-1.5 text-2xl font-semibold tabular-nums text-text-primary">
                {isLoading || !report ? "…" : formatMoney(report.total_amount, report.reporting_currency)}
              </p>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-text-primary">{t("netWorth.expenses.recentTitle")}</h3>
              {isLoading || !report ? (
                <p className="py-6 text-center text-sm text-text-muted">{t("common.loading")}</p>
              ) : report.items.length === 0 ? (
                <p className="py-6 text-center text-sm text-text-muted">{t("netWorth.expenses.emptyExpenses")}</p>
              ) : (
                <ul className="divide-y divide-gridline">
                  {report.items.map((item) => (
                    <li key={`${item.id}-${item.split_id ?? "root"}`} className="flex items-center gap-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-text-primary">
                          {item.description}
                          {item.is_split && item.category_name ? ` · ${item.category_name}` : ""}
                        </span>
                        <span className="block truncate text-xs text-text-muted">
                          {formatTransactionDate(item.date)} · {item.account_name}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block text-sm font-medium tabular-nums text-text-primary">
                          {formatMoney(item.amount, report.reporting_currency)}
                        </span>
                        {item.account_currency !== report.reporting_currency && (
                          <span className="block text-xs text-text-muted">
                            {formatMoney(item.native_amount, item.account_currency)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {report && totalPages > 1 && (
                <div className="mt-3 flex items-center justify-center gap-3 text-sm">
                  <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    {t("common.back")}
                  </Button>
                  <span className="text-text-muted">{t("common.pageOf", { page, total: totalPages })}</span>
                  <Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                    {t("common.next")}
                  </Button>
                </div>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold text-text-primary">{t("netWorth.expenses.templatesTitle")}</h3>
              {isLoading || !report ? (
                <p className="py-4 text-center text-sm text-text-muted">{t("common.loading")}</p>
              ) : report.templates.length === 0 ? (
                <p className="py-4 text-center text-sm text-text-muted">{t("netWorth.expenses.emptyTemplates")}</p>
              ) : (
                <ul className="divide-y divide-gridline">
                  {report.templates.map((template) => (
                    <li key={template.id} className="flex items-center gap-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-text-primary">
                          {template.description}
                        </span>
                        <span className="block truncate text-xs text-text-muted">
                          {formatMoney(template.amount, template.currency)} ·{" "}
                          {t(`recurring.frequency.${template.frequency}` as TranslationKey)}
                        </span>
                      </span>
                      <Button
                        variant="secondary"
                        disabled={!template.is_active}
                        onClick={() => setPayingTemplate(template)}
                      >
                        {t("recurring.postLabel")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {report && report.items.length === 0 && report.templates.length === 0 && (
              <p className="flex items-start gap-1.5 rounded-lg border border-border bg-surface-2 p-3 text-xs text-text-muted">
                <Receipt size={14} className="mt-0.5 shrink-0" aria-hidden />
                <span>{t("netWorth.expenses.linkHint")}</span>
              </p>
            )}
          </>
        )}

        <div className="flex justify-end pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </div>
        </div>
      </Dialog>

      <RecurringPaymentModal
        open={payingTemplate !== null}
        onClose={() => setPayingTemplate(null)}
        recurring={payingTemplate}
      />
    </Fragment>
  );
}
