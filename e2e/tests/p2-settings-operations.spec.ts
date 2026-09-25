import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('display currency and alert thresholds persist without changing native money', async ({ page, request }) => {
  test.setTimeout(60000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  const today = new Date().toISOString().slice(0, 10);
  try {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    expect((await request.patch('/api/settings', { data: { currency: 'USD' } })).ok()).toBeTruthy();
    const account = await (await request.post('/api/accounts', { data: { name: 'P2 native USD', currency: 'USD' } })).json();
    expect((await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'income', amount: '123.45', date: today, description: 'P2 settings income',
    } })).ok()).toBeTruthy();
    const before = await (await requestWithRateLimit(request, '/api/backup/export')).json();

    await page.goto('/settings');
    const currencyCard = page.locator('div.rounded-xl').filter({ has: page.getByText(/Основная валюта|Primary currency/, { exact: true }) });
    await currencyCard.getByRole('combobox').selectOption('PLN');
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).currency).toBe('PLN');
    await page.locator('#cash-flow-threshold').fill('3');
    await page.locator('#cash-flow-threshold').blur();
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).negative_cash_flow_threshold_months).toBe(3);
    await page.locator('#idle-cash-amount-threshold').fill('2500');
    await page.locator('#idle-cash-amount-threshold').blur();
    await expect.poll(async () => Number((await (await request.get('/api/settings')).json()).idle_cash_threshold_amount)).toBe(2500);

    await page.reload();
    await expect(currencyCard.getByRole('combobox')).toHaveValue('PLN');
    await expect(page.locator('#cash-flow-threshold')).toHaveValue('3');
    await expect(page.locator('#idle-cash-amount-threshold')).toHaveValue('2500.00');
    const after = await (await requestWithRateLimit(request, '/api/backup/export')).json();
    expect(after.accounts).toEqual(before.accounts);
    expect(after.transactions).toEqual(before.transactions);
    const accounts = await (await requestWithRateLimit(request, '/api/accounts')).json();
    const native = accounts.find((row: { id: number }) => row.id === account.id);
    expect(native.currency).toBe('USD');
    expect(Number(native.balance)).toBe(123.45);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
