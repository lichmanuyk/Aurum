import { expect, it } from "vitest";
import { splitExpense } from "./CashFlowChart";

// Pure arithmetic only — no DOM, no component mount. Exercises the same
// split the chart/header/tooltip all share so the tax-inclusive API
// contract (`expense` = ordinary + `tax_expense`, see CashFlowPoint's own
// docstring in types/index.ts) and the UI's own separate ordinary/taxes
// rows never drift apart.

it("splits the tax-inclusive API expense into its ordinary and tax portions", () => {
  // The docs/tasks/income-tax-separation.md seed case: income 1000, total
  // (tax-inclusive) expense 400, of which 150 is a mandatory tax payment.
  expect(splitExpense("400", "150")).toEqual({ ordinary: 250, tax: 150 });
});

it("returns the full amount as ordinary when there's no tax at all", () => {
  expect(splitExpense("850", "0")).toEqual({ ordinary: 850, tax: 0 });
});

it("accepts numbers as well as the API's own string amounts", () => {
  expect(splitExpense(400, 150)).toEqual({ ordinary: 250, tax: 150 });
});

it("never lets the ordinary portion exceed the tax-inclusive total", () => {
  const { ordinary, tax } = splitExpense("400", "150");
  expect(ordinary + tax).toBe(400);
});
