import { api } from "@/api/client";
import type {
  Debt,
  DebtCreateInput,
  DebtDirection,
  DebtRepayment,
  DebtRepaymentCreateInput,
  DebtRepaymentNoteInput,
  DebtRepaymentReverseInput,
  DebtStatus,
  DebtUpdateInput,
} from "@/types";

/** See docs/tasks/debt-tracking.md and backend/app/api/routes/debts.py —
 * every route here mirrors that file's own shape one to one. */

export function fetchDebts(direction?: DebtDirection | "", status?: DebtStatus | "") {
  const params = new URLSearchParams();
  if (direction) params.set("direction", direction);
  if (status) params.set("status", status);
  const query = params.toString();
  return api.get<Debt[]>(`/debts${query ? `?${query}` : ""}`);
}

export function fetchDebt(id: number) {
  return api.get<Debt>(`/debts/${id}`);
}

export function createDebt(input: DebtCreateInput) {
  return api.post<Debt>("/debts", input);
}

export function updateDebt(id: number, input: DebtUpdateInput) {
  return api.patch<Debt>(`/debts/${id}`, input);
}

export function deleteDebt(id: number) {
  return api.delete<void>(`/debts/${id}`);
}

export function fetchDebtRepayments(debtId: number) {
  return api.get<DebtRepayment[]>(`/debts/${debtId}/repayments`);
}

export function createDebtRepayment(debtId: number, input: DebtRepaymentCreateInput) {
  return api.post<DebtRepayment>(`/debts/${debtId}/repayments`, input);
}

export function updateDebtRepaymentNote(debtId: number, repaymentId: number, input: DebtRepaymentNoteInput) {
  return api.patch<DebtRepayment>(`/debts/${debtId}/repayments/${repaymentId}`, input);
}

export function deleteDebtRepayment(debtId: number, repaymentId: number) {
  return api.delete<void>(`/debts/${debtId}/repayments/${repaymentId}`);
}

export function reverseDebtRepayment(debtId: number, repaymentId: number, input: DebtRepaymentReverseInput) {
  return api.post<DebtRepayment>(`/debts/${debtId}/repayments/${repaymentId}/reverse`, input);
}
