import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createBudget, deleteBudget, fetchBudgetStatus, fetchBudgets, updateBudget } from "@/api/budgets";
import type { BudgetInput } from "@/types";

function useInvalidateBudgets() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["budgets"] });
    queryClient.invalidateQueries({ queryKey: ["budget-status"] });
    queryClient.invalidateQueries({ queryKey: ["financial-alerts"] });
  };
}

export function useBudgets() {
  return useQuery({ queryKey: ["budgets"], queryFn: fetchBudgets });
}

/** `options.enabled` (default true) — pass `false` while the caller's own
 * period (year/month) hasn't resolved yet (see pages/BudgetPage.tsx's own
 * business-date-seeded default) so this never fires with a placeholder. */
export function useBudgetStatus(year: number, month: number, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["budget-status", year, month],
    queryFn: () => fetchBudgetStatus(year, month),
    enabled: options?.enabled,
  });
}

export function useCreateBudget() {
  const invalidate = useInvalidateBudgets();
  return useMutation({
    mutationFn: (input: BudgetInput) => createBudget(input),
    onSuccess: invalidate,
  });
}

export function useUpdateBudget() {
  const invalidate = useInvalidateBudgets();
  return useMutation({
    mutationFn: ({ id, monthlyLimit }: { id: number; monthlyLimit: string }) => updateBudget(id, monthlyLimit),
    onSuccess: invalidate,
  });
}

export function useDeleteBudget() {
  const invalidate = useInvalidateBudgets();
  return useMutation({
    mutationFn: (id: number) => deleteBudget(id),
    onSuccess: invalidate,
  });
}
