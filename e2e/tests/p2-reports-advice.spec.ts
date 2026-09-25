import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('reports, capital, advice and ROI agree and never mask missing FX as zero', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  const today = new Date().toISOString().slice(0, 10);
  try {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    expect((await request.patch('/api/settings', { data: { currency: 'USD' } })).ok()).toBeTruthy();
    await page.goto('/reports');
    await expect(page.getByText(/Нет расходов за выбранный период|No expenses for the selected period/)).toBeVisible();
    await page.goto('/advice');
    await expect(page.getByText(/Пока нет советов|No advice right now/)).toBeVisible();
    await page.goto('/roi');
    await expect(page.getByText(/Впишите стоимость|Enter the price/)).toBeVisible();

    const categories = await (await request.get('/api/categories')).json();
    const category = (name: string) => categories.find((row: { name: string }) => row.name === name).id;
    const account = await (await request.post('/api/accounts', { data: { name: 'P2 report USD', currency: 'USD' } })).json();
    for (const [type, amount, name] of [
      ['income', '1000', 'Salary'], ['expense', '200', 'Groceries'], ['expense', '50', 'Dining Out'],
    ]) {
      expect((await request.post('/api/transactions', { data: {
        account_id: account.id, type, amount, date: today, category_id: category(name), description: `P2 ${name}`,
      } })).ok()).toBeTruthy();
    }
    expect((await request.post('/api/assets', { data: {
      name: 'P2 report asset', asset_class: 'other', currency: 'USD', value: '500', as_of_date: today,
    } })).ok()).toBeTruthy();
    expect((await request.post('/api/budgets', { data: {
      category_id: category('Groceries'), monthly_limit: '100',
    } })).ok()).toBeTruthy();

    const dashboard = await (await requestWithRateLimit(request, '/api/dashboard/summary', { params: {
      year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)),
    } })).json();
    const flow = await (await requestWithRateLimit(request, '/api/cash-flow')).json();
    const capital = await (await requestWithRateLimit(request, '/api/net-worth/summary')).json();
    expect([Number(dashboard.real_income), Number(dashboard.spent), Number(dashboard.net)]).toEqual([1000, 250, 750]);
    expect([Number(flow.total_income), Number(flow.total_expense), Number(flow.total_net)]).toEqual([1000, 250, 750]);
    expect(Number(capital.current)).toBe(1250);
    const alerts = await (await requestWithRateLimit(request, '/api/insights/alerts')).json();
    expect(alerts.alerts.map((row: { key: string }) => row.key)).toContain('budget_exceeded');

    await page.goto('/reports');
    await page.locator('#report-category').selectOption(String(category('Groceries')));
    await expect(page.getByRole('heading', { name: /Продукты|Groceries/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Топ категорий|Top categories/ })).toBeVisible();
    await expect(page.locator('li').filter({ hasText: /Продукты|Groceries/ }).first()).toContainText('200');
    await page.goto('/advice');
    await expect(page.getByText(/Кафе и рестораны|Dining Out/).first()).toBeVisible();
    await page.goto('/roi');
    await page.locator('#roi-investment').fill('500');
    await page.locator('#roi-income').fill('20');
    await expect(page.getByText('48.0%', { exact: true })).toBeVisible();

    const eur = await (await request.post('/api/accounts', { data: { name: 'P2 missing EUR', currency: 'EUR' } })).json();
    expect((await request.post('/api/transactions', { data: {
      account_id: eur.id, type: 'income', amount: '10', date: today,
      category_id: category('Salary'), description: 'P2 no rate',
    } })).ok()).toBeTruthy();
    expect((await request.post('/api/transactions', { data: {
      account_id: eur.id, type: 'expense', amount: '5', date: today,
      category_id: category('Groceries'), description: 'P2 no expense rate',
    } })).ok()).toBeTruthy();
    await page.goto('/reports');
    await expect(page.getByRole('link', { name: /Проверить курсы и настройки|Check exchange rates and settings/ }).first()).toBeVisible();
    await expect(page.getByText(/Нет расходов за выбранный период|No expenses for the selected period/)).toHaveCount(0);
    await page.goto('/cash-flow');
    // Same as Reports above (see its own .first()) — the chart and each of
    // the two per-kind category lists (see docs/tasks/cash-flow-analysis.md)
    // now surface this error independently.
    await expect(page.getByRole('link', { name: /Проверить курсы и настройки|Check exchange rates and settings/ }).first()).toBeVisible();
    await page.goto('/advice');
    await expect(page.getByRole('link', { name: /Проверить курсы и настройки|Check exchange rates and settings/ })).toBeVisible();
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
