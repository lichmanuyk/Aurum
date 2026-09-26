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
  await expect(page).toHaveURL(/\/transactions\?period=all&end_date=\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByText("dp-link-may-a")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/transactions\?period=all&end_date=\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByText("dp-link-may-a")).toBeVisible();
  await expect(page.getByRole("button", { name: "Всё время", exact: true })).toHaveClass(/bg-surface-2/);

  // Whole year (2019 has both fixtures — proves "every month" isn't
  // narrowed to a single one on the link's destination).
  await page.goto("/");
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2019" }).click();
  await page.getByRole("link", { name: "Все транзакции" }).click();
  await expect(page).toHaveURL(/\/transactions\?year=2019&end_date=\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByText("dp-link-may-a")).toBeVisible();
  await expect(page.getByText("dp-link-may-b")).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/transactions\?year=2019&end_date=\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByRole("button", { name: "Все месяцы", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("dp-link-may-a")).toBeVisible();

  // Specific month — the pre-existing contract, byte-for-byte.
  await page.goto("/");
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: /^\d{4}$/ }).first().click();
  await page.getByRole("option", { name: "2019" }).click();
  await page.getByRole("button", { name: "Май", exact: true }).click();
  await page.getByRole("link", { name: "Все транзакции" }).click();
  await expect(page).toHaveURL(/\/transactions\?year=2019&month=5&end_date=\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByText("dp-link-may-a")).toBeVisible();
  await expect(page.getByText("dp-link-may-b")).toBeVisible();

  // The link never touched the underlying data.
  const exportData = await (await request.get("/api/backup/export")).json();
  const oldTx = exportData.transactions.find((t: { description: string }) => t.description.toLowerCase() === "dp-link-may-a");
  expect(Number(oldTx.amount)).toBe(15);
});

test("a future-dated transaction never shows in Recent Transactions or via its link under \"Всё время\", though a past one does", async ({ page, request }) => {
  const accountId = await getDefaultAccountId(request);
  const salaryId = await getCategoryId(request, "Salary");
  await createTransaction(request, {
    account_id: accountId, category_id: salaryId, type: "income",
    amount: "111.00", description: "dp-alltime-past", date: "2019-06-01",
  });
  await createTransaction(request, {
    account_id: accountId, category_id: salaryId, type: "income",
    amount: "222.00", description: "dp-alltime-future", date: "2099-06-01",
  });

  await page.goto("/");
  const recentCard = page.locator("div.rounded-xl", { has: page.getByText("Последние транзакции", { exact: true }) });
  await expect(recentCard.getByText("dp-alltime-past")).toBeVisible();
  await expect(recentCard.getByText("dp-alltime-future")).toHaveCount(0);

  await page.getByRole("link", { name: "Все транзакции" }).click();
  await expect(page).toHaveURL(/\/transactions\?period=all/);
  await expect(page.getByText("dp-alltime-past")).toBeVisible();
  await expect(page.getByText("dp-alltime-future")).toHaveCount(0);
});

