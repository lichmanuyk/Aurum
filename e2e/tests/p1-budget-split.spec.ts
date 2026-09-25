import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('a split purchase updates parent and child budgets, then clears on edit and delete', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-10`;
  try {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    expect((await request.patch('/api/settings', { data: { currency: 'USD' } })).ok()).toBeTruthy();
    const account = await (await request.post('/api/accounts', { data: { name: 'P1 budget account', currency: 'USD' } })).json();
    const parent = (await (await request.get('/api/categories')).json()).find((row: { name: string }) => row.name === 'Groceries');
    const child = await (await request.post('/api/categories', { data: { name: 'P1 Sweets', kind: 'expense', color: '#7a869a', parent_id: parent.id } })).json();
    expect((await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'adjustment', amount: '500', adjustment_reason: 'opening_balance',
      description: 'P1 opening', date,
    } })).ok()).toBeTruthy();

    const read = async (path: string) => (await requestWithRateLimit(request, path)).json();
    const balances = async () => Number((await read('/api/accounts')).find((row: { id: number }) => row.id === account.id).balance);
    const status = async () => (await read(`/api/budgets/status?year=${now.getFullYear()}&month=${now.getMonth() + 1}`)).items;
    const spent = async (id: number) => Number((await status()).find((row: { category_id: number }) => row.category_id === id).spent);

    await page.goto('/budget');
    for (const [id, limit] of [[parent.id, '120'], [child.id, '40']] as const) {
      await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
      const form = page.getByRole('dialog');
      await form.locator('#budget-category').selectOption(String(id));
      await form.locator('#budget-limit').fill(limit);
      await form.getByRole('button', { name: /Сохранить|Save/ }).click();
      await expect(form).toBeHidden();
    }
    expect(await spent(parent.id)).toBe(0);
    expect(await spent(child.id)).toBe(0);

    await page.goto('/transactions');
    await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
    const form = page.getByRole('dialog');
    await form.locator('#type').selectOption('expense');
    await form.locator('#account').selectOption(String(account.id));
    await form.locator('#amount').fill('100');
    await form.locator('#description').fill('P1 split receipt');
    await form.locator('#date').fill(date);
    await form.getByRole('button', { name: /Разбить на несколько категорий|Split across multiple categories/ }).click();
    await form.locator('#category').selectOption(String(parent.id));
    const parts = form.getByRole('combobox', { name: /Выберите категорию|Select a category/ });
    await parts.nth(0).selectOption(String(parent.id));
    await parts.nth(1).selectOption(String(child.id));
    const amounts = form.locator('input[type="number"][step="0.000001"]');
    await amounts.nth(1).fill('70');
    await amounts.nth(2).fill('30');
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();
    const row = page.locator('li').filter({ hasText: 'P1 split receipt' });
    await expect(row).toBeVisible();
    expect(await balances()).toBe(400);
    expect(await spent(parent.id)).toBe(100);
    expect(await spent(child.id)).toBe(30);

    await row.getByRole('button', { name: /Изменить|Edit/ }).click();
    await form.locator('#amount').fill('80');
    await form.locator('input[type="number"][step="0.000001"]').nth(1).fill('50');
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();
    await expect.poll(balances).toBe(420);
    expect(await spent(parent.id)).toBe(80);
    expect(await spent(child.id)).toBe(30);

    page.once('dialog', confirmation => confirmation.accept());
    await row.getByRole('button', { name: /Удалить|Delete/ }).click();
    await expect(row).toHaveCount(0);
    await expect.poll(balances).toBe(500);
    expect(await spent(parent.id)).toBe(0);
    expect(await spent(child.id)).toBe(0);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
