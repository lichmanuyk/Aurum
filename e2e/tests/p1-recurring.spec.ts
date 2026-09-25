import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('a monthly expense posts once and remains scheduled for the next month', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    const account = await (await request.post('/api/accounts', { data: { name: 'P1 recurring account', currency: 'USD' } })).json();
    expect((await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'adjustment', amount: '100', adjustment_reason: 'opening_balance',
      description: 'P1 recurring opening', date: yesterday,
    } })).ok()).toBeTruthy();

    await page.goto('/recurring');
    await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
    const form = page.getByRole('dialog');
    await form.locator('#recurring-type').selectOption('expense');
    await form.locator('#recurring-frequency').selectOption('monthly');
    await form.locator('#recurring-amount').fill('15');
    await form.locator('#recurring-anchor-date').fill(yesterday);
    await form.locator('#recurring-description').fill('P1 monthly subscription');
    await form.locator('#recurring-account').selectOption(String(account.id));
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();

    const row = page.locator('li').filter({ hasText: 'P1 monthly subscription' });
    const post = row.getByRole('button', { name: /Провести|Post/ });
    await expect(post).toBeEnabled();
    await post.click();
    await expect.poll(async () => {
      const rules = await (await requestWithRateLimit(request, '/api/recurring')).json();
      return rules.find((item: { description: string }) => item.description === 'P1 monthly subscription')?.is_due;
    }).toBe(false);
    await expect(post).toBeDisabled();
    const rules = await (await requestWithRateLimit(request, '/api/recurring')).json();
    const rule = rules.find((item: { description: string }) => item.description === 'P1 monthly subscription');
    expect(rule.is_due).toBe(false);
    expect(rule.next_due_date).not.toBe(yesterday);
    const duplicate = await request.post(`/api/recurring/${rule.id}/post`);
    expect(duplicate.status()).toBe(409);
    const transactions = (await (await requestWithRateLimit(request, '/api/transactions')).json()).items;
    expect(transactions.filter((item: { description: string }) => item.description === 'P1 monthly subscription')).toHaveLength(1);
    const accounts = await (await requestWithRateLimit(request, '/api/accounts')).json();
    expect(Number(accounts.find((item: { id: number }) => item.id === account.id).balance)).toBe(85);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
