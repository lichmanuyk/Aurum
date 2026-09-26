import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

// See docs/tasks/recurring-variable-payments.md: confirming an expense
// template's payment opens a small modal for the *actual* amount/account —
// the template's own stored amount/account never change, and no auto-debit
// or second posting happens. Income/transfer keep their prior
// window.prompt-based flow untouched (last test below).

async function resetToEmpty(request: import('@playwright/test').APIRequestContext) {
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
  return snapshot;
}

async function createExpenseTemplate(request: import('@playwright/test').APIRequestContext, accountId: number, overrides: Record<string, unknown> = {}) {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const response = await request.post('/api/recurring', { data: {
    account_id: accountId, type: 'expense', amount: '10.00', description: 'RVP electricity bill',
    frequency: 'monthly', anchor_date: yesterday, ...overrides,
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test('confirming a changed amount/account posts the actual figures and leaves the template untouched', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const accountA = await (await request.post('/api/accounts', { data: { name: 'RVP account A', currency: 'USD' } })).json();
    const accountB = await (await request.post('/api/accounts', { data: { name: 'RVP account B', currency: 'USD' } })).json();
    await createExpenseTemplate(request, accountA.id);

    await page.goto('/recurring');
    const row = page.locator('li').filter({ hasText: 'RVP electricity bill' });
    await row.getByRole('button', { name: /Провести|Post/ }).click();

    const modal = page.getByRole('dialog').filter({ hasText: 'RVP electricity bill' });
    await expect(modal).toBeVisible();
    await modal.locator('#recurring-payment-amount').fill('123.45');
    await modal.locator('#recurring-payment-account').selectOption(String(accountB.id));
    await modal.getByRole('button', { name: /Подтвердить оплату|Confirm payment/ }).click();
    await expect(modal).toBeHidden();

    const accounts = await (await requestWithRateLimit(request, '/api/accounts')).json();
    expect(Number(accounts.find((a: { id: number }) => a.id === accountA.id).balance)).toBe(0);
    expect(Number(accounts.find((a: { id: number }) => a.id === accountB.id).balance)).toBe(-123.45);

    const transactions = (await (await requestWithRateLimit(request, '/api/transactions')).json()).items;
    const posted = transactions.find((t: { description: string }) => t.description === 'RVP electricity bill');
    expect(posted.account_id).toBe(accountB.id);
    expect(Number(posted.amount)).toBe(123.45);

    const recurring = (await (await requestWithRateLimit(request, '/api/recurring')).json())
      .find((r: { description: string }) => r.description === 'RVP electricity bill');
    expect(recurring.account_id).toBe(accountA.id); // template's own account is untouched
    expect(Number(recurring.amount)).toBe(10); // template's own amount is untouched
    expect(recurring.is_due).toBe(false);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('cancelling the payment modal posts nothing and leaves the template due', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'RVP cancel account', currency: 'USD' } })).json();
    await createExpenseTemplate(request, account.id, { description: 'RVP cancel bill' });

    await page.goto('/recurring');
    const row = page.locator('li').filter({ hasText: 'RVP cancel bill' });
    await row.getByRole('button', { name: /Провести|Post/ }).click();

    const modal = page.getByRole('dialog').filter({ hasText: 'RVP cancel bill' });
    await expect(modal).toBeVisible();
    await modal.locator('#recurring-payment-amount').fill('999');
    await modal.getByRole('button', { name: /Отмена|Cancel/ }).click();
    await expect(modal).toBeHidden();

    expect((await (await requestWithRateLimit(request, '/api/transactions')).json()).total).toBe(0);
    const recurring = (await (await requestWithRateLimit(request, '/api/recurring')).json())
      .find((r: { description: string }) => r.description === 'RVP cancel bill');
    expect(recurring.is_due).toBe(true);
    expect(recurring.last_posted_date).toBeNull();
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('the payment modal works with only a keyboard and without overflow at 375px', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'RVP keyboard account', currency: 'USD' } })).json();
    await createExpenseTemplate(request, account.id, { description: 'RVP keyboard bill' });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/recurring');
    const row = page.locator('li').filter({ hasText: 'RVP keyboard bill' });
    await row.getByRole('button', { name: /Провести|Post/ }).click();

    const modal = page.getByRole('dialog').filter({ hasText: 'RVP keyboard bill' });
    await expect(modal).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();

    const amountField = modal.locator('#recurring-payment-amount');
    await amountField.focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('55');
    await page.keyboard.press('Escape'); // Dialog closes on Escape, same as any other modal
    await expect(modal).toBeHidden();

    // Escape cancels, same as clicking Cancel — nothing gets posted.
    expect((await (await requestWithRateLimit(request, '/api/transactions')).json()).total).toBe(0);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('a cross-currency transfer template still posts through its existing window.prompt flow, unaffected by the new expense modal', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const source = await (await request.post('/api/accounts', { data: { name: 'RVP transfer USD', currency: 'USD' } })).json();
    const destination = await (await request.post('/api/accounts', { data: { name: 'RVP transfer EUR', currency: 'EUR' } })).json();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await request.post('/api/recurring', { data: {
      account_id: source.id, type: 'transfer', transfer_account_id: destination.id, amount: '10.00',
      description: 'RVP transfer bill', frequency: 'monthly', anchor_date: yesterday,
    } });

    page.once('dialog', (dialog) => dialog.accept('9.12'));
    await page.goto('/recurring');
    const row = page.locator('li').filter({ hasText: 'RVP transfer bill' });
    await row.getByRole('button', { name: /Провести|Post/ }).click();

    await expect.poll(async () => {
      const rules = await (await requestWithRateLimit(request, '/api/recurring')).json();
      return rules.find((r: { description: string }) => r.description === 'RVP transfer bill')?.is_due;
    }).toBe(false);

    const transactions = (await (await requestWithRateLimit(request, '/api/transactions')).json()).items;
    const posted = transactions.find((t: { description: string }) => t.description === 'RVP transfer bill');
    expect(Number(posted.destination_amount)).toBe(9.12);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
