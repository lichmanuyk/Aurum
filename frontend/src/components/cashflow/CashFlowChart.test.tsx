import { afterEach, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { CashFlowChart } from "./CashFlowChart";
import { setCurrency } from "@/lib/i18n";
import type { CashFlowResponse } from "@/types";

const cashFlow: CashFlowResponse = {
  reporting_currency: "USD",
  start_date: "2026-01-01",
  end_date: "2026-02-28",
  points: [
    { year: 2026, month: 1, income: "1000", expense: "400", net: "600" },
    { year: 2026, month: 2, income: "1100", expense: "450", net: "650" },
  ],
  total_income: "2100",
  total_expense: "850",
  total_net: "1250",
};

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  setCurrency("USD");
});

function render() {
  setCurrency("USD");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<CashFlowChart cashFlow={cashFlow} isLoading={false} />));
}

function toggles(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));
}

it("shows both series toggled on by default, each independently keyboard/mouse operable via a real button", () => {
  render();
  const [income, expense] = toggles();
  expect(income.getAttribute("aria-pressed")).toBe("true");
  expect(expense.getAttribute("aria-pressed")).toBe("true");

  // Hiding one leaves the other untouched — independence, not a shared switch.
  flushSync(() => income.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const [incomeAfter, expenseAfter] = toggles();
  expect(incomeAfter.getAttribute("aria-pressed")).toBe("false");
  expect(expenseAfter.getAttribute("aria-pressed")).toBe("true");
});

it("never changes the displayed period total when a row is hidden — visibility is chart-only", () => {
  render();
  expect(container.textContent).toMatch(/2.100/);
  expect(container.textContent).toContain("850");

  const [income] = toggles();
  flushSync(() => income.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  // Same totals still shown after hiding the income bars.
  expect(container.textContent).toMatch(/2.100/);
  expect(container.textContent).toContain("850");
});

it("shows an explicit empty state instead of a blank chart when both rows are hidden", () => {
  render();
  const [income, expense] = toggles();
  flushSync(() => income.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  flushSync(() => expense.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(container.querySelector("svg")).toBeNull();
  expect(container.textContent).toContain("Доходы и расходы скрыты");
});
