import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

async function nbpRate(request: import('@playwright/test').APIRequestContext, currency: string, day: string, value: string, table = 'A') {
  const response = await request.post('/api/fx-rates/bulk', { data: { items: [{
    base_currency: currency, quote_currency: 'PLN', rate_date: day, rate: value, source: `NBP:${table}:1/${table}/NBP/2026`,
  }] } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

test.describe('Dashboard FX rate overview', () => {
  test('shows USD/EUR/BYN/RUB with the correct direction, date and source, and never writes anything', async ({ page, request }) => {
    test.setTimeout(60000);
    const snapshot = await (await request.get('/api/backup/export')).json();
    try {
      const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
        [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
      expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
      expect((await request.patch('/api/settings', { data: { currency: 'PLN' } })).ok()).toBeTruthy();

      const today = new Date().toISOString().slice(0, 10);
      await nbpRate(request, 'USD', today, '4.1000', 'A');
      await nbpRate(request, 'EUR', today, '4.5000', 'A');
      await nbpRate(request, 'BYN', today, '1.2500', 'B');
      // RUB deliberately left unset — must render as an explicit "no rate",
      // and RUB must still appear even though there's no RUB account at all.

      const before = await (await request.get('/api/backup/export')).json();

      const overviewResponse = page.waitForResponse((r) => r.url().includes('/api/fx-rates/overview'));
      await page.goto('/');
      const body = await (await overviewResponse).json();
      expect(body.reporting_currency).toBe('PLN');

      const card = page.locator('div.rounded-xl').filter({ has: page.getByRole('heading', { name: /Курсы валют|Currency rates/ }) });
      await expect(card).toBeVisible();
      await expect(card.getByText('USD')).toBeVisible();
      await expect(card.getByText('EUR')).toBeVisible();
      await expect(card.getByText('BYN')).toBeVisible();
      await expect(card.getByText('RUB')).toBeVisible();
      // "1 USD = ... PLN" direction, not the inverse — 4.10, not 0.24.
      await expect(card).toContainText('4,1');
      await expect(card).toContainText('NBP');
      await expect(card).toContainText(/нет курса|no rate/);

      // Opening the Dashboard never triggers a new NBP network call or any write.
      const after = await (await request.get('/api/backup/export')).json();
      for (const key of ['accounts', 'transactions', 'fx_rates']) expect(after[key]).toEqual(before[key]);
    } finally {
      await page.waitForLoadState('networkidle');
      const restore = await request.post('/api/backup/import', { data: snapshot });
      expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
    }
  });

  test('a manually entered rate is never shown as an official quote, and two same-day exchanges keep their own rates', async ({ page, request }) => {
    const snapshot = await (await request.get('/api/backup/export')).json();
    try {
      const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
        [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
      expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
      expect((await request.patch('/api/settings', { data: { currency: 'PLN' } })).ok()).toBeTruthy();
      const today = new Date().toISOString().slice(0, 10);

      // Manually typed — real for transaction conversion, but not NBP.
      await request.post('/api/fx-rates/bulk', { data: { items: [
        { base_currency: 'RUB', quote_currency: 'PLN', rate_date: today, rate: '0.05' },
      ] } });

      // Two same-day exchanges at different actual rates.
      const usd = await (await request.post('/api/accounts', { data: { name: 'FX overview USD', currency: 'USD' } })).json();
      const pln = await (await request.post('/api/accounts', { data: { name: 'FX overview PLN', currency: 'PLN' } })).json();
      await request.post('/api/transactions', { data: { account_id: usd.id, type: 'income', amount: '1000', date: today, description: 'Funding' } });
      await nbpRate(request, 'USD', today, '4.0000', 'A');
      const firstExchange = await (await request.post('/api/transactions', { data: {
        account_id: usd.id, type: 'transfer', transfer_account_id: pln.id, amount: '100', destination_amount: '360', date: today, description: 'Exchange 1',
      } })).json();
      const secondExchange = await (await request.post('/api/transactions', { data: {
        account_id: usd.id, type: 'transfer', transfer_account_id: pln.id, amount: '100', destination_amount: '380', date: today, description: 'Exchange 2',
      } })).json();

      const overviewResponse = page.waitForResponse((r) => r.url().includes('/api/fx-rates/overview'));
      await page.goto('/');
      const body = await (await overviewResponse).json();
      const rub = body.items.find((item: { currency: string }) => item.currency === 'RUB');
      expect(rub.rate).toBeNull();

      const card = page.locator('div.rounded-xl').filter({ has: page.getByRole('heading', { name: /Курсы валют|Currency rates/ }) });
      await expect(card).toContainText(/нет курса|no rate/);

      const exportData = await (await request.get('/api/backup/export')).json();
      const transfers: Record<number, string> = {};
      for (const row of exportData.transactions) if (row.id === firstExchange.id || row.id === secondExchange.id) transfers[row.id] = row.destination_amount;
      expect(Number(transfers[firstExchange.id])).toBe(360);
      expect(Number(transfers[secondExchange.id])).toBe(380);
    } finally {
      const restore = await request.post('/api/backup/import', { data: snapshot });
      expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
    }
  });

  test('renders on a narrow viewport', async ({ page, request }) => {
    const snapshot = await (await request.get('/api/backup/export')).json();
    try {
      expect((await request.patch('/api/settings', { data: { currency: 'PLN' } })).ok()).toBeTruthy();
      const today = new Date().toISOString().slice(0, 10);
      await nbpRate(request, 'USD', today, '4.1000', 'A');
      await nbpRate(request, 'EUR', today, '4.5000', 'A');
      await nbpRate(request, 'BYN', today, '1.2500', 'B');
      await nbpRate(request, 'RUB', today, '0.0450', 'B');

      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/');
      const card = page.locator('div.rounded-xl').filter({ has: page.getByRole('heading', { name: /Курсы валют|Currency rates/ }) });
      await expect(card).toBeVisible();
      for (const code of ['USD', 'EUR', 'BYN', 'RUB']) await expect(card.getByText(code)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    } finally {
      const restore = await request.post('/api/backup/import', { data: snapshot });
      expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
    }
  });
});
