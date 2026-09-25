import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('year boundary uses dated FX, display currency preserves EUR money and missing FX is visible', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  try {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    expect((await request.patch('/api/settings', { data: { currency: 'PLN' } })).ok()).toBeTruthy();
    const account = await (await request.post('/api/accounts', { data: { name: 'P1 year EUR', currency: 'EUR' } })).json();
    for (const [date, rate] of [['2025-12-31', '4'], ['2026-01-01', '5']]) {
      expect((await request.post('/api/fx-rates/bulk', { data: { items: [
        { base_currency: 'EUR', quote_currency: 'PLN', rate_date: date, rate },
        { base_currency: 'USD', quote_currency: 'PLN', rate_date: date, rate: '2' },
      ] } })).ok()).toBeTruthy();
      expect((await request.post('/api/transactions', { data: {
        account_id: account.id, type: 'income', amount: '100', date, description: `P1 year income ${date}`,
      } })).ok()).toBeTruthy();
    }
    await page.goto('/');
    const income = page.locator('xpath=//p[text()="Реальный доход"]/following-sibling::p[1]');
    // The old always-visible summary-currency selector is gone — the
    // Dashboard's display currency now comes from Settings (summary_currency),
    // set here directly via the API, same as a user would via the Settings
    // page's DisplayCurrencyCard (covered by summary-currency.spec.ts).
    // A fresh open (and a reload — the period is deliberately never
    // persisted, see docs/tasks/dashboard-periods.md) always starts on
    // "Всё время", with no month/year pickers at all until "Год" is
    // picked — which itself always lands on the current year (2026 here),
    // exactly the year every check below needs.
    async function setDashboardCurrency(value: string | null) {
      expect((await request.patch('/api/settings', { data: { summary_currency: value } })).ok()).toBeTruthy();
      await page.reload();
      await page.getByRole('button', { name: 'Год', exact: true }).click();
      await page.getByRole('button', { name: 'Янв', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Год', exact: true }).click();
    // "Год" lands on the current (2026) year, where December doesn't exist
    // as a future month yet (see docs/tasks/dashboard-periods.md) — switch
    // to the past year first, which has every month, then pick December.
    await page.getByRole('button', { name: /^\d{4}$/ }).first().click();
    await page.getByRole('option', { name: '2025' }).click();
    await page.getByRole('button', { name: 'Дек', exact: true }).click();
    await expect(income).toContainText('400');
    await page.getByRole('button', { name: /^2025$/ }).click();
    await page.getByRole('option', { name: '2026' }).click();
    await page.getByRole('button', { name: 'Янв', exact: true }).click();
    await expect(income).toContainText('500');
    await setDashboardCurrency('USD');
    await expect(income).toContainText('250');
    await setDashboardCurrency('EUR');
    await expect(income).toContainText('100');
    const accounts = await (await requestWithRateLimit(request, '/api/accounts')).json();
    expect(Number(accounts.find((item: { id: number }) => item.id === account.id).balance)).toBe(200);

    expect((await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'income', amount: '10', date: '2026-01-20', description: 'P1 missing FX',
    } })).ok()).toBeTruthy();
    await setDashboardCurrency('PLN');
    await expect(page.getByRole('link', { name: /Проверить курсы и настройки|Check exchange rates and settings/ })).toBeVisible();
    await expect(income).toContainText('—');
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
