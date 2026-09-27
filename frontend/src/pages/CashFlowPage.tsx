import { MoneyError } from "@/components/ui/MoneyError";
import { useEffect, useRef, useState } from "react";
import { BusinessDateNotice } from "@/components/layout/BusinessDateNotice";
import { PillSelector } from "@/components/layout/PillSelector";
import { YearRangeSelector } from "@/components/layout/YearSelector";
import { CashFlowChart } from "@/components/cashflow/CashFlowChart";
import { CategoryRankingCard } from "@/components/reports/CategoryRankingCard";
import { useBusinessDate } from "@/hooks/useBusinessDate";
import { useCashFlow } from "@/hooks/useCashFlow";
import { useCategoryRanking } from "@/hooks/useReports";
import { useTransactionYears } from "@/hooks/useTransactions";
import { businessDateYear } from "@/lib/businessDate";
import { computeRange, reportsLinkFor, DATE_DEPENDENT_RANGE_PRESETS, type CustomYearRange, type RangePreset } from "@/lib/dateRange";
import { useTranslation } from "@/lib/i18n";

export function CashFlowPage() {
  const { t } = useTranslation();
  // The server's business date (see docs/tasks/business-date-timezone.md),
  // not the browser's own `new Date()` — computeRange below sends
  // `endDate` straight through as GET /cash-flow's inclusive upper bound.
  const { businessDate, isError: businessDateError, refetch: retryBusinessDate } = useBusinessDate();
  const { data: years } = useTransactionYears();
  const [range, setRange] = useState<RangePreset>("this_year");
  // `null` — not yet seeded — until the one-time effect below fills it in
  // from the real business date; never a browser-guessed year. Once set,
  // only the user's own picks (via YearRangeSelector) ever change it again
  // — a later business-date poll (including a midnight rollover) never
  // resets an already-open/hand-picked custom range.
  const [customRange, setCustomRange] = useState<CustomYearRange | null>(null);
  const customRangeSeeded = useRef(false);
  useEffect(() => {
    if (customRangeSeeded.current || !businessDate) return;
    customRangeSeeded.current = true;
    setCustomRange((current) => current ?? { fromYear: businessDateYear(businessDate), toYear: businessDateYear(businessDate) });
  }, [businessDate]);

  const RANGE_OPTIONS: Array<{ value: RangePreset; label: string }> = [
    { value: "all", label: t("reports.rangeAll") },
    { value: "this_year", label: t("reports.rangeThisYear") },
    { value: "5y", label: t("reports.range5y") },
    { value: "custom", label: t("reports.rangeCustom") },
  ];

  const computed = computeRange(range, businessDate, customRange ?? undefined);
  // Defends against the one edge computeRange itself can't see: "custom"
  // selected but the picker hasn't been seeded yet (see the effect above)
  // — computeRange alone would call that "ready" with no bound (its
  // documented behavior for "no custom range chosen at all"), which is
  // right for a deliberate no-op custom range but wrong for "hasn't loaded
  // yet". In practice this window is unreachable through the UI (the
  // "Custom" pill itself is disabled below until businessDate is ready,
  // and the effect above seeds customRange in the very next tick after
  // that), but the check costs nothing and removes the possibility outright.
  const boundsReady = computed.status === "ready" && !(range === "custom" && customRange === null);
  const { startDate, endDate } = boundsReady && computed.status === "ready" ? computed : {};

  const { data: cashFlow, isLoading, error } = useCashFlow(startDate, endDate, { enabled: boundsReady });
  const { data: incomeRanking, isLoading: isIncomeRankingLoading, error: incomeRankingError } =
    useCategoryRanking("income", startDate, endDate, { enabled: boundsReady });
  const { data: expenseRanking, isLoading: isExpenseRankingLoading, error: expenseRankingError } =
    useCategoryRanking("expense", startDate, endDate, { enabled: boundsReady });

  function linkTo(categoryId: number) {
    // Only ever called from a rendered ranking row, which only exists once
    // boundsReady (and therefore customRange, if relevant) is set.
    return reportsLinkFor(categoryId, range, customRange!);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <PillSelector
          options={RANGE_OPTIONS}
          value={range}
          onChange={setRange}
          disabledValues={businessDate ? [] : DATE_DEPENDENT_RANGE_PRESETS}
        />
        {range === "custom" && customRange && (
          <YearRangeSelector
            years={years ?? [customRange.fromYear]}
            fromYear={customRange.fromYear}
            toYear={customRange.toYear}
            onChange={setCustomRange}
          />
        )}
      </div>

      {!boundsReady ? (
        <BusinessDateNotice isError={businessDateError} retry={retryBusinessDate} className="text-sm text-text-muted" />
      ) : (
        <>
          {error ? <MoneyError error={error} /> : <CashFlowChart cashFlow={cashFlow} isLoading={isLoading} />}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div>
              <MoneyError error={incomeRankingError} />
              {!incomeRankingError && (
                <CategoryRankingCard
                  items={incomeRanking?.items ?? []}
                  isLoading={isIncomeRankingLoading}
                  title={t("cashFlow.incomeCategoriesTitle")}
                  emptyMessage={t("cashFlow.noIncomeCategories")}
                  linkTo={linkTo}
                />
              )}
            </div>
            <div>
              <MoneyError error={expenseRankingError} />
              {!expenseRankingError && (
                <CategoryRankingCard
                  items={expenseRanking?.items ?? []}
                  isLoading={isExpenseRankingLoading}
                  title={t("cashFlow.expenseCategoriesTitle")}
                  linkTo={linkTo}
                />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
