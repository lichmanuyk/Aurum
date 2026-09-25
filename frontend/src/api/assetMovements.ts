import { api } from "@/api/client";
import type { AssetMovement, AssetMovementInput } from "@/types";

export const fetchAssetMovements = (assetId: number) =>
  api.get<AssetMovement[]>(`/asset-movements?asset_id=${assetId}`);
export const createAssetMovement = (input: AssetMovementInput) =>
  api.post<AssetMovement>("/asset-movements", input);
export const updateAssetMovement = (id: number, input: AssetMovementInput) =>
  api.put<AssetMovement>(`/asset-movements/${id}`, input);
export const deleteAssetMovement = (id: number) =>
  api.delete<void>(`/asset-movements/${id}`);
