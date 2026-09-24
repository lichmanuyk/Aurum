import { api } from "@/api/client";
import type { RecurringTransaction, RecurringTransactionInput } from "@/types";

export function fetchRecurring() {
  return api.get<RecurringTransaction[]>("/recurring");
}

export function createRecurring(input: RecurringTransactionInput) {
  return api.post<RecurringTransaction>("/recurring", input);
}

export function updateRecurring(id: number, input: Partial<RecurringTransactionInput>) {
  return api.patch<RecurringTransaction>(`/recurring/${id}`, input);
}

export function deleteRecurring(id: number) {
  return api.delete<void>(`/recurring/${id}`);
}

export function postRecurring(id: number, destination_amount?: string) {
  return api.post<RecurringTransaction>(`/recurring/${id}/post`, { destination_amount });
}
