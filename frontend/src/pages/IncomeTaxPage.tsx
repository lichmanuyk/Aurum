import { useState } from "react";
import { BusinessDateNotice } from "@/components/layout/BusinessDateNotice";
import { MonthSelector } from "@/components/layout/MonthSelector";
import { PillSelector } from "@/components/layout/PillSelector";
import { YearSelector } from "@/components/layout/YearSelector";
import { useIncomeTaxReport } from "@/hooks/useIncomeTax";
import { useBusinessDate } from "@/hooks/useBusinessDate";
import { businessDateYear } from "@/lib/businessDate";
import { visibleMonthCount } from "@/lib/dashboardPeriod";
import { formatMoney, formatTransactionDate } from "@/lib/format";
import { useTranslation, type TranslationKey } from "@/lib/i18n";
import type { IncomeTaxPeriod, MandatoryPaymentKind } from "@/types";

type PeriodMode = "all" | "year";
const PAGE_SIZE = 12;

const KIND_LABEL_KEYS: Record<MandatoryPaymentKind, TranslationKey> = {
  zus: "transactions.form.mandatoryPaymentZus",
  ppe: "transactions.form.mandatoryPaymentPpe",
  vat: "transactions.form.mandatoryPaymentVat",
};

function formatPeriodLabel(period: string, language: "ru" | "en"): string {
  return new Intl.DateTimeFormat(language === "ru" ? "ru-RU" : "en-US", { month: "long", year: "numeric" }).format(
    new Date(`${period}T00:00:00`)
  );
}

function PeriodCard({ period, currency }: { period: IncomeTaxPeriod; currency: string }) {
  const { t, language } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold capitalize text-text-primary">{formatPeriodLabel(period.period, language)}</h3>
        {!period.income_received && Number(period.tax_paid_total) > 0 && (
          <span className="rounded-full bg-surface-1 px-2 py-0.5 text-xs text-text-muted">
            {t("incomeTax.awaitingIncome")}
          </span>
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <p className="text-xs text-text-muted">{t("incomeTax.grossIncomeLabel")}</p>
          <p className="text-sm font-medium tabular-nums text-success">{formatMoney(period.gross_income, currency)}</p>
        </div>
        {(["zus", "ppe", "vat"] as MandatoryPaymentKind[]).map((kind) => (
          <div key={kind}>
            <p className="text-xs text-text-muted">{t(KIND_LABEL_KEYS[kind])}</p>
            <p className="text-sm font-medium tabular-nums text-danger">
              {formatMoney(period.tax_paid_by_kind[kind] ?? "0", currency)}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-3 border-t border-border pt-2">
        <p className="text-xs text-text-muted">
          {period.income_received ? t("incomeTax.netLabel") : t("incomeTax.netPreliminaryLabel")}
        </p>
        <p className="text-base font-semibold tabular-nums text-text-primary">
          {formatMoney(period.net_after_paid_taxes, currency)}
        </p>
      </div>

      {period.entries.length > 0 && (
        <div className="mt-3">
          <button type="button" className="text-xs text-series-1 hover:underline" onClick={() => setOpen((v) => !v)}>
            {open ? t("incomeTax.hideEntries") : t("incomeTax.showEntries")}
          </button>
          {open && (
            <ul className="mt-2 divide-y divide-gridline">
              {period.entries.map((entry) => (
                <li key={`${entry.id}-${entry.split_id ?? "root"}`} className="flex items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-text-primary">{entry.description}</span>
                    <span className="block truncate text-xs text-text-muted">
                      {formatTransactionDate(entry.date, true)} · {entry.account_name} ·{" "}
                      {entry.kind ? t(KIND_LABEL_KEYS[entry.kind]) : t("incomeTax.workIncomeEntryLabel")}
                    </span>
                  </span>
                  <span className={`shrink-0 tabular-nums ${entry.kind ? "text-danger" : "text-success"}`}>
                    {formatMoney(entry.amount, currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Grouped by assigned_period, not by real cash date — see
 * docs/tasks/income-tax-separation.md. Read-only: this page never creates
 * or edits a classification; mark income/expense that way from the
 * ordinary Transaction form/recurring template instead. */
export function IncomeTaxPage() {
  const { t } = useTranslation();
  const { businessDate, isError: businessDateError, refetch: retryBusinessDate } = useBusinessDate();

  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(null);
  const [page, setPage] = useState(1);

  const { data: report, isLoading, isError, refetch } = useIncomeTaxReport({
    year: year ?? undefined,
    month: month ?? undefined,
    page,
    page_size: PAGE_SIZE,
  });
  // Every calendar year any assigned_period actually falls in, per the
  // backend (independent of the year/month filter above and of which
  // page is showing) — never GET /transactions/years' real cash-date
  // range, which this report deliberately does not group by. Falls back
  // to the server's current year while report is still nothing/empty (no
  // classified data yet), so "Year" mode always has at least one choice.
  const years = report?.available_years.length ? report.available_years : businessDate ? [businessDateYear(businessDate)] : [];

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
    } else if (businessDate) {
      setYear(businessDateYear(businessDate));
      setMonth(null);
    }
  }

  function handleYearChange(newYear: number) {
    setYear(newYear);
    setMonth((current) => (current !== null && businessDate && current > visibleMonthCount(newYear, businessDate) ? null : current));
    setPage(1);
  }

  const totalPages = report ? Math.max(1, Math.ceil(report.total / PAGE_SIZE)) : 1;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">{t("incomeTax.title")}</h1>
        <p className="mt-1 text-sm text-text-muted">{t("incomeTax.subtitle")}</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <PillSelector options={MODE_OPTIONS} value={mode} onChange={handleModeChange} disabledValues={businessDate ? [] : ["year"]} />
        {!businessDate && <BusinessDateNotice isError={businessDateError} retry={retryBusinessDate} />}
        {year !== null && businessDate && (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0 flex-1">
              <MonthSelector
                month={month}
                onChange={(value) => {
                  setMonth(value);
                  setPage(1);
                }}
                maxMonth={visibleMonthCount(year, businessDate)}
                allowAll
              />
            </div>
            <YearSelector years={years} year={year} onChange={handleYearChange} />
          </div>
        )}
      </div>

      {isError && (
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
          <p>{t("incomeTax.loadError")}</p>
          <button type="button" className="mt-1 underline" onClick={() => refetch()}>
            {t("netWorth.expenses.retry")}
          </button>
        </div>
      )}

      {!isError && (
        <>
          {isLoading || !report ? (
            <p className="py-8 text-center text-sm text-text-muted">{t("common.loading")}</p>
          ) : report.periods.length === 0 ? (
            <p className="py-8 text-center text-sm text-text-muted">{t("incomeTax.emptyState")}</p>
          ) : (
            <div className="space-y-3">
              {report.periods.map((period) => (
                <PeriodCard key={period.period} period={period} currency={report.reporting_currency} />
              ))}
            </div>
          )}

          {report && totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2 text-sm">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                {t("common.back")}
              </button>
              <span className="text-text-muted">{t("common.pageOf", { page, total: totalPages })}</span>
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("common.next")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
