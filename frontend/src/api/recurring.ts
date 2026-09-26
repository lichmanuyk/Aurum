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

export interface RecurringPostOverrides {
  destination_amount?: string;
  // Expense-template-only actual payment override (see
  // docs/tasks/recurring-variable-payments.md) — the template's own
  // stored amount/account never change, only what gets posted this once.
  amount?: string;
  account_id?: number;
}

export function postRecurring(id: number, overrides: RecurringPostOverrides = {}) {
  return api.post<RecurringTransaction>(`/recurring/${id}/post`, overrides);
}
