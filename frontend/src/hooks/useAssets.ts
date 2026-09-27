import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addAssetValuation,
  createAsset,
  deleteAsset,
  fetchAssetExpenses,
  fetchAssets,
  updateAsset,
  type AssetExpenseFilters,
} from "@/api/assets";
import type { AssetInput, AssetUpdateInput, AssetValuationInput } from "@/types";

function useInvalidateNetWorth() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ["assets"] });
    queryClient.invalidateQueries({ queryKey: ["net-worth-summary"] });
  };
}

/** `currency` should be the Net Worth section's own display currency (see
 * useSectionCurrency) — that's what makes each asset's `capital_value`
 * comparable to what the capital summary itself shows as "current". */
export function useAssets(currency?: string) {
  return useQuery({ queryKey: ["assets", currency], queryFn: () => fetchAssets(currency) });
}

export function useCreateAsset() {
  const invalidate = useInvalidateNetWorth();
  return useMutation({
    mutationFn: (input: AssetInput) => createAsset(input),
    onSuccess: invalidate,
  });
}

export function useUpdateAsset() {
  const invalidate = useInvalidateNetWorth();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: AssetUpdateInput }) => updateAsset(id, input),
    onSuccess: invalidate,
  });
}

export function useAddAssetValuation() {
  const invalidate = useInvalidateNetWorth();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: AssetValuationInput }) => addAssetValuation(id, input),
    onSuccess: invalidate,
  });
}

export function useDeleteAsset() {
  const invalidate = useInvalidateNetWorth();
  return useMutation({
    mutationFn: (id: number) => deleteAsset(id),
    onSuccess: invalidate,
  });
}

/** One manually-tracked asset's own "Expenses" view (period total, recent
 * payments, linked templates) — see docs/tasks/property-expense-links.md.
 * `enabled` lets the caller defer the request until a dialog is actually
 * open (assetId is only known once the user picked an asset row). */
export function useAssetExpenses(assetId: number | null, filters: AssetExpenseFilters) {
  return useQuery({
    queryKey: ["asset-expenses", assetId, filters],
    queryFn: () => fetchAssetExpenses(assetId as number, filters),
    enabled: assetId !== null,
  });
}
