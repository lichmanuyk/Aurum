import { afterEach, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { DebtsTable } from "./DebtsTable";
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
const noop = () => undefined;

function render(items: Debt[], today = "2024-06-01") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<DebtsTable items={items} today={today} onEdit={noop} onDelete={noop} onRepayments={noop} />));
}

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

it("flags an active debt past its due date as overdue, never a settled one", () => {
  render([
    makeDebt({ id: 1, due_date: "2024-01-01", status: "active" }),
    makeDebt({ id: 2, due_date: "2024-01-01", status: "settled" }),
  ]);

  const items = container.querySelectorAll("li");
  expect(items[0].textContent).toMatch(/Просрочен/);
  expect(items[1].textContent).not.toMatch(/Просрочен/);
});

it("disables delete once a debt has any repayment, so a 409 is never the user's first signal", () => {
  render([makeDebt({ id: 1, repayment_count: 3 })]);
  const deleteButton = container.querySelector('button[aria-label$="Удалить"]') as HTMLButtonElement;
  expect(deleteButton.disabled).toBe(true);
});

it("leaves delete enabled for a fresh, never-used debt", () => {
  render([makeDebt({ id: 1, repayment_count: 0 })]);
  const deleteButton = container.querySelector('button[aria-label$="Удалить"]') as HTMLButtonElement;
  expect(deleteButton.disabled).toBe(false);
});

it("calls onRepayments with the row's own debt when its history button is clicked", () => {
  const onRepayments = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const debt = makeDebt({ id: 7 });
  flushSync(() => root.render(<DebtsTable items={[debt]} today="2024-06-01" onEdit={noop} onDelete={noop} onRepayments={onRepayments} />));
  const button = container.querySelector('button[aria-label$="Возврат / история"]') as HTMLButtonElement;
  flushSync(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onRepayments).toHaveBeenCalledWith(debt);
});
