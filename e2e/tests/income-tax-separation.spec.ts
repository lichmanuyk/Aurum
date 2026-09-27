import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

// See docs/tasks/income-tax-separation.md: gross work income and mandatory
// ZUS/PPE/VAT payments are additive classifications on ordinary
// income/expense rows, grouped by assigned_period (not the real cash date)
// on a dedicated "Income & Taxes" report — real money movement, account
// balances and every other report's FX/date handling stay untouched.

async function resetToEmpty(request: import('@playwright/test').APIRequestContext) {
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
  return snapshot;
}

test('marking work income and a ZUS payment groups them by assigned month, separate from ordinary spending', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'ITS account', currency: 'USD' } })).json();
    const categories = await (await request.get('/api/categories')).json();
    const salary = categories.find((c: { name: string }) => c.name === 'Salary');
    const groceries = categories.find((c: { name: string }) => c.name === 'Groceries');

    // Gross work income for August, actually received in October — via
    // the ordinary transaction form's new "work income" checkbox.
    await page.goto('/transactions');
    await page.getByRole('button', { name: /Добавить|Add/ }).click();
    let form = page.getByRole('dialog');
    await form.locator('#account').selectOption(String(account.id));
    await form.locator('#type').selectOption('income');
    await form.locator('#amount').fill('1000');
    await form.locator('#date').fill('2026-10-03');
    await form.locator('#description').fill('ITS August invoice');
    await form.locator('#category').selectOption(String(salary.id));
    await form.getByRole('checkbox', { name: /рабочий доход|work income/i }).check();
    await form.locator('#transaction-assigned-period').fill('2026-08');
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();

    // An ordinary expense (no classification) — must never show up as a
    // mandatory payment anywhere.
    await page.getByRole('button', { name: /Добавить|Add/ }).click();
    form = page.getByRole('dialog');
    await form.locator('#account').selectOption(String(account.id));
    await form.locator('#amount').fill('50');
    await form.locator('#date').fill('2026-09-05');
    await form.locator('#description').fill('ITS ordinary groceries');
    await form.locator('#category').selectOption(String(groceries.id));
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();

    // ZUS paid Sept 3 for August — via the expense form's mandatory-
    // payment selector, at 375px (mobile) to confirm it fits and works
    // there too.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: /Добавить|Add/ }).click();
    form = page.getByRole('dialog');
    await form.locator('#account').selectOption(String(account.id));
    await form.locator('#amount').fill('200');
    await form.locator('#date').fill('2026-09-03');
    await form.locator('#description').fill('ITS ZUS');
    await form.locator('#transaction-mandatory-kind').selectOption('zus');
    await form.locator('#transaction-assigned-period').fill('2026-08');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 800 });

    // Dashboard: the ZUS payment is a separate "Mandatory payments" figure,
    // never lumped into ordinary "Spent" (still just the groceries).
    await page.goto('/');
    await expect(page.getByText(/Обязательные платежи|Mandatory payments/)).toBeVisible();

    // Income & Taxes: grouped by assigned month (August), independent of
    // the real cash dates (Oct receipt, Sept payment).
    await page.goto('/income-tax');
    await expect(page.getByText(/август 2026|August 2026/i)).toBeVisible();
    await expect(page.getByText(/1[\s ,.]?000/)).toBeVisible();
    await expect(page.getByText(/\b200\b/)).toBeVisible();
    await page.getByRole('button', { name: /Показать операции|Show transactions/ }).click();
    await expect(page.getByText('ITS August invoice')).toBeVisible();
    await expect(page.getByText('ITS ZUS')).toBeVisible();
    await expect(page.getByText('ITS ordinary groceries')).toHaveCount(0);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('posting a mandatory-tax recurring template requires an assigned month, and never silently defaults it', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'ITS recurring account', currency: 'USD' } })).json();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await request.post('/api/recurring', { data: {
      account_id: account.id, type: 'expense', amount: '300.00', description: 'ITS PPE template',
      frequency: 'monthly', anchor_date: yesterday, mandatory_payment_kind: 'ppe',
    } });

    await page.goto('/recurring');
    const row = page.locator('li').filter({ hasText: 'ITS PPE template' });
    await row.getByRole('button', { name: /Провести|Post/ }).click();

    const modal = page.getByRole('dialog').filter({ hasText: 'ITS PPE template' });
    await expect(modal).toBeVisible();
    const period = modal.locator('#recurring-payment-period');
    await expect(period).toBeVisible();
    await modal.getByRole('button', { name: /Подтвердить оплату|Confirm payment/ }).click();
    // Native `required` on the month input blocks submission until filled —
    // the modal must still be open, nothing posted yet.
    await expect(modal).toBeVisible();
    expect((await (await requestWithRateLimit(request, '/api/transactions')).json()).total).toBe(0);

    await period.fill('2026-08');
    await modal.getByRole('button', { name: /Подтвердить оплату|Confirm payment/ }).click();
    await expect(modal).toBeHidden();

    const transactions = (await (await requestWithRateLimit(request, '/api/transactions')).json()).items;
    const posted = transactions.find((t: { description: string }) => t.description === 'ITS PPE template');
    expect(posted.assigned_period).toBe('2026-08-01');
    expect(posted.mandatory_payment_kind).toBe('ppe');
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('an already-open Income & Taxes report picks up a new tax classification without a full page reload', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'ITS cache account', currency: 'USD' } })).json();

    // Initial load (a real navigation, same as visiting the page fresh) —
    // nothing classified yet.
    await page.goto('/income-tax');
    await expect(page.getByText(/Пока нет отмеченного|No gross work income/)).toBeVisible();

    // Client-side (SPA) navigation away and back via the sidebar — the
    // React Query cache from the first /income-tax visit above survives
    // this (unlike page.goto, which reloads the whole app), so this is
    // exactly the scenario useTransactions.ts's own cache invalidation on
    // create exists for.
    await page.getByRole('link', { name: /Транзакции|Transactions/ }).click();
    await expect(page).toHaveURL(/\/transactions$/);

    await page.getByRole('button', { name: /Добавить|Add/ }).click();
    const form = page.getByRole('dialog');
    await form.locator('#account').selectOption(String(account.id));
    await form.locator('#amount').fill('300');
    await form.locator('#date').fill('2026-09-03');
    await form.locator('#description').fill('ITS cache ZUS');
    await form.locator('#transaction-mandatory-kind').selectOption('zus');
    await form.locator('#transaction-assigned-period').fill('2026-08');
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();

    const reportResponse = page.waitForResponse(r => r.url().includes('/income-tax'));
    await page.getByRole('link', { name: /Доход и налоги|Income & Taxes/ }).click();
    await expect(page).toHaveURL(/\/income-tax$/);
    await reportResponse;

    // The new period shows up right away — no page.reload() anywhere in
    // this test — proving the mutation's own invalidateQueries(["income-tax"])
    // actually forced this remounted page to refetch rather than serving
    // the first visit's now-stale (30s staleTime) empty cache entry back.
    await expect(page.getByText(/август 2026|August 2026/i)).toBeVisible();
    await expect(page.getByText('ITS cache ZUS')).toHaveCount(0); // collapsed by default
    await page.getByRole('button', { name: /Показать операции|Show transactions/ }).click();
    await expect(page.getByText('ITS cache ZUS')).toBeVisible();
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('Income & Taxes requests and renders in the Reports section\'s configured currency, not the ledger\'s raw one', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    await request.patch('/api/settings', { data: { currency: 'PLN', summary_currency: null, reports_currency: null } });
    const account = await (await request.post('/api/accounts', { data: { name: 'ITS currency account', currency: 'PLN' } })).json();
    // A flat PLN/EUR rate on the one date both rows below are dated —
    // avoids needing separate rates per row.
    await request.post('/api/fx-rates/bulk', { data: { items: [
      { base_currency: 'EUR', quote_currency: 'PLN', rate_date: '2026-01-05', rate: '4' },
    ] } });
    await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'income', amount: '1000.00', date: '2026-01-05',
      description: 'ITS currency income', assigned_period: '2026-01-01',
    } });
    await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'expense', amount: '200.00', date: '2026-01-05',
      description: 'ITS currency ZUS', assigned_period: '2026-01-01', mandatory_payment_kind: 'zus',
    } });

    // Still the ledger's own PLN (no override, no summary_currency) at first.
    const plnResponse = page.waitForResponse(r => r.url().includes('/api/income-tax') && r.url().includes('currency=PLN'));
    await page.goto('/income-tax');
    const plnBody = await (await plnResponse).json();
    expect(plnBody.reporting_currency).toBe('PLN');
    await expect(page.getByText(/\b1[\s ,.]?000\b/).first()).toBeVisible();

    // Reports section is overridden to EUR — Income & Taxes must inherit it
    // (lib/displayCurrency.tsx's SECTIONS table) and issue a brand-new
    // request/amount, not silently keep showing the PLN figures above.
    await request.patch('/api/settings', { data: { reports_currency: 'EUR' } });
    const eurResponse = page.waitForResponse(r => r.url().includes('/api/income-tax') && r.url().includes('currency=EUR'));
    await page.reload();
    const eurBody = await (await eurResponse).json();
    expect(eurBody.reporting_currency).toBe('EUR');
    // 1000 PLN / 4 = 250 EUR gross income; 200 PLN / 4 = 50 EUR tax.
    await expect(page.getByText(/\b250\b/).first()).toBeVisible();
    await expect(page.getByText(/\b50\b/).first()).toBeVisible();
    await expect(page.getByText(/\b1[\s ,.]?000\b/)).toHaveCount(0);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('the Year picker offers a year whose only activity is assigned there from a different real-dated year', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'ITS cross-year account', currency: 'USD' } })).json();
    // Real cash date in 2026 (the current business year — see
    // freeze_business_clock's backend-test equivalent of "today"), assigned
    // to December 2025 — the exact "worked in December, paid/received
    // later" example from docs/tasks/income-tax-separation.md, just across
    // a year boundary.
    await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'income', amount: '500.00', date: '2026-01-10',
      description: 'ITS cross-year invoice', assigned_period: '2025-12-01',
    } });

    await page.goto('/income-tax');
    await page.getByRole('button', { name: /^Год$|^Year$/ }).click();

    // Filtered to 2026 (the real cash year) — no period matches at all,
    // but the Year dropdown itself must still offer 2025 (available_years
    // is independent of this filter — see IncomeTaxReport.available_years).
    await expect(page.getByText(/Пока нет отмеченного|No gross work income/)).toBeVisible();
    const yearDropdown = page.getByRole('button', { name: /^\d{4}$/ }).first();
    await expect(yearDropdown).toBeVisible();
    await yearDropdown.click();
    const option2025 = page.getByRole('option', { name: '2025' });
    await expect(option2025).toBeVisible();
    await option2025.click();

    // Selecting it actually navigates there and shows the real period.
    await expect(page.getByText(/декабрь 2025|December 2025/i)).toBeVisible();
    await expect(page.getByText(/\b500\b/).first()).toBeVisible();
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('Cash Flow shows ordinary expense and mandatory taxes as independently toggleable rows, and neither ever changes the header net', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'ITS cash flow account', currency: 'USD' } })).json();
    const categories = await (await request.get('/api/categories')).json();
    const groceries = categories.find((c: { name: string }) => c.name === 'Groceries').id;
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = `${today.slice(0, 7)}-01`;

    await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'income', amount: '1000.00', category_id: null, date: today, description: 'ITS CF income',
    } });
    await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'expense', amount: '250.00', category_id: groceries, date: today, description: 'ITS CF groceries',
    } });
    // Real cash outflow, classified as a mandatory tax payment — API's own
    // `expense`/`total_expense` are inclusive of this (see CashFlowPoint's
    // docstring); the UI now breaks it into its own row.
    await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'expense', amount: '150.00', category_id: null, date: today,
      description: 'ITS CF tax', assigned_period: monthStart, mandatory_payment_kind: 'zus',
    } });

    await page.goto('/cash-flow');
    await page.getByRole('button', { name: /Всё время|All time/, exact: true }).click();

    const incomeToggle = page.getByRole('button', { name: 'Доход', exact: true });
    const expenseToggle = page.getByRole('button', { name: 'Расход', exact: true });
    const taxToggle = page.getByRole('button', { name: 'Налоги', exact: true });
    await expect(incomeToggle).toBeVisible();
    await expect(expenseToggle).toBeVisible();
    await expect(taxToggle).toBeVisible();

    const cashFlowCard = page.locator('div.rounded-xl').filter({ has: page.getByRole('heading', { name: 'Движение денег' }) });
    // The big net figure has no label of its own — just
    // formatSignedCurrency(total_net) — so it's its own <p>, distinct from
    // the income/expense/taxes breakdown line below it.
    const netFigure = cashFlowCard.locator('p.text-2xl');
    const summaryLine = cashFlowCard.locator('p').filter({ hasText: 'Доход' });
    // Ordinary expense (250) and taxes (150) shown separately, income
    // (1000) unaffected by the split; net (600 = 1000 - 400, taxes
    // included) always comes straight from the server, never recomputed
    // client-side from whichever rows happen to be visible.
    await expect(summaryLine).toContainText('250');
    await expect(summaryLine).toContainText('150');
    await expect(netFigure).toContainText('600');

    const chart = cashFlowCard.locator('.recharts-wrapper');
    await expect(chart).toBeVisible();

    // Hiding taxes alone leaves the chart and every header total untouched.
    await taxToggle.click();
    await expect(taxToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(chart).toBeVisible();
    await expect(summaryLine).toContainText('250');
    await expect(summaryLine).toContainText('150');
    await expect(netFigure).toContainText('600');

    // Hiding income and expense too (all three now hidden) shows the
    // tax-aware empty state, with the header net still exactly 600.
    await incomeToggle.click();
    await expenseToggle.click();
    await expect(chart).toBeHidden();
    await expect(cashFlowCard.getByText(/Доходы, расходы и налоги скрыты/)).toBeVisible();
    await expect(netFigure).toContainText('600');
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
