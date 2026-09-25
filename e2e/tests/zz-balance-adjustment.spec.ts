import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('signed opening balance preserves sub-cents and stays out of cash flow', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/backup/export')).json();
  page.setDefaultTimeout(10000);
  try {
    await request.patch('/api/settings', { data: { currency: 'USD' } });
    const name = `Synthetic adjustment ${Date.now()}`;
    const account = await (await request.post('/api/accounts', { data: { name, currency: 'USD' } })).json();
    const before = await (await request.get('/api/cash-flow')).json();
    await page.goto('/transactions');
    await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#type').selectOption('adjustment');
    await dialog.locator('#account').selectOption(String(account.id));
    await dialog.locator('#amount').fill('-10.123456');
    await dialog.locator('#description').fill('Synthetic signed opening');
    await dialog.locator('#adjustment_reason').selectOption('opening_balance');
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(dialog).toBeHidden();
    const row = page.locator('li').filter({ hasText: 'Synthetic signed opening' });
    await expect(row).toContainText(/-10[,.]123456/);
    await expect(row).not.toContainText('+-');
    await row.getByRole('button', { name: /Изменить|Edit/ }).click();
    await dialog.locator('#amount').fill('20.003');
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(dialog).toBeHidden();
    await page.goto('/accounts');
    await expect(page.locator('li').filter({ hasText: name })).toContainText(/20[,.]003/);
    const after = await (await request.get('/api/cash-flow')).json();
    expect(after.total_income).toBe(before.total_income);
    expect(after.total_expense).toBe(before.total_expense);
    const adjusted = await (await request.get('/api/backup/export')).json();
    const saved = adjusted.transactions.find((item: { description: string }) => item.description === 'Synthetic signed opening');
    expect(saved.adjustment_reason).toBe('opening_balance');
    expect((await request.delete(`/api/transactions/${saved.id}`)).ok()).toBeTruthy();
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: adjusted })).ok()).toBeTruthy();
    const restored = await (await request.get('/api/accounts')).json();
    expect(Number(restored.find((item: { id: number }) => item.id === account.id).balance)).toBe(20.003);
    const restoredFlow = await (await request.get('/api/cash-flow')).json();
    expect(restoredFlow.total_income).toBe(before.total_income);
    expect(restoredFlow.total_expense).toBe(before.total_expense);
  } finally {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot })).ok()).toBeTruthy();
  }
});
