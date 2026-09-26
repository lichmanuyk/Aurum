import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FileUp, Plus, Search, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { MonthSelector } from "@/components/layout/MonthSelector";
import { YearSelector } from "@/components/layout/YearSelector";
import { PillSelector } from "@/components/layout/PillSelector";
import { TransactionsTable } from "@/components/transactions/TransactionsTable";
import { TransactionFormModal } from "@/components/transactions/TransactionFormModal";
import { useTransactions, useDeleteTransaction, useTransactionYears } from "@/hooks/useTransactions";
import { useCategories } from "@/hooks/useCategories";
import { useTags } from "@/hooks/useTags";
import type { TransactionSort } from "@/api/transactions";
import { useTranslation } from "@/lib/i18n";
import { buildHierarchicalCategories, translateCategoryName } from "@/lib/categoryLabels";
import { parseDashboardPeriodParams, parseEndDateParam, visibleMonthCount } from "@/lib/dashboardPeriod";
import type { Transaction, TransactionType } from "@/types";

const PAGE_SIZE = 20;

type PeriodMode = "all" | "year";

export function TransactionsPage() {
  const { t, language } = useTranslation();
  const now = new Date();
  // Deep-linked from the Dashboard's "All transactions" link, which carries
  // the period the user was already looking at (?year=&month=, or
  // ?period=all, or ?year= alone for "every month of that year" — see
  // lib/dashboardPeriod.ts) so this page doesn't reset back to the current
  // month. A bare /transactions (e.g. from the nav sidebar) still falls
  // back to the current month exactly as before.
  const [searchParams] = useSearchParams();
  const [year, setYear] = useState<number | null>(
    () => parseDashboardPeriodParams(searchParams, { year: now.getFullYear(), month: now.getMonth() + 1 }).year
  );
  const [month, setMonth] = useState<number | null>(
    () => parseDashboardPeriodParams(searchParams, { year: now.getFullYear(), month: now.getMonth() + 1 }).month
  );
  // The server-resolved boundary a Dashboard link carried (see
  // lib/dashboardPeriod.ts) — reused verbatim, never recomputed from the
  // browser's own clock (see docs/tasks/dashboard-periods.md's review
  // notes). Cleared the moment the user picks a different period by hand:
  // a boundary tied to the period it was resolved for stops applying once
  // that period itself changes.
  const [endDate, setEndDate] = useState<string | null>(() => parseEndDateParam(searchParams));
  const [type, setType] = useState<TransactionType | "">("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [tagId, setTagId] = useState<string>("");
  const [sort, setSort] = useState<TransactionSort>("date_desc");
  const [page, setPage] = useState(1);

  // Raw text follows every keystroke; the debounced value is what actually
  // drives the query, so we're not refetching on every character typed.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timeout = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timeout);
  }, [searchInput]);
  const isSearching = search.length > 0;

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);

  const { data: categories } = useCategories();
  const { data: tags } = useTags();
  const { data: years } = useTransactionYears();
  const { data, isLoading, isError } = useTransactions({
    // A search looks for a purchase from an unknown month, so it must span
    // every period instead of being boxed into the currently selected one.
    // null (all time / every month of the year) also means "no filter on
    // this axis", same as undefined — see api/transactions.ts.
    year: isSearching ? undefined : year ?? undefined,
    month: isSearching ? undefined : month ?? undefined,
    // Only present when it came from a Dashboard link (see `endDate`
    // above) — an old link or manual browsing here was never clamped and
    // stays that way. A search already spans every period on purpose, so
    // it stays unclamped too.
    end_date: isSearching ? undefined : endDate ?? undefined,
    search: isSearching ? search : undefined,
    type: type || undefined,
    category_id: categoryId ? Number(categoryId) : undefined,
    tag_id: tagId ? Number(tagId) : undefined,
    sort,
    page,
    page_size: PAGE_SIZE,
  });
  const deleteTransaction = useDeleteTransaction();

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  // Grouped by kind and hierarchical within each group (a subcategory right
  // under its own parent, indented) — a bare "Sweets" option next to
  // top-level categories reads as if it were one itself.
  const expenseCategoryOptions = buildHierarchicalCategories(
    (categories ?? []).filter((category) => category.kind === "expense"),
    language
  );
  const incomeCategoryOptions = buildHierarchicalCategories(
    (categories ?? []).filter((category) => category.kind === "income"),
    language
  );

  function openCreateModal() {
    setEditingTransaction(null);
    setModalOpen(true);
  }

  function openEditModal(transaction: Transaction) {
    setEditingTransaction(transaction);
    setModalOpen(true);
  }

  function handleDelete(transaction: Transaction) {
    if (window.confirm(t("transactions.confirmDelete", { description: transaction.description }))) {
      deleteTransaction.mutate(transaction.id);
    }
  }

  /** Leaves search mode and switches the period selectors to whichever
   * month the picked transaction is in, so the user lands back in the normal
   * browsing view with it in context instead of a flat result list. */
  function handleJumpToMonth(transaction: Transaction) {
    const date = new Date(`${transaction.date}T00:00:00`);
    setYear(date.getFullYear());
    setMonth(date.getMonth() + 1);
    setEndDate(null);
    setSearchInput("");
    setSearch("");
    setPage(1);
  }

  const periodMode: PeriodMode = year === null ? "all" : "year";
  const PERIOD_MODE_OPTIONS: Array<{ value: PeriodMode; label: string }> = [
    { value: "all", label: t("reports.rangeAll") },
    { value: "year", label: t("dashboard.periodYear") },
  ];

  function handlePeriodModeChange(value: PeriodMode) {
    setYear(value === "all" ? null : now.getFullYear());
    setMonth(null);
    setEndDate(null); // the linked boundary was for the old period, not this one
    setPage(1);
  }

  function handleYearChange(newYear: number) {
    setYear(newYear);
    // Same "still on a now-future month" guard as the Dashboard — falls
    // back to "every month" instead of keeping an invalid selection.
    setMonth((current) => (current !== null && current > visibleMonthCount(newYear) ? null : current));
    setEndDate(null);
    setPage(1);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className={`flex min-w-0 flex-1 items-center gap-3 ${isSearching ? "pointer-events-none opacity-50" : ""}`}>
          <PillSelector options={PERIOD_MODE_OPTIONS} value={periodMode} onChange={handlePeriodModeChange} />
          {year !== null && (
            <>
              <div className="min-w-0 flex-1">
                <MonthSelector
                  month={month}
                  maxMonth={visibleMonthCount(year)}
                  allowAll
                  onChange={(value) => {
                    setMonth(value);
                    setEndDate(null);
                    setPage(1);
                  }}
                />
              </div>
              <YearSelector years={years ?? [now.getFullYear()]} year={year} onChange={handleYearChange} />
            </>
          )}
        </div>
        <div className="flex gap-2">
          <Link to="/transactions/import" className="flex-1 sm:flex-none">
            <Button variant="secondary" className="w-full sm:w-auto">
              <FileUp size={16} />
              {t("transactions.importButton")}
            </Button>
          </Link>
          <Button onClick={openCreateModal} className="flex-1 sm:w-auto">
            <Plus size={16} />
            {t("transactions.addButton")}
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
        <Input
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder={t("transactions.searchPlaceholder")}
          className="pl-9 pr-9"
        />
        {searchInput && (
          <button
            type="button"
            aria-label={t("common.clear")}
            onClick={() => {
              setSearchInput("");
              setSearch("");
              setPage(1);
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          >
            <X size={15} />
          </button>
        )}
      </div>
      {isSearching && <p className="text-xs text-text-muted">{t("transactions.searchAcrossAllTime")}</p>}

      <div className="flex flex-col gap-3 sm:flex-row">
        <Select
          value={type}
          onChange={(event) => {
            setType(event.target.value as TransactionType | "");
            setPage(1);
          }}
          className="sm:w-48"
        >
          <option value="">{t("transactions.allTypes")}</option>
          <option value="expense">{t("transactions.expense")}</option>
          <option value="income">{t("transactions.income")}</option>
          <option value="adjustment">{t("transactions.form.typeAdjustment")}</option>
              <option value="transfer">{t("transactions.transfer")}</option>
        </Select>
        <Select
          value={categoryId}
          onChange={(event) => {
            setCategoryId(event.target.value);
            setPage(1);
          }}
          className="sm:w-56"
        >
          <option value="">{t("transactions.allCategories")}</option>
          {expenseCategoryOptions.length > 0 && (
            <optgroup label={t("reports.expenseGroup")}>
              {expenseCategoryOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.indented ? `    ↳ ` : ""}
                  {translateCategoryName(category.name)}
                </option>
              ))}
            </optgroup>
          )}
          {incomeCategoryOptions.length > 0 && (
            <optgroup label={t("reports.incomeGroup")}>
              {incomeCategoryOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.indented ? `    ↳ ` : ""}
                  {translateCategoryName(category.name)}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
        {tags && tags.length > 0 && (
          <Select
            value={tagId}
            onChange={(event) => {
              setTagId(event.target.value);
              setPage(1);
            }}
            className="sm:w-48"
          >
            <option value="">{t("transactions.allTags")}</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </Select>
        )}
        <Select
          value={sort}
          onChange={(event) => {
            setSort(event.target.value as TransactionSort);
            setPage(1);
          }}
          className="sm:w-56"
        >
          <option value="date_desc">{t("transactions.sortDateDesc")}</option>
          <option value="amount_desc">{t("transactions.sortAmountDesc")}</option>
          <option value="amount_asc">{t("transactions.sortAmountAsc")}</option>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("nav.transactions")}</CardTitle>
          {data && <span className="text-xs text-text-muted">{t("common.totalCount", { count: data.total })}</span>}
        </CardHeader>
        <CardContent>
          {isError && <p className="py-6 text-center text-sm text-danger">{t("transactions.failedToLoad")}</p>}
          {isLoading ? (
            <p className="py-12 text-center text-sm text-text-muted">{t("common.loading")}</p>
          ) : (
            <TransactionsTable
              items={data?.items ?? []}
              onEdit={openEditModal}
              onDelete={handleDelete}
              onJumpToMonth={isSearching ? handleJumpToMonth : undefined}
            />
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

      <TransactionFormModal open={modalOpen} onClose={() => setModalOpen(false)} transaction={editingTransaction} />
    </div>
  );
}