test("a future-dated transaction within the current year never shows under \"Год\"/\"Все месяцы\", though one earlier this year does", async ({ page, request }) => {
  const today = new Date();
  test.skip(today.getMonth() === 11 && today.getDate() === 31, "no room left in the current year to place a synthetic future date");
  test.skip(today.getMonth() === 0 && today.getDate() <= 2, "no room early in the current year to place a synthetic past-but-this-year date");
  const year = today.getFullYear();
  const accountId = await getDefaultAccountId(request);
  const salaryId = await getCategoryId(request, "Salary");
  await createTransaction(request, {
    account_id: accountId, category_id: salaryId, type: "income",
    amount: "111.00", description: "dp-year-past", date: `${year}-01-02`,
  });
  await createTransaction(request, {
    account_id: accountId, category_id: salaryId, type: "income",
    amount: "222.00", description: "dp-year-future", date: `${year}-12-31`,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Год", exact: true }).click();
  const recentCard = page.locator("div.rounded-xl", { has: page.getByText("Последние транзакции", { exact: true }) });
  await expect(recentCard.getByText("dp-year-past")).toBeVisible();
  await expect(recentCard.getByText("dp-year-future")).toHaveCount(0);

  await page.getByRole("link", { name: "Все транзакции" }).click();
  await expect(page).toHaveURL(new RegExp(`/transactions\\?year=${year}&end_date=\\d{4}-\\d{2}-\\d{2}$`));
  await expect(page.getByText("dp-year-past")).toBeVisible();
  await expect(page.getByText("dp-year-future")).toHaveCount(0);
});

test("a future-dated transaction later in the current month never shows in the current month's view, though earlier this month does", async ({ page, request }) => {
  const today = new Date();
  const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  test.skip(today.getDate() >= lastDayOfMonth, "today is already the last day of the month — no room for a synthetic future date");
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const monthLabel = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"][today.getMonth()];
  const accountId = await getDefaultAccountId(request);
  const salaryId = await getCategoryId(request, "Salary");
  await createTransaction(request, {
    account_id: accountId, category_id: salaryId, type: "income",
    amount: "111.00", description: "dp-month-past", date: `${year}-${String(month).padStart(2, "0")}-01`,
  });
  await createTransaction(request, {
    account_id: accountId, category_id: salaryId, type: "income",
    amount: "222.00", description: "dp-month-future", date: `${year}-${String(month).padStart(2, "0")}-${String(lastDayOfMonth).padStart(2, "0")}`,
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Год", exact: true }).click();
  await page.getByRole("button", { name: monthLabel, exact: true }).click();
  const recentCard = page.locator("div.rounded-xl", { has: page.getByText("Последние транзакции", { exact: true }) });
  await expect(recentCard.getByText("dp-month-past")).toBeVisible();
  await expect(recentCard.getByText("dp-month-future")).toHaveCount(0);

  await page.getByRole("link", { name: "Все транзакции" }).click();
  await expect(page).toHaveURL(new RegExp(`/transactions\\?year=${year}&month=${month}`));
  await expect(page.getByText("dp-month-past")).toBeVisible();
  await expect(page.getByText("dp-month-future")).toHaveCount(0);
});

test("a boundary transaction is included/excluded consistently everywhere even when the browser's own clock/timezone disagrees with the server's", async ({ request, browser }) => {
  // This is the one test in the file dating a fixture exactly on "today"
  // — every other test here uses a safely past/far-future date — so
  // unlike its siblings it must clean up after itself, or a `today`-dated
  // leftover income would throw off any *other* suite's own same-day
  // total (e.g. zz-multicurrency.spec.ts's cash-flow-for-today check).
  const snapshot = await (await request.get("/api/backup/export")).json();
  try {
    // The server (not the browser) resolves "today" for the boundary —
    // see docs/tasks/dashboard-periods.md's review notes on the
    // client/server timezone mismatch this test guards against. Read it
    // from the API instead of assuming any particular date, so this test
    // is correct regardless of which real day it happens to run on.
    const before = await (await request.get("/api/dashboard/summary", { params: { period: "all" } })).json();
    const serverEndDate: string = before.end_date;
    const dayAfter = new Date(`${serverEndDate}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    const dayAfterIso = dayAfter.toISOString().slice(0, 10);

    const accountId = await getDefaultAccountId(request);
    const salaryId = await getCategoryId(request, "Salary");
    await createTransaction(request, {
      account_id: accountId, category_id: salaryId, type: "income",
      amount: "111.00", description: "dp-boundary-included", date: serverEndDate,
    });
    await createTransaction(request, {
      account_id: accountId, category_id: salaryId, type: "income",
      amount: "222.00", description: "dp-boundary-excluded", date: dayAfterIso,
    });

    // A delta against `before`, not an absolute figure — this file's
    // other tests never isolate their own fixtures from each other (a
    // shared DB across the whole run), so "Всё время" already carries
    // prior totals by the time this test runs.
    const after = await (await request.get("/api/dashboard/summary", { params: { period: "all" } })).json();
    expect(Number(after.real_income) - Number(before.real_income)).toBe(111);

    // A dedicated context (timezoneId is context-creation-time-only in
    // Playwright, unlike the clock) so only this test's page believes
    // it's already `dayAfter` in Europe/Warsaw local time, at a moment
    // (23:30 UTC on serverEndDate) when Warsaw's own wall clock
    // (UTC+1/+2) has already rolled over to the next day while the
    // server is still on serverEndDate — exactly the mismatch reported.
    // If the fix worked, the browser's own (wrong, from the server's
    // perspective) notion of "today" never enters the boundary decision
    // at all. A raw browser.newContext() doesn't inherit
    // playwright.config.ts's own `use` block (that's only applied to the
    // fixture-provided `page`), so baseURL and the no-auth-modal storage
    // flag are repeated here.
    const baseURL = process.env.AURUM_E2E_BASE_URL ?? "http://localhost:3100";
    const context = await browser.newContext({
      timezoneId: "Europe/Warsaw",
      baseURL,
      storageState: { cookies: [], origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: "aurum:noAuthAcknowledged", value: "1" }] }] },
    });
    const page = await context.newPage();
    await page.route("**/api/fx-rates/nbp/latest", (route) => route.fulfill({ json: { saved: 0, absent_currencies: [] } }));
    await page.clock.install({ time: new Date(`${serverEndDate}T23:30:00Z`) });

    try {
      await page.goto("/");
      const recentCard = page.locator("div.rounded-xl", { has: page.getByText("Последние транзакции", { exact: true }) });
      await expect(recentCard.getByText("dp-boundary-included")).toBeVisible();
      await expect(recentCard.getByText("dp-boundary-excluded")).toHaveCount(0);

      await page.getByRole("link", { name: "Все транзакции" }).click();
      await expect(page.getByText("dp-boundary-included")).toBeVisible();
      await expect(page.getByText("dp-boundary-excluded")).toHaveCount(0);

      await page.reload();
      await expect(page.getByText("dp-boundary-included")).toBeVisible();
      await expect(page.getByText("dp-boundary-excluded")).toHaveCount(0);
    } finally {
      await context.close();
    }
  } finally {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
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
