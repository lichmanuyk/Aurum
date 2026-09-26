import { test, expect } from "../fixtures";
import { createTransaction, getCategoryId, getDefaultAccountId } from "./helpers";

// Regression for v0.16.0/v0.16.1: `year` on Dashboard/Transactions/Budget
// used to be `const [year] = useState(...)` — no setter, so no UI could
// ever change it and every page was stuck on the current year forever.
// This asserts switching the year picker actually changes the numbers
// shown, not just that the picker's own visual state updates.
//
// Uses a sub-1000 amount so the assertion doesn't have to guess at
// locale-specific thousands-separator formatting (space vs comma vs none).
test("switching the Dashboard year picker changes the displayed income", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const salaryId = await getCategoryId(request, "Salary");
  await createTransaction(request, {
    account_id: accountId,
    category_id: salaryId,
    type: "income",
    amount: "999.00",
    description: "2017 august salary",
    date: "2017-08-01",
  });

  await page.goto("/");
  // Fresh open defaults to "Всё время" (which would already show the 2017
  // income) — switch to "Год" mode first, landing on the current year with
  // no matching data, so switching the year picker is what's actually
  // exercised below.
  await page.getByRole("button", { name: "Год", exact: true }).click();

  const realIncomeValue = page.locator('xpath=//p[text()="Реальный доход"]/following-sibling::p[1]');
  await expect(realIncomeValue).not.toContainText("999"); // fresh stack: nothing in the current year yet

  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2017" }).click();

  await expect(realIncomeValue).toContainText("999");
});
