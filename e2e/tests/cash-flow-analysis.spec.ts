import { test, expect } from "../fixtures";
import { createTransaction, getDefaultAccountId, getCategoryId } from "./helpers";

// See docs/tasks/cash-flow-analysis.md: independent income/expense toggles
// on the Cash Flow chart, and the two per-kind category lists that link out
// to Reports. Currency/period handling for these same endpoints is already
// covered end to end by cash-flow-reports-currency.spec.ts; this file
// covers what's new here: the toggles' own behavior (incl. the "both
// hidden" empty state), the lists' sorting/percentages, and that the link
// to Reports survives a reload without touching native transaction data.

test("income/expense toggles are independently keyboard and mouse operable, and hiding both shows an explicit empty state instead of a blank chart", async ({ page, request }) => {
  const snapshot = await (await request.get("/api/backup/export")).json();
  try {
    const accountId = await getDefaultAccountId(request);
    const salaryId = await getCategoryId(request, "Salary");
    const groceriesId = await getCategoryId(request, "Groceries");
    const today = new Date().toISOString().slice(0, 10);
    await createTransaction(request, { account_id: accountId, category_id: salaryId, type: "income", amount: "1000.00", description: "toggle-fixture-income", date: today });
    await createTransaction(request, { account_id: accountId, category_id: groceriesId, type: "expense", amount: "300.00", description: "toggle-fixture-expense", date: today });

    await page.goto("/cash-flow");
    const cashFlowCard = page.locator("div.rounded-xl").filter({ has: page.getByRole("heading", { name: "Движение денег" }) });
    const summaryLine = cashFlowCard.locator("p").filter({ hasText: "Доход" });
    const chart = cashFlowCard.locator(".recharts-wrapper");
    await expect(chart).toBeVisible();

    const incomeToggle = page.getByRole("button", { name: "Доход", exact: true });
    const expenseToggle = page.getByRole("button", { name: "Расход", exact: true });
    await expect(incomeToggle).toHaveAttribute("aria-pressed", "true");
    await expect(expenseToggle).toHaveAttribute("aria-pressed", "true");

    // Mouse: hiding income leaves expense (and the chart itself) untouched.
    await incomeToggle.click();
    await expect(incomeToggle).toHaveAttribute("aria-pressed", "false");
    await expect(expenseToggle).toHaveAttribute("aria-pressed", "true");
    await expect(chart).toBeVisible();
    await expect(summaryLine).toContainText(/1.000/); // period total is unaffected by hiding a row

    // Keyboard: focus + Enter on the remaining toggle hides it too.
    await expenseToggle.focus();
    await page.keyboard.press("Enter");
    await expect(expenseToggle).toHaveAttribute("aria-pressed", "false");
    await expect(chart).toBeHidden();
    await expect(cashFlowCard.getByText("Доходы и расходы скрыты")).toBeVisible();
    // The total stays exactly as before, even with both rows hidden.
    await expect(summaryLine).toContainText(/1.000/);

    // Turning one back on (keyboard again) restores the chart.
    await page.keyboard.press("Enter");
    await expect(chart).toBeVisible();
  } finally {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test("income and expense category lists sort descending with per-list percentages, and a row's link to Reports survives a reload without altering native amounts", async ({ page, request }) => {
  const snapshot = await (await request.get("/api/backup/export")).json();
  try {
    const accountId = await getDefaultAccountId(request);
    const salaryId = await getCategoryId(request, "Salary");
    const groceriesId = await getCategoryId(request, "Groceries");
    const giftResp = await request.post("/api/categories", { data: { name: "Gifts CF", kind: "income", color: "#7a869a" } });
    const giftId = (await giftResp.json()).id;
    const today = new Date().toISOString().slice(0, 10);
    await createTransaction(request, { account_id: accountId, category_id: salaryId, type: "income", amount: "700.00", description: "cf-list-income-big", date: today });
    await createTransaction(request, { account_id: accountId, category_id: giftId, type: "income", amount: "300.00", description: "cf-list-income-small", date: today });
    await createTransaction(request, { account_id: accountId, category_id: groceriesId, type: "expense", amount: "120.00", description: "cf-list-expense", date: today });

    await page.goto("/cash-flow");
    const incomeCard = page.locator("div.rounded-xl").filter({ has: page.getByRole("heading", { name: "Доходы по категориям" }) });
    const expenseCard = page.locator("div.rounded-xl").filter({ has: page.getByRole("heading", { name: "Расходы по категориям" }) });
    await expect(incomeCard.getByText("Зарплата")).toBeVisible();
    await expect(incomeCard.getByText("Gifts CF")).toBeVisible();

    // Descending by amount: Salary/"Зарплата" (700, 70%) above Gifts CF (300, 30%).
    const incomeRows = incomeCard.locator("li");
    await expect(incomeRows.first()).toContainText("Зарплата");
    await expect(incomeRows.first()).toContainText("70%");
    await expect(incomeRows.nth(1)).toContainText("Gifts CF");
    await expect(incomeRows.nth(1)).toContainText("30%");

    // The backend title-cases descriptions on save, so match case-insensitively.
    const findExpenseTx = (transactions: Array<{ description: string; amount: string }>) =>
      transactions.find((t) => t.description.toLowerCase() === "cf-list-expense");
    const beforeExport = await (await request.get("/api/backup/export")).json();
    const expenseTxBefore = findExpenseTx(beforeExport.transactions);
    expect(Number(expenseTxBefore?.amount)).toBe(120);

    // Clicking the expense row's own link carries category + period to
    // Reports, and reloading there must not lose or mutate anything.
    await expenseCard.getByText("Продукты").click();
    await expect(page).toHaveURL(new RegExp(`/reports\\?category_id=${groceriesId}&range=this_year`));
    await expect(page.locator("#report-category")).toHaveValue(String(groceriesId));
    await expect(page.getByText("cf-list-expense")).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/reports\\?category_id=${groceriesId}&range=this_year`));
    await expect(page.locator("#report-category")).toHaveValue(String(groceriesId));
    await expect(page.getByText("cf-list-expense")).toBeVisible();

    const afterExport = await (await request.get("/api/backup/export")).json();
    const expenseTxAfter = findExpenseTx(afterExport.transactions);
    expect(Number(expenseTxAfter?.amount)).toBe(120); // native amount untouched by navigating + reloading
  } finally {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test("toggles and category lists — including each row's own percentage — work on a narrow (phone-width) viewport without horizontal overflow", async ({ page, request }) => {
  const snapshot = await (await request.get("/api/backup/export")).json();
  try {
    const accountId = await getDefaultAccountId(request);
    const salaryId = await getCategoryId(request, "Salary");
    const giftResp = await request.post("/api/categories", { data: { name: "Gifts CF narrow", kind: "income", color: "#7a869a" } });
    const giftId = (await giftResp.json()).id;
    const today = new Date().toISOString().slice(0, 10);
    await createTransaction(request, { account_id: accountId, category_id: salaryId, type: "income", amount: "700.00", description: "narrow-fixture-income-big", date: today });
    await createTransaction(request, { account_id: accountId, category_id: giftId, type: "income", amount: "300.00", description: "narrow-fixture-income-small", date: today });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/cash-flow");

    const incomeToggle = page.getByRole("button", { name: "Доход", exact: true });
    await expect(incomeToggle).toBeVisible();
    await incomeToggle.click();
    await expect(incomeToggle).toHaveAttribute("aria-pressed", "false");

    await expect(page.getByRole("heading", { name: "Доходы по категориям" })).toBeVisible();
    const incomeCard = page.locator("div.rounded-xl").filter({ has: page.getByRole("heading", { name: "Доходы по категориям" }) });
    const incomeRows = incomeCard.locator("li");
    // Each list's own share stays visible at phone width (only the
    // decorative bar next to it is allowed to drop) — see
    // CategoryRankingCard.tsx.
    await expect(incomeRows.first()).toContainText("Зарплата");
    await expect(incomeRows.first()).toContainText("70%");
    await expect(incomeRows.nth(1)).toContainText("Gifts CF narrow");
    await expect(incomeRows.nth(1)).toContainText("30%");

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  } finally {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test("an expense category whose transactions live only in a subcategory still links to all of them from its ranking row", async ({ page, request }) => {
  const snapshot = await (await request.get("/api/backup/export")).json();
  try {
    const accountId = await getDefaultAccountId(request);
    const groceriesId = await getCategoryId(request, "Groceries");
    const sweetsResp = await request.post("/api/categories", { data: { name: "Sweets CF", kind: "expense", color: "#7a869a", parent_id: groceriesId } });
    const sweetsId = (await sweetsResp.json()).id;
    const today = new Date().toISOString().slice(0, 10);
    // Groceries itself (the parent, and the id the ranking row carries — see
    // category_rollup.py) has no direct transaction at all; the only money
    // is filed under its subcategory.
    await createTransaction(request, { account_id: accountId, category_id: sweetsId, type: "expense", amount: "45.00", description: "cf-sub-only-expense", date: today });

    await page.goto("/cash-flow");
    const expenseCard = page.locator("div.rounded-xl").filter({ has: page.getByRole("heading", { name: "Расходы по категориям" }) });
    const groceriesRow = expenseCard.locator("li").filter({ hasText: "Продукты" });
    await expect(groceriesRow).toContainText("45");

    await groceriesRow.getByText("Продукты").click();
    await expect(page).toHaveURL(new RegExp(`/reports\\?category_id=${groceriesId}&range=this_year&include_subcategories=1`));
    await expect(page.getByText("cf-sub-only-expense")).toBeVisible();
    await expect(page.getByText(/Транзакций не найдено|No transactions found/)).toHaveCount(0);
  } finally {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test("an income category whose transactions live only in a subcategory keeps showing them after a reload on Reports", async ({ page, request }) => {
  const snapshot = await (await request.get("/api/backup/export")).json();
  try {
    const accountId = await getDefaultAccountId(request);
    const salaryId = await getCategoryId(request, "Salary");
    const bonusResp = await request.post("/api/categories", { data: { name: "Bonus CF", kind: "income", color: "#7a869a", parent_id: salaryId } });
    const bonusId = (await bonusResp.json()).id;
    const today = new Date().toISOString().slice(0, 10);
    await createTransaction(request, { account_id: accountId, category_id: bonusId, type: "income", amount: "200.00", description: "cf-sub-only-income", date: today });

    await page.goto("/cash-flow");
    const incomeCard = page.locator("div.rounded-xl").filter({ has: page.getByRole("heading", { name: "Доходы по категориям" }) });
    const salaryRow = incomeCard.locator("li").filter({ hasText: "Зарплата" });
    await expect(salaryRow).toContainText("200");

    await salaryRow.getByText("Зарплата").click();
    await expect(page).toHaveURL(new RegExp(`/reports\\?category_id=${salaryId}&range=this_year&include_subcategories=1`));
    await expect(page.getByText("cf-sub-only-income")).toBeVisible();

    // The subcategory rollup isn't just an in-memory click state — the URL
    // param itself must carry it, or a reload falls back to the exact
    // (parent-only) filter and the row disappears again.
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/reports\\?category_id=${salaryId}&range=this_year&include_subcategories=1`));
    await expect(page.locator("#report-category")).toHaveValue(String(salaryId));
    await expect(page.getByText("cf-sub-only-income")).toBeVisible();
  } finally {
    const restore = await request.post("/api/backup/import", { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
