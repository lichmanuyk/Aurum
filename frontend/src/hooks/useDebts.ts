import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createDebt,
  createDebtRepayment,
  deleteDebt,
  deleteDebtRepayment,
  fetchDebt,
  fetchDebtRepayments,
  fetchDebts,
  reverseDebtRepayment,
  updateDebt,
  updateDebtRepaymentNote,
} from "@/api/debts";
import type {
  DebtCreateInput,
  DebtDirection,
  DebtRepaymentCreateInput,
  DebtRepaymentNoteInput,
  DebtRepaymentReverseInput,
  DebtStatus,
  DebtUpdateInput,
} from "@/types";

/** See docs/tasks/debt-tracking.md. Every mutation here moves real cash
 * (a new loan's issuance, a repayment, a reversal) or changes a debt's own
 * outstanding/status — invalidates every cache a normal financial mutation
 * already invalidates elsewhere (accounts/transactions/dashboard/net-worth/
 * cash-flow — see hooks/useAssetMovements.ts and useDeleteAccount's own
 * list), plus this feature's own "debts"/"debt-repayments" query keys. An
 * opening-balance debt moves no cash at all, but still changes `current`
 * net worth and the debt's own outstanding/status, so the same full
 * invalidation set is used unconditionally rather than trying to special-
 * case which mutation actually touched cash. */
function useInvalidateDebts() {
  const client = useQueryClient();
  return () => {
    for (const key of ["debts", "debt-repayments", "accounts", "transactions", "dashboard-summary", "cash-flow", "net-worth-summary"]) {
      client.invalidateQueries({ queryKey: [key] });
    }
  };
}

export function useDebts(direction?: DebtDirection | "", status?: DebtStatus | "") {
  return useQuery({ queryKey: ["debts", direction ?? "", status ?? ""], queryFn: () => fetchDebts(direction, status) });
}

export function useDebt(id: number | null) {
  return useQuery({ queryKey: ["debts", "one", id], queryFn: () => fetchDebt(id!), enabled: id !== null });
}

export function useCreateDebt() {
  const invalidate = useInvalidateDebts();
  return useMutation({ mutationFn: (input: DebtCreateInput) => createDebt(input), onSuccess: invalidate });
}

export function useUpdateDebt() {
  const invalidate = useInvalidateDebts();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: DebtUpdateInput }) => updateDebt(id, input),
    onSuccess: invalidate,
  });
}

export function useDeleteDebt() {
  const invalidate = useInvalidateDebts();
  return useMutation({ mutationFn: (id: number) => deleteDebt(id), onSuccess: invalidate });
}

export function useDebtRepayments(debtId: number | null) {
  return useQuery({
    queryKey: ["debt-repayments", debtId],
    queryFn: () => fetchDebtRepayments(debtId!),
    enabled: debtId !== null,
  });
}

export function useDebtRepaymentActions(debtId: number) {
  const invalidate = useInvalidateDebts();
  return {
    create: useMutation({
      mutationFn: (input: DebtRepaymentCreateInput) => createDebtRepayment(debtId, input),
      onSuccess: invalidate,
    }),
    updateNote: useMutation({
      mutationFn: ({ id, input }: { id: number; input: DebtRepaymentNoteInput }) => updateDebtRepaymentNote(debtId, id, input),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: number) => deleteDebtRepayment(debtId, id),
      onSuccess: invalidate,
    }),
    reverse: useMutation({
      mutationFn: ({ id, input }: { id: number; input: DebtRepaymentReverseInput }) => reverseDebtRepayment(debtId, id, input),
      onSuccess: invalidate,
    }),
  };
}
