import { afterEach, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { DebtsSummary } from "./DebtsSummary";
import type { Debt } from "@/types";

function makeDebt(overrides: Partial<Debt> = {}): Debt {
  return {
    id: 1, direction: "owed_to_me", counterparty: "Friend", currency: "USD", principal_amount: "100",
    outstanding_amount: "100", status: "active", start_date: "2024-01-01", due_date: null, note: null,
    funding: "opening_balance", account_id: null, account_name: null, issuance_account_amount: null,
    issuance_account_currency: null, repayment_count: 0, idempotency_key: null,
    created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(debts: Debt[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<DebtsSummary debts={debts} isLoading={false} />));
}

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

it("never sums outstanding across different currencies — one figure per currency, per direction", () => {
  render([
    makeDebt({ id: 1, direction: "owed_to_me", currency: "USD", outstanding_amount: "100" }),
    makeDebt({ id: 2, direction: "owed_to_me", currency: "EUR", outstanding_amount: "50" }),
    makeDebt({ id: 3, direction: "owed_by_me", currency: "PLN", outstanding_amount: "200" }),
  ]);

  const text = container.textContent ?? "";
  expect(text).toMatch(/100/);
  expect(text).toMatch(/50/);
  expect(text).toMatch(/200/);
  // No combined "150" or similar cross-currency sum anywhere.
  expect(text).not.toMatch(/150/);
});

it("a fully repaid (settled) debt's zero outstanding never inflates the total", () => {
  render([
    makeDebt({ id: 1, direction: "owed_by_me", currency: "USD", outstanding_amount: "0", status: "settled" }),
    makeDebt({ id: 2, direction: "owed_by_me", currency: "USD", outstanding_amount: "40" }),
  ]);

  const text = container.textContent ?? "";
  expect(text).toMatch(/40/);
});

it("shows an explicit empty state per direction instead of a blank card", () => {
  render([]);
  const text = container.textContent ?? "";
  expect(text).toMatch(/Нет/);
});
