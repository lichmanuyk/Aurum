import { MoneyError } from "@/components/ui/MoneyError";
import { useState } from "react";
import { PillSelector } from "@/components/layout/PillSelector";
import { YearRangeSelector } from "@/components/layout/YearSelector";
import { CashFlowChart } from "@/components/cashflow/CashFlowChart";
import { CategoryRankingCard } from "@/components/reports/CategoryRankingCard";
import { useCashFlow } from "@/hooks/useCashFlow";
import { useCategoryRanking } from "@/hooks/useReports";
import { useTransactionYears } from "@/hooks/useTransactions";
import { computeRange, reportsLinkFor, type CustomYearRange, type RangePreset } from "@/lib/dateRange";
import { useTranslation } from "@/lib/i18n";

export function CashFlowPage() {
  const { t } = useTranslation();
  const now = new Date();
  const { data: years } = useTransactionYears();
  const [range, setRange] = useState<RangePreset>("this_year");
  const [customRange, setCustomRange] = useState<CustomYearRange>({
    fromYear: now.getFullYear(),
    toYear: now.getFullYear(),
  });

  const RANGE_OPTIONS: Array<{ value: RangePreset; label: string }> = [
    { value: "all", label: t("reports.rangeAll") },
    { value: "this_year", label: t("reports.rangeThisYear") },
    { value: "5y", label: t("reports.range5y") },
    { value: "custom", label: t("reports.rangeCustom") },
  ];

  const { startDate, endDate } = computeRange(range, customRange);
  const { data: cashFlow, isLoading, error } = useCashFlow(startDate, endDate);
  const { data: incomeRanking, isLoading: isIncomeRankingLoading, error: incomeRankingError } =
    useCategoryRanking("income", startDate, endDate);
  const { data: expenseRanking, isLoading: isExpenseRankingLoading, error: expenseRankingError } =
    useCategoryRanking("expense", startDate, endDate);

  function linkTo(categoryId: number) {
    return reportsLinkFor(categoryId, range, customRange);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <PillSelector options={RANGE_OPTIONS} value={range} onChange={setRange} />
        {range === "custom" && (
          <YearRangeSelector
            years={years ?? [now.getFullYear()]}
            fromYear={customRange.fromYear}
            toYear={customRange.toYear}
            onChange={setCustomRange}
          />
        )}
      </div>

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
    </div>
  );
}
