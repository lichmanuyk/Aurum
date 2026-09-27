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
