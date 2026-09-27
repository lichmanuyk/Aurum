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
  // Required exactly when the template has its own mandatory_payment_kind
  // set (a ZUS/PPE/VAT template) — which month this posting is *for*,
  // independent of the real posting date. See
  // docs/tasks/income-tax-separation.md.
  assigned_period?: string;
}

export function postRecurring(id: number, overrides: RecurringPostOverrides = {}) {
  return api.post<RecurringTransaction>(`/recurring/${id}/post`, overrides);
}
