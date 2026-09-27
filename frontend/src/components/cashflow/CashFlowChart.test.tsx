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
    { year: 2026, month: 1, income: "1000", expense: "400", tax_expense: "0", net: "600" },
    { year: 2026, month: 2, income: "1100", expense: "450", tax_expense: "0", net: "650" },
  ],
  total_income: "2100",
  total_expense: "850",
  total_tax_expense: "0",
  total_net: "1250",
};

// Single-month period with a mandatory tax payment inside `expense` — the
// seed case from docs/tasks/income-tax-separation.md: income 1000, total
// (tax-inclusive) expense 400, of which 150 is tax, so the UI's own ordinary
// row/bar should read 250, its own taxes row/bar 150, and the header net
// stay the server's 600 (never recomputed client-side, never double-taxed).
const cashFlowWithTax: CashFlowResponse = {
  reporting_currency: "USD",
  start_date: "2026-01-01",
  end_date: "2026-01-31",
  points: [{ year: 2026, month: 1, income: "1000", expense: "400", tax_expense: "150", net: "600" }],
  total_income: "1000",
  total_expense: "400",
  total_tax_expense: "150",
  total_net: "600",
};

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
  setCurrency("USD");
});

function render(data: CashFlowResponse = cashFlow) {
  setCurrency("USD");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root.render(<CashFlowChart cashFlow={data} isLoading={false} />));
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

it("has no taxes row/bar/toggle at all for a period with no tax payments", () => {
  render();
  expect(toggles()).toHaveLength(2);
  expect(container.textContent).not.toContain("Налоги");
});

it("splits the ordinary expense row from a separate taxes row, both real buttons, when the period has tax payments", () => {
  render(cashFlowWithTax);
  const [income, expense, tax] = toggles();
  expect(toggles()).toHaveLength(3);
  // All three default to visible, same as the existing income/expense pair.
  expect(income.getAttribute("aria-pressed")).toBe("true");
  expect(expense.getAttribute("aria-pressed")).toBe("true");
  expect(tax.getAttribute("aria-pressed")).toBe("true");
  expect(tax.textContent).toContain("Налоги");
});

it("shows ordinary expense and taxes as separate header figures — never one lumped, never double-deducted from net", () => {
  render(cashFlowWithTax);
  // Ordinary = 400 (API's tax-inclusive expense) − 150 (tax) = 250; taxes on
  // its own line at 150; net stays the server's 600, not 1000 − 250 − 150
  // (which would coincidentally also be 600 here, but net must come from
  // `total_net` directly rather than being recomputed client-side).
  expect(container.textContent).toContain("250");
  expect(container.textContent).toContain("150");
  expect(container.textContent).toContain("600");
});

it("hiding the taxes row independently leaves income/expense untouched and never changes the header totals", () => {
  render(cashFlowWithTax);
  const before = container.textContent;
  const [, , tax] = toggles();
  flushSync(() => tax.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  const [incomeAfter, expenseAfter, taxAfter] = toggles();
  expect(incomeAfter.getAttribute("aria-pressed")).toBe("true");
  expect(expenseAfter.getAttribute("aria-pressed")).toBe("true");
  expect(taxAfter.getAttribute("aria-pressed")).toBe("false");
  // Same header figures whether the taxes bar is shown or hidden.
  expect(container.textContent).toBe(before);
});

it("shows the tax-aware empty state only once income, expense, AND taxes are all hidden", () => {
  render(cashFlowWithTax);
  const [income, expense, tax] = toggles();
  flushSync(() => income.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  flushSync(() => expense.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  // Two of three hidden — the taxes bar alone still keeps the chart itself
  // (not the empty-state text) on screen. jsdom's zero-size layout means
  // recharts' <ResponsiveContainer> never actually draws an <svg> here
  // (true in every render, chart-empty or not — see the sibling "shows an
  // explicit empty state" test above, which relies on this same fact), so
  // the wrapper it always renders is what tells shown apart from hidden.
  expect(container.querySelector(".recharts-responsive-container")).not.toBeNull();
  expect(container.textContent).not.toContain("Доходы, расходы и налоги скрыты");

  flushSync(() => tax.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(container.querySelector(".recharts-responsive-container")).toBeNull();
  expect(container.textContent).toContain("Доходы, расходы и налоги скрыты");
});
