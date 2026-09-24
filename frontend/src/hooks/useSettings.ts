import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchSettings, updateSettings } from "@/api/settings";
import { setCurrency } from "@/lib/i18n";
import type { AppSettings } from "@/types";

export function useAppSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: fetchSettings });
}

export function useUpdateAppSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<AppSettings>) => updateSettings(input),
    onSuccess: async (data) => {
      await queryClient.cancelQueries();
      queryClient.removeQueries({ predicate: q => q.queryKey[0] !== "settings" });
      queryClient.setQueryData(["settings"], data);
      setCurrency(data.currency);
      await queryClient.invalidateQueries();
    },
  });
}
