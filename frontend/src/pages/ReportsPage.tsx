import { MoneyError } from "@/components/ui/MoneyError";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Label, Select } from "@/components/ui/Input";
import { PillSelector } from "@/components/layout/PillSelector";
import { YearRangeSelector } from "@/components/layout/YearSelector";
import { CategoryRankingCard } from "@/components/reports/CategoryRankingCard";
import { CategorySpendingChart } from "@/components/reports/CategorySpendingChart";
import { TransactionsTable } from "@/components/transactions/TransactionsTable";
import { TransactionFormModal } from "@/components/transactions/TransactionFormModal";
import { useCategories } from "@/hooks/useCategories";
import { useCategoryRanking, useCategorySpendingReport } from "@/hooks/useReports";
import { useDeleteTransaction, useTransactions, useTransactionYears } from "@/hooks/useTransactions";
import type { TransactionSort } from "@/api/transactions";
import { computeRange, parseRangeParam, parseYearRangeParam, type CustomYearRange, type RangePreset } from "@/lib/dateRange";
import { useTranslation } from "@/lib/i18n";
import { buildHierarchicalCategories, translateCategoryName } from "@/lib/categoryLabels";
import type { Transaction } from "@/types";

const PAGE_SIZE = 20;

/** Same defensive shape as parseYearParam/parseMonthParam in
 * TransactionsPage.tsx — a hand-edited or stale `category_id` falls back
 * to null (auto-select-first-expense) rather than crashing. */
function parseCategoryIdParam(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function ReportsPage() {
  const { t, language } = useTranslation();
  const now = new Date();
  const RANGE_OPTIONS: Array<{ value: RangePreset; label: string }> = [
    { value: "all", label: t("reports.rangeAll") },
    { value: "this_year", label: t("reports.rangeThisYear") },
    { value: "5y", label: t("reports.range5y") },
    { value: "custom", label: t("reports.rangeCustom") },
  ];
  const { data: categories } = useCategories();
  const { data: years } = useTransactionYears();
  // Read once as initial state, not kept in sync — same pattern as
  // TransactionsPage.tsx's year/month params, so a link from Cash Flow's
  // category lists (see reportsLinkFor in lib/dateRange.ts) survives a
  // page reload without fighting the user's own subsequent clicks here.
  const [searchParams] = useSearchParams();
  const categoryIdFromUrl = useRef(parseCategoryIdParam(searchParams.get("category_id"))).current;
  const [categoryId, setCategoryId] = useState<number | null>(categoryIdFromUrl);
  const [range, setRange] = useState<RangePreset>(() => parseRangeParam(searchParams.get("range"), "all"));
  const [customRange, setCustomRange] = useState<CustomYearRange>(() => ({
    fromYear: parseYearRangeParam(searchParams.get("from_year"), now.getFullYear()),
    toYear: parseYearRangeParam(searchParams.get("to_year"), now.getFullYear()),
  }));
  const [sort, setSort] = useState<TransactionSort>("date_desc");
  const [page, setPage] = useState(1);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (categoryId === null && categories && categories.length > 0) {
      const firstExpense = categories.find((category) => category.kind === "expense");
      setCategoryId((firstExpense ?? categories[0]).id);
    }
  }, [categories, categoryId]);

  const { startDate, endDate } = computeRange(range, customRange);
  const { data: ranking, isLoading: isRankingLoading, error: rankingError } = useCategoryRanking("expense", startDate, endDate);
  const { data: report, isLoading: isReportLoading, error: reportError } = useCategorySpendingReport(categoryId, startDate, endDate);
  const { data: transactions, isLoading: isTransactionsLoading } = useTransactions({
    category_id: categoryId ?? undefined,
    start_date: startDate,
    end_date: endDate,
    sort,
    page,
    page_size: PAGE_SIZE,
  });
  const deleteTransaction = useDeleteTransaction();

  // Hierarchical within each group (a subcategory right under its own
  // parent, indented) — a bare "Sweets" option next to top-level categories
  // reads as if it were one itself.
  const expenseCategories = buildHierarchicalCategories(
    categories?.filter((category) => category.kind === "expense") ?? [],
    language
  );
  const incomeCategories = buildHierarchicalCategories(
    categories?.filter((category) => category.kind === "income") ?? [],
    language
  );
  const totalPages = transactions ? Math.max(1, Math.ceil(transactions.total / PAGE_SIZE)) : 1;

  function handleEdit(transaction: Transaction) {
    setEditingTransaction(transaction);
    setModalOpen(true);
  }

  function handleDelete(transaction: Transaction) {
    if (window.confirm(t("transactions.confirmDelete", { description: transaction.description }))) {
      deleteTransaction.mutate(transaction.id);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-xs flex-1">
          <Label htmlFor="report-category">{t("reports.categoryLabel")}</Label>
          <Select
            id="report-category"
            value={categoryId ?? ""}
            onChange={(event) => {
              setCategoryId(Number(event.target.value));
              setPage(1);
            }}
          >
            {expenseCategories.length > 0 && (
              <optgroup label={t("reports.expenseGroup")}>
                {expenseCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.indented ? `    ↳ ` : ""}
                    {translateCategoryName(category.name)}
                  </option>
                ))}
              </optgroup>
            )}
            {incomeCategories.length > 0 && (
              <optgroup label={t("reports.incomeGroup")}>
                {incomeCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.indented ? `    ↳ ` : ""}
                    {translateCategoryName(category.name)}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <PillSelector
            options={RANGE_OPTIONS}
            value={range}
            onChange={(value) => {
              setRange(value);
              setPage(1);
            }}
          />
          {range === "custom" && (
            <YearRangeSelector
              years={years ?? [now.getFullYear()]}
              fromYear={customRange.fromYear}
              toYear={customRange.toYear}
              onChange={(value) => {
                setCustomRange(value);
                setPage(1);
              }}
            />
          )}
        </div>
      </div>

      {reportError ? <MoneyError error={reportError} /> : <CategorySpendingChart report={report} isLoading={isReportLoading} />}

      <MoneyError error={rankingError} />
      {!rankingError && <CategoryRankingCard
        items={ranking?.items ?? []}
        isLoading={isRankingLoading}
        selectedCategoryId={categoryId}
        onSelectCategory={(id) => {
          setCategoryId(id);
          setPage(1);
        }}
      />}

      <Card>
        <CardHeader>
          <CardTitle>{t("reports.transactionsTitle")}</CardTitle>
          {transactions && (
            <span className="text-xs text-text-muted">{t("common.totalCount", { count: transactions.total })}</span>
          )}
        </CardHeader>
        <CardContent>
          <Select
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as TransactionSort);
              setPage(1);
            }}
            className="mb-3 sm:w-56"
          >
            <option value="date_desc">{t("transactions.sortDateDesc")}</option>
            <option value="amount_desc">{t("transactions.sortAmountDesc")}</option>
            <option value="amount_asc">{t("transactions.sortAmountAsc")}</option>
          </Select>
          {isTransactionsLoading ? (
            <p className="py-12 text-center text-sm text-text-muted">{t("common.loading")}</p>
          ) : (
            <TransactionsTable items={transactions?.items ?? []} onEdit={handleEdit} onDelete={handleDelete} />
          )}

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3 text-sm">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                {t("common.back")}
              </Button>
              <span className="text-text-muted">{t("common.pageOf", { page, total: totalPages })}</span>
              <Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                {t("common.next")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <TransactionFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        transaction={editingTransaction}
      />
    </div>
  );
}
