import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createAssetMovement, deleteAssetMovement, fetchAssetMovements, updateAssetMovement } from "@/api/assetMovements";
import type { AssetMovementInput } from "@/types";

export function useAssetMovements(assetId: number | null) {
  return useQuery({ queryKey: ["asset-movements", assetId], queryFn: () => fetchAssetMovements(assetId!), enabled: assetId !== null });
}

export function useAssetMovementActions() {
  const client = useQueryClient();
  const refresh = () => {
    for (const key of ["asset-movements", "assets", "accounts", "transactions", "dashboard-summary", "cash-flow", "net-worth-summary", "crypto-holdings", "crypto-transactions", "crypto-history", "alerts", "advice"]) {
      client.invalidateQueries({ queryKey: [key] });
    }
  };
  return {
    create: useMutation({ mutationFn: createAssetMovement, onSuccess: refresh }),
    update: useMutation({ mutationFn: ({ id, input }: { id: number; input: AssetMovementInput }) => updateAssetMovement(id, input), onSuccess: refresh }),
    remove: useMutation({ mutationFn: deleteAssetMovement, onSuccess: refresh }),
  };
}
