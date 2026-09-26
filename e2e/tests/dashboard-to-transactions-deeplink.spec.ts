import { test, expect } from "../fixtures";
import { createTransaction, getCategoryId, getDefaultAccountId } from "./helpers";

// Regression for v0.17.1: the "All transactions" link on Dashboard always
// went to /transactions with no params, so it silently reset to the
// current month even if you were looking at a different one. It should
// carry the selected year/month through as query params. See UPDATES.md
// (v0.17.1) and frontend/src/components/dashboard/RecentTransactionsCard.tsx.
test("Dashboard's All transactions link opens Transactions on the same month", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const categoryId = await getCategoryId(request, "Groceries");
  await createTransaction(request, {
    account_id: accountId,
    category_id: categoryId,
    type: "expense",
    amount: "42.00",
    description: "2018-march-txn",
    date: "2018-03-15",
  });

  await page.goto("/");
  // Fresh open defaults to "Всё время" — switch to "Год" mode first to
  // reveal the month/year pickers at all (see docs/tasks/dashboard-periods.md).
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2018" }).click();
  await page.getByRole("button", { name: "Мар", exact: true }).click();

  await page.getByRole("link", { name: "Все транзакции" }).click();

  await expect(page).toHaveURL(/\/transactions\?year=2018&month=3/);
  await expect(page.getByRole("button", { name: "2018", exact: true })).toBeVisible();
  await expect(page.getByText("2018-march-txn")).toBeVisible();
});
