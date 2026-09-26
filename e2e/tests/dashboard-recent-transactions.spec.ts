import { test, expect } from "../fixtures";
import { createTransaction, getCategoryId, getDefaultAccountId } from "./helpers";

// Regression for the Aug 2026 bug: RecentTransactionsCard queried
// transactions without year/month at all, so switching the Dashboard's
// month did nothing — it just showed the latest N transactions globally,
// including ones from a completely different month. See UPDATES.md
// (v0.15.3) and frontend/src/components/dashboard/RecentTransactionsCard.tsx.
test("Recent Transactions on Dashboard only shows the selected month", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const categoryId = await getCategoryId(request, "Groceries");

  await createTransaction(request, {
    account_id: accountId,
    category_id: categoryId,
    type: "expense",
    amount: "12.00",
    description: "july-2015-only-txn",
    date: "2015-07-26",
  });
  await createTransaction(request, {
    account_id: accountId,
    category_id: categoryId,
    type: "expense",
    amount: "34.00",
    description: "august-2015-only-txn",
    date: "2015-08-08",
  });

  await page.goto("/");
  // Fresh open defaults to "Всё время" — switch to "Год" mode first to
  // reveal the month/year pickers at all (see docs/tasks/dashboard-periods.md).
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2015" }).click();
  await page.getByRole("button", { name: "Авг", exact: true }).click();

  const recentCard = page.locator("div.rounded-xl", { has: page.getByText("Последние транзакции", { exact: true }) });
  await expect(recentCard.getByText("august-2015-only-txn")).toBeVisible();
  await expect(recentCard.getByText("july-2015-only-txn")).toHaveCount(0);
});
