import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('salary and a shop purchase update the account, monthly reports and capital through edit and delete', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  const now = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-10`;
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 10);
  const prior = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-10`;
  const name = `P0 daily account ${Date.now()}`;
  try {
    expect((await request.post('/api/backup/import', { data: empty })).ok()).toBeTruthy();
    expect((await request.patch('/api/settings', { data: { currency: 'USD' } })).ok()).toBeTruthy();
    const account = await (await request.post('/api/accounts', { data: { name, currency: 'USD' } })).json();
    const categories = await (await request.get('/api/categories')).json();
    const category = (label: string) => categories.find((item: { name: string }) => item.name === label).id;

    const read = async (path: string, params?: Record<string, number>) => {
      const response = await requestWithRateLimit(request, path, { params });
      expect(response.ok(), `${path} ${response.status()}: ${await response.text()}`).toBeTruthy();
      return response.json();
    };
    const summary = async (year: number, month: number) => {
      return read('/api/dashboard/summary', { year, month });
    };
    const balance = async () => {
      const accounts = await read('/api/accounts');
      return Number(accounts.find((item: { id: number }) => item.id === account.id).balance);
    };
    const capital = async () => Number((await read('/api/net-worth/summary')).current);
    const flow = async () => read('/api/cash-flow');
    const spending = async (id: number) => Number((await read('/api/reports/category-spending', { category_id: id })).total_amount);
    const create = async (type: 'income' | 'expense', amount: string, description: string, categoryId: number) => {
      await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('#type').selectOption(type);
      await dialog.locator('#account').selectOption(String(account.id));
      await dialog.locator('#amount').fill(amount);
      await dialog.locator('#date').fill(current);
      await dialog.locator('#description').fill(description);
      await dialog.locator('#category').selectOption(String(categoryId));
      await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('li').filter({ hasText: description })).toBeVisible();
    };

    await page.goto('/transactions');
    await create('income', '1000', 'P0 salary', category('Salary'));
    expect(await balance()).toBe(1000);
    expect(Number((await summary(now.getFullYear(), now.getMonth() + 1)).real_income)).toBe(1000);
    expect(Number((await flow()).total_income)).toBe(1000);
    expect(await capital()).toBe(1000);

    await page.locator('li').filter({ hasText: 'P0 salary' }).getByRole('button', { name: /Изменить|Edit/ }).click();
    await page.getByRole('dialog').locator('#amount').fill('1200');
    await page.getByRole('dialog').getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(await balance()).toBe(1200);
    expect(Number((await summary(now.getFullYear(), now.getMonth() + 1)).real_income)).toBe(1200);
    expect(Number((await flow()).total_income)).toBe(1200);
    expect(await capital()).toBe(1200);

    await create('expense', '80', 'P0 shop', category('Groceries'));
    expect(await balance()).toBe(1120);
    expect(Number((await summary(now.getFullYear(), now.getMonth() + 1)).spent)).toBe(80);
    expect(Number((await flow()).total_expense)).toBe(80);
    expect(await spending(category('Groceries'))).toBe(80);
    expect(await capital()).toBe(1120);

    await page.locator('li').filter({ hasText: 'P0 shop' }).getByRole('button', { name: /Изменить|Edit/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#amount').fill('50');
    await dialog.locator('#date').fill(prior);
    await dialog.locator('#category').selectOption(String(category('Dining Out')));
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(dialog).toBeHidden();
    expect(await balance()).toBe(1150);
    expect(Number((await summary(now.getFullYear(), now.getMonth() + 1)).spent)).toBe(0);
    expect(Number((await summary(previous.getFullYear(), previous.getMonth() + 1)).spent)).toBe(50);
    expect(await spending(category('Groceries'))).toBe(0);
    expect(await spending(category('Dining Out'))).toBe(50);
    expect(Number((await flow()).total_expense)).toBe(50);
    expect(await capital()).toBe(1150);

    await page.getByPlaceholder(/Поиск|Search/).fill('P0 shop');
    const shop = page.locator('li').filter({ hasText: 'P0 shop' });
    await expect(shop).toBeVisible();
    page.once('dialog', confirmation => confirmation.accept());
    await shop.getByRole('button', { name: /Удалить|Delete/ }).click();
    await expect(shop).toHaveCount(0);
    expect(await balance()).toBe(1200);
    expect(Number((await summary(previous.getFullYear(), previous.getMonth() + 1)).spent)).toBe(0);
    expect(await spending(category('Dining Out'))).toBe(0);
    expect(Number((await flow()).total_expense)).toBe(0);
    expect(await capital()).toBe(1200);
  } finally {
    await page.waitForLoadState('networkidle');
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('own-account transfers keep both actual sides and never become spending', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  const today = new Date().toISOString().slice(0, 10);
  try {
    expect((await request.post('/api/backup/import', { data: empty })).ok()).toBeTruthy();
    expect((await request.patch('/api/settings', { data: { currency: 'USD' } })).ok()).toBeTruthy();
    const account = async (name: string, currency: string) =>
      (await request.post('/api/accounts', { data: { name, currency } })).json();
    const source = await account('P0 source USD', 'USD');
    const savings = await account('P0 savings USD', 'USD');
    const pln = await account('P0 cash PLN', 'PLN');
    expect((await request.post('/api/transactions', { data: {
      account_id: source.id, type: 'adjustment', amount: '1000', adjustment_reason: 'opening_balance',
      description: 'P0 opening', date: today,
    } })).ok()).toBeTruthy();
    const rate = async (value: string) => request.post('/api/fx-rates/bulk', { data: { items: [
      { base_currency: 'USD', quote_currency: 'PLN', rate_date: today, rate: value },
    ] } });
    expect((await rate('4.3')).ok()).toBeTruthy();
    await page.goto('/transactions');
    const transfer = async (target: number, sent: string, received: string | null, description: string) => {
      await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('#type').selectOption('transfer');
      await dialog.locator('#account').selectOption(String(source.id));
      await dialog.locator('#transfer_account').selectOption(String(target));
      await dialog.locator('#amount').fill(sent);
      if (received) await dialog.getByLabel(/Фактически получено|Actually received/).fill(received);
      await dialog.locator('#description').fill(description);
      await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('li').filter({ hasText: description })).toBeVisible();
    };
    await transfer(savings.id, '100', null, 'P0 same currency');
    await transfer(pln.id, '100', '360', 'P0 exchange A');
    await transfer(pln.id, '100', '380', 'P0 exchange B');

    const check = async () => {
      const balances = Object.fromEntries((await (await requestWithRateLimit(request, '/api/accounts')).json())
        .map((row: { id: number; balance: string }) => [row.id, Number(row.balance)]));
      expect(balances[source.id]).toBe(700);
      expect(balances[savings.id]).toBe(100);
      expect(balances[pln.id]).toBe(740);
      const rows = (await (await requestWithRateLimit(request, '/api/backup/export')).json()).transactions;
      for (const [description, amount, received] of [
        ['P0 same currency', '100', '100'], ['P0 exchange A', '100', '360'], ['P0 exchange B', '100', '380'],
      ]) {
        const row = rows.find((item: { description: string }) => item.description === description);
        expect(Number(row.amount)).toBe(Number(amount));
        expect(Number(row.destination_amount)).toBe(Number(received));
      }
      const flow = await (await requestWithRateLimit(request, '/api/cash-flow')).json();
      expect(Number(flow.total_income)).toBe(0);
      expect(Number(flow.total_expense)).toBe(0);
      const dashboard = await (await requestWithRateLimit(request, '/api/dashboard/summary', {
        params: { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
      })).json();
      expect(Number(dashboard.real_income)).toBe(0);
      expect(Number(dashboard.spent)).toBe(0);
    };
    await check();
    expect((await rate('4.5')).ok()).toBeTruthy();
    await check();
  } finally {
    await page.waitForLoadState('networkidle');
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
