import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  bulkCreateTransactions,
  createTransaction,
  deleteTransaction,
  fetchAllTransactionsInRange,
  fetchTransactions,
  fetchTransactionYears,
  updateTransaction,
  type TransactionFilters,
} from "@/api/transactions";
import type { TransactionInput } from "@/types";

function useInvalidateAfterTransactionChange() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["accounts"] });
    queryClient.invalidateQueries({ queryKey: ["transactions"] });
    // Without this, a second CSV import of the same date range within
    // staleTime (see main.tsx) would check for duplicates against a cached
    // list from *before* the first import finished — and find none, which
    // is exactly the case the duplicate check exists to catch.
    queryClient.invalidateQueries({ queryKey: ["transactions-duplicate-check"] });
    queryClient.invalidateQueries({ queryKey: ["transaction-years"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] });
    queryClient.invalidateQueries({ queryKey: ["net-worth-summary"] });
    queryClient.invalidateQueries({ queryKey: ["category-spending-report"] });
    queryClient.invalidateQueries({ queryKey: ["category-ranking"] });
    queryClient.invalidateQueries({ queryKey: ["budget-status"] });
    queryClient.invalidateQueries({ queryKey: ["financial-alerts"] });
    queryClient.invalidateQueries({ queryKey: ["advice"] });
    queryClient.invalidateQueries({ queryKey: ["cash-flow"] });
    // A create/edit/delete/bulk-import can add, change or remove a
    // gross-income/mandatory-tax classification (see
    // docs/tasks/income-tax-separation.md) — refresh the "Income & Taxes"
    // report too, same as every other derived total above.
    queryClient.invalidateQueries({ queryKey: ["income-tax"] });
    // A create/edit/delete can change any asset's linked "Expenses" total
    // (see docs/tasks/property-expense-links.md) — invalidate every
    // asset/period/page combination rather than guessing which one(s) this
    // particular transaction touched.
    queryClient.invalidateQueries({ queryKey: ["asset-expenses"] });
  };
}

export function useTransactions(filters: TransactionFilters, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["transactions", filters],
    queryFn: () => fetchTransactions(filters),
    enabled: options?.enabled,
  });
}

/** CSV import's duplicate check (see pages/CsvImportPage.tsx) — every
 * existing transaction for one account within the imported date range, so
 * re-importing an overlapping bank export can be told apart from new rows. */
export function useTransactionsForDuplicateCheck(
  accountId: number | null,
  startDate: string | null,
  endDate: string | null
) {
  return useQuery({
    queryKey: ["transactions-duplicate-check", accountId, startDate, endDate],
    queryFn: () => fetchAllTransactionsInRange({ account_id: accountId!, start_date: startDate!, end_date: endDate! }),
    enabled: accountId !== null && startDate !== null && endDate !== null,
  });
}

export function useTransactionYears() {
  return useQuery({
    queryKey: ["transaction-years"],
    queryFn: fetchTransactionYears,
  });
}

export function useCreateTransaction() {
  const invalidate = useInvalidateAfterTransactionChange();
  return useMutation({
    mutationFn: (input: TransactionInput) => createTransaction(input),
    onSuccess: invalidate,
  });
}

export function useUpdateTransaction() {
  const invalidate = useInvalidateAfterTransactionChange();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: Partial<TransactionInput> }) =>
      updateTransaction(id, input),
    onSuccess: invalidate,
  });
}

export function useBulkCreateTransactions() {
  const invalidate = useInvalidateAfterTransactionChange();
  return useMutation({
    mutationFn: (items: TransactionInput[]) => bulkCreateTransactions(items),
    onSuccess: invalidate,
  });
}

export function useDeleteTransaction() {
  const invalidate = useInvalidateAfterTransactionChange();
  return useMutation({
    mutationFn: (id: number) => deleteTransaction(id),
    onSuccess: invalidate,
  });
}
