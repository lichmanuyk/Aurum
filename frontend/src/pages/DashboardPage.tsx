import { MoneyError } from "@/components/ui/MoneyError";
import { useState } from "react";
import { MonthSelector } from "@/components/layout/MonthSelector";
import { YearSelector } from "@/components/layout/YearSelector";
import { PillSelector } from "@/components/layout/PillSelector";
import { FxRateOverviewCard } from "@/components/dashboard/FxRateOverviewCard";
import { StatCard } from "@/components/dashboard/StatCard";
import { SpendingByCategoryCard } from "@/components/dashboard/SpendingByCategoryCard";
import { RecentTransactionsCard } from "@/components/dashboard/RecentTransactionsCard";
import { AlertBanner } from "@/components/insights/AlertBanner";
import { useDashboardSummary } from "@/hooks/useDashboard";
import { useTransactionYears } from "@/hooks/useTransactions";
import { visibleMonthCount } from "@/lib/dashboardPeriod";
import { formatCurrency, formatSignedCurrency } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";

/** Share of income left over after spending (net / real_income). `null` when
 * there was no income to take a share of, rather than a misleading 0%. */
function savingsRate(realIncome: number, net: number): number | null {
  return realIncome > 0 ? (net / realIncome) * 100 : null;
}

function formatPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(0)}%`;
}

type PeriodMode = "all" | "year";

export function DashboardPage() {
  const { t } = useTranslation();
  const now = new Date();
  // Every fresh open starts on "all time" (year: null) — see
  // docs/tasks/dashboard-periods.md. Unlike TransactionsPage, this state is
  // deliberately NOT read from the URL: the Dashboard always starts here,
  // it never restores a previously picked period.
  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(null);
  const { data: years } = useTransactionYears();

  const mode: PeriodMode = year === null ? "all" : "year";
  const MODE_OPTIONS: Array<{ value: PeriodMode; label: string }> = [
    { value: "all", label: t("reports.rangeAll") },
    { value: "year", label: t("dashboard.periodYear") },
  ];

  function handleModeChange(value: PeriodMode) {
    if (value === "all") {
      setYear(null);
      setMonth(null);
    } else {
      // Picking "Год" for the first time lands on the whole year (every
      // month) — narrowing to one specific month is a further, separate step.
      setYear(now.getFullYear());
      setMonth(null);
    }
  }

  function handleYearChange(newYear: number) {
    setYear(newYear);
    // A month valid in the old year can be in the future for the new one
    // (e.g. November while viewing last year, then switching to this
    // year before November) — falls back to "every month" rather than
    // silently keeping a now-invalid selection.
    setMonth((current) => (current !== null && current > visibleMonthCount(newYear) ? null : current));
  }

  const { data, isLoading, isError, error } = useDashboardSummary(year, month);
  const rate = data ? savingsRate(Number(data.real_income), Number(data.net)) : null;

  return (
    <div className="space-y-5">
      <MoneyError error={error} />
      <AlertBanner excludeKeys={["risky_allocation_exceeded"]} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <PillSelector options={MODE_OPTIONS} value={mode} onChange={handleModeChange} />
        {year !== null && (
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="min-w-0 flex-1">
              <MonthSelector month={month} onChange={setMonth} maxMonth={visibleMonthCount(year)} allowAll />
            </div>
            <YearSelector years={years ?? [now.getFullYear()]} year={year} onChange={handleYearChange} />
          </div>
        )}
      </div>

      {isError && (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {t("dashboard.errorLoading")}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label={t("dashboard.statRealIncomeLabel")}
          value={isError ? "—" : isLoading ? "…" : formatCurrency(data?.real_income ?? 0, data?.reporting_currency)}
          caption={t("dashboard.statRealIncomeCaption")}
          tone="success"
        />
        <StatCard
          label={t("dashboard.statSpentLabel")}
          value={isError ? "—" : isLoading ? "…" : formatCurrency(data?.spent ?? 0, data?.reporting_currency)}
          caption={t("dashboard.statSpentCaption")}
          tone="danger"
        />
        <StatCard
          label={t("dashboard.statNetLabel")}
          value={isError ? "—" : isLoading ? "…" : formatSignedCurrency(data?.net ?? 0, data?.reporting_currency)}
          caption={t("dashboard.statNetCaption")}
          tone={Number(data?.net ?? 0) >= 0 ? "success" : "danger"}
        />
        <StatCard
          label={t("dashboard.statSavingsRateLabel")}
          value={isError ? "—" : isLoading ? "…" : rate === null ? "—" : formatPercent(rate)}
          caption={t("dashboard.statSavingsRateCaption")}
          tone={rate === null ? "default" : rate >= 0 ? "success" : "danger"}
        />
      </div>

      <FxRateOverviewCard year={year} month={month} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <SpendingByCategoryCard items={data?.spending_by_category ?? []} />
        <RecentTransactionsCard year={year} month={month} endDate={data?.end_date ?? null} />
      </div>
    </div>
  );
}
