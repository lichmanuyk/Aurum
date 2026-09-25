import { test, expect } from "../fixtures";
import { createTransaction, getCategoryId, getDefaultAccountId } from "./helpers";

// See docs/tasks/dashboard-periods.md: "Всё время" is now the Dashboard's
// default period, "Год" reveals a month/year picker with "Все месяцы" and
// no future months, and the four stat cards / category breakdown / recent
// transactions / "all transactions" link all share whichever period is
// selected — including the two new modes surviving a reload on Reports'
// sibling page, Transactions. Currency/FX handling for the same endpoint
// is already covered elsewhere (p1-date-fx.spec.ts, summary-currency.spec.ts);
// this file is about the period model itself.

test("Dashboard opens on \"Всё время\" by default, showing old activity with no month/year picker in sight", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const salaryId = await getCategoryId(request, "Salary");
  await createTransaction(request, {
    account_id: accountId, category_id: salaryId, type: "income",
    amount: "999.00", description: "dp-all-time-old-income", date: "2018-01-01",
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Всё время", exact: true })).toHaveClass(/bg-surface-2/);
  await expect(page.getByRole("button", { name: /^\d{4}$/ })).toHaveCount(0);
  await expect(page.locator('xpath=//p[text()="Реальный доход"]/following-sibling::p[1]')).toContainText("999");
});

test("\"Год\" defaults to the current year with every month included, and never offers a future month", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Год", exact: true }).click();

  const now = new Date();
  await expect(page.getByRole("button", { name: String(now.getFullYear()), exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Все месяцы", exact: true })).toHaveAttribute("aria-pressed", "true");

  const monthButtons = page.getByRole("button", { name: /^(Янв|Фев|Мар|Апр|Май|Июн|Июл|Авг|Сен|Окт|Ноя|Дек)$/ });
  // maxMonth = the current month — exactly this many pills, not 12.
  await expect(monthButtons).toHaveCount(now.getMonth() + 1);
});

test("switching from a past year's valid month to the current year resets to \"Все месяцы\" instead of keeping a now-future month", async ({ page }) => {
  const now = new Date();
  const currentMonthCount = now.getMonth() + 1;
  test.skip(currentMonthCount >= 12, "no future month exists in the current year to reset away from");
  const pastYear = now.getFullYear() - 1;
  const futureMonthLabel = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"][currentMonthCount]; // 0-indexed -> the month right after the current one

  await page.goto("/");
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: String(pastYear) }).click();
  await page.getByRole("button", { name: futureMonthLabel, exact: true }).click();
  await expect(page.getByRole("button", { name: futureMonthLabel, exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: String(pastYear), exact: true }).click();
  await page.getByRole("option", { name: String(now.getFullYear()) }).click();
  await expect(page.getByRole("button", { name: "Все месяцы", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("all three period modes' \"all transactions\" link opens the matching set on Transactions and survives a reload", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const groceriesId = await getCategoryId(request, "Groceries");
  await createTransaction(request, {
    account_id: accountId, category_id: groceriesId, type: "expense",
    amount: "15.00", description: "dp-link-may-a", date: "2019-05-10",
  });
  await createTransaction(request, {
    account_id: accountId, category_id: groceriesId, type: "expense",
    amount: "25.00", description: "dp-link-may-b", date: "2019-05-11",
  });

  // All time.
  await page.goto("/");
  await page.getByRole("link", { name: "Все транзакции" }).click();
  await expect(page).toHaveURL(/\/transactions\?period=all/);
  await expect(page.getByText("dp-link-may-a")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/transactions\?period=all/);
  await expect(page.getByText("dp-link-may-a")).toBeVisible();
  await expect(page.getByRole("button", { name: "Всё время", exact: true })).toHaveClass(/bg-surface-2/);

  // Whole year (2019 has both fixtures — proves "every month" isn't
  // narrowed to a single one on the link's destination).
  await page.goto("/");
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2019" }).click();
  await page.getByRole("link", { name: "Все транзакции" }).click();
  await expect(page).toHaveURL(/\/transactions\?year=2019$/);
  await expect(page.getByText("dp-link-may-a")).toBeVisible();
  await expect(page.getByText("dp-link-may-b")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/transactions\?year=2019$/);
  await expect(page.getByRole("button", { name: "Все месяцы", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("dp-link-may-a")).toBeVisible();

  // Specific month — the pre-existing contract, byte-for-byte.
  await page.goto("/");
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2019" }).click();
  await page.getByRole("button", { name: "Май", exact: true }).click();
  await page.getByRole("link", { name: "Все транзакции" }).click();
  await expect(page).toHaveURL(/\/transactions\?year=2019&month=5/);
  await expect(page.getByText("dp-link-may-a")).toBeVisible();
  await expect(page.getByText("dp-link-may-b")).toBeVisible();

  // The link never touched the underlying data.
  const exportData = await (await request.get("/api/backup/export")).json();
  const oldTx = exportData.transactions.find((t: { description: string }) => t.description.toLowerCase() === "dp-link-may-a");
  expect(Number(oldTx.amount)).toBe(15);
});

test("period pills and month/year pickers work on a narrow (phone-width) viewport with a real keyboard", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const salaryId = await getCategoryId(request, "Salary");
  await createTransaction(request, {
    account_id: accountId, category_id: salaryId, type: "income",
    amount: "321.00", description: "dp-narrow-income", date: "2021-02-10",
  });

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  const yearPill = page.getByRole("button", { name: "Год", exact: true });
  await expect(yearPill).toBeVisible();
  await yearPill.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^\d{4}$/ })).toBeVisible();

  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2021" }).click();
  const febButton = page.getByRole("button", { name: "Фев", exact: true });
  await febButton.focus();
  await page.keyboard.press("Enter");
  await expect(febButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("321", { exact: false }).first()).toBeVisible();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
});
