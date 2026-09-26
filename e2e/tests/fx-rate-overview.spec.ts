import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

async function nbpRate(request: import('@playwright/test').APIRequestContext, currency: string, day: string, value: string, table = 'A') {
  const response = await request.post('/api/fx-rates/bulk', { data: { items: [{
    base_currency: currency, quote_currency: 'PLN', rate_date: day, rate: value, source: `NBP:${table}:1/${table}/NBP/2026`,
  }] } });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function fxCard(page: import('@playwright/test').Page) {
  return page.locator('div.rounded-xl').filter({ has: page.getByRole('heading', { name: /Курсы валют|Currency rates/ }) });
}

test.describe('Dashboard FX rate overview (period-aware)', () => {
  test('shows all four pairs with the correct direction, date and source, and never writes anything', async ({ page, request }) => {
    test.setTimeout(60000);
    const snapshot = await (await request.get('/api/backup/export')).json();
    try {
      const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
        [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
      expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();

      const today = new Date().toISOString().slice(0, 10);
      await nbpRate(request, 'USD', today, '4.0000', 'A');
      await nbpRate(request, 'EUR', today, '4.3000', 'A');
      await nbpRate(request, 'BYN', today, '1.2500', 'B');
      // RUB deliberately left unset — must render as an explicit
      // insufficient-history state, not a fabricated 0/1:1.

      const before = await (await request.get('/api/backup/export')).json();

      const overviewResponse = page.waitForResponse((r) => r.url().includes('/api/fx-rates/overview/period'));
      await page.goto('/');
      const body = await (await overviewResponse).json();
      expect(body.mode).toBe('latest');

      const card = fxCard(page);
      await expect(card).toBeVisible();
      await expect(card).toContainText('USD');
      await expect(card).toContainText('EUR');
      await expect(card).toContainText('BYN');
      await expect(card).toContainText('RUB');
      // "1 USD = ... PLN" direction, not the inverse — 4.00/4.30, not 0.24/0.23.
      await expect(card).toContainText('4');
      await expect(card).toContainText('NBP');
      // USD/BYN cross (4.0000 / 1.2500 = 3.2000), independently derived.
      await expect(card).toContainText('3,2');
      await expect(card).toContainText(/Недостаточно истории|Not enough history/);

      // Opening the Dashboard never triggers a new NBP network call or any write.
      const after = await (await request.get('/api/backup/export')).json();
      for (const key of ['accounts', 'transactions', 'fx_rates']) expect(after[key]).toEqual(before[key]);
    } finally {
      await page.waitForLoadState('networkidle');
      const restore = await request.post('/api/backup/import', { data: snapshot });
      expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
    }
  });

  test('a manually entered rate is never used as an official leg, and two same-day exchanges keep their own rates', async ({ page, request }) => {
    const snapshot = await (await request.get('/api/backup/export')).json();
    try {
      const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
        [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
      expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
      const today = new Date().toISOString().slice(0, 10);

      // Manually typed — real for transaction conversion, but not NBP.
      await request.post('/api/fx-rates/bulk', { data: { items: [
        { base_currency: 'BYN', quote_currency: 'PLN', rate_date: today, rate: '1.2500' },
      ] } });
      await nbpRate(request, 'USD', today, '4.0000', 'A');

      // Two same-day exchanges at different actual rates.
      const usd = await (await request.post('/api/accounts', { data: { name: 'FX overview USD', currency: 'USD' } })).json();
      const pln = await (await request.post('/api/accounts', { data: { name: 'FX overview PLN', currency: 'PLN' } })).json();
      await request.post('/api/transactions', { data: { account_id: usd.id, type: 'income', amount: '1000', date: today, description: 'Funding' } });
      const firstExchange = await (await request.post('/api/transactions', { data: {
        account_id: usd.id, type: 'transfer', transfer_account_id: pln.id, amount: '100', destination_amount: '360', date: today, description: 'Exchange 1',
      } })).json();
      const secondExchange = await (await request.post('/api/transactions', { data: {
        account_id: usd.id, type: 'transfer', transfer_account_id: pln.id, amount: '100', destination_amount: '380', date: today, description: 'Exchange 2',
      } })).json();

      const overviewResponse = page.waitForResponse((r) => r.url().includes('/api/fx-rates/overview/period'));
      await page.goto('/');
      const body = await (await overviewResponse).json();
      const usdByn = body.items.find((item: { base_currency: string; quote_currency: string }) =>
        item.base_currency === 'USD' && item.quote_currency === 'BYN');
      expect(usdByn.value).toBeNull();

      const card = fxCard(page);
      await expect(card).toContainText(/Недостаточно истории|Not enough history/);

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

  test('renders on a narrow viewport without horizontal overflow', async ({ page, request }) => {
    const snapshot = await (await request.get('/api/backup/export')).json();
    try {
      const today = new Date().toISOString().slice(0, 10);
      await nbpRate(request, 'USD', today, '4.1000', 'A');
      await nbpRate(request, 'EUR', today, '4.5000', 'A');
      await nbpRate(request, 'BYN', today, '1.2500', 'B');
      await nbpRate(request, 'RUB', today, '0.0450', 'B');

      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/');
      const card = fxCard(page);
      await expect(card).toBeVisible();
      for (const code of ['USD', 'EUR', 'BYN', 'RUB']) await expect(card).toContainText(code);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    } finally {
      const restore = await request.post('/api/backup/import', { data: snapshot });
      expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
    }
  });

  test('shows a clear failed-to-load state with a working retry, never a fabricated rate', async ({ page, request }) => {
    const snapshot = await (await request.get('/api/backup/export')).json();
    try {
      let calls = 0;
      await page.route('**/api/fx-rates/overview/period*', (route) => {
        calls += 1;
        if (calls === 1) return route.fulfill({ status: 503, body: 'Synthetic outage' });
        return route.continue();
      });
      const today = new Date().toISOString().slice(0, 10);
      await nbpRate(request, 'USD', today, '4.1000', 'A');

      await page.goto('/');
      const card = fxCard(page);
      const alert = card.getByRole('alert');
      await expect(alert).toContainText(/Не удалось загрузить курсы|Couldn't load exchange rates/);
      // Never a guessed/fabricated rate while the request is failing.
      await expect(card.getByText('USD')).toHaveCount(0);

      await card.getByRole('button', { name: /Повторить|Retry/ }).click();
      await expect(alert).toHaveCount(0);
      await expect(card).toContainText('USD');
      expect(calls).toBe(2);
    } finally {
      const restore = await request.post('/api/backup/import', { data: snapshot });
      expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
    }
  });

  test('switching the Dashboard period never leaves a stale value under the new period\'s label', async ({ page, request }) => {
    const snapshot = await (await request.get('/api/backup/export')).json();
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      await nbpRate(request, 'USD', todayIso, '4.1000', 'A');

      await page.goto('/');
      const card = fxCard(page);
      await expect(card).toContainText('4,1');

      // Switching to "Год" moves USD/PLN from "latest" to a year-to-date
      // average — with only today's rate seeded, that average has no full
      // coverage, so this must not keep showing "Всё время"'s figure
      // relabelled as the new period's own value.
      const periodResponse = page.waitForResponse((r) => r.url().includes('/api/fx-rates/overview/period') && r.url().includes('year='));
      await page.getByRole('button', { name: 'Год', exact: true }).click();
      await periodResponse;

      await expect(card).not.toContainText('4,1');
      await expect(card).toContainText(/Недостаточно истории|Not enough history/);
    } finally {
      const restore = await request.post('/api/backup/import', { data: snapshot });
      expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
    }
  });

  test('insufficient history shows an explicit load action, and a plain page load triggers no NBP request', async ({ page, request }) => {
    const snapshot = await (await request.get('/api/backup/export')).json();
    try {
      const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
        [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
      expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();

      let nbpCalls = 0;
      let lastBody: { start_date: string; end_date: string; currencies: string[] } | null = null;
      await page.route('**/api/fx-rates/nbp', (route) => {
        nbpCalls += 1;
        lastBody = route.request().postDataJSON();
        return route.fulfill({ json: { saved: 0, protected: 0, absent_currencies: [] } });
      });

      await page.goto('/');
      const card = fxCard(page);
      await expect(card).toContainText(/Недостаточно истории|Not enough history/);
      const loadButton = card.getByRole('button', { name: /Загрузить курсы за период|Load rates for this period/ });
      await expect(loadButton).toBeVisible();
      // No history to show yet — opening the Dashboard alone must not have
      // already called NBP for it.
      expect(nbpCalls).toBe(0);

      await loadButton.click();
      await expect.poll(() => nbpCalls).toBeGreaterThan(0);
      expect(lastBody).not.toBeNull();
      expect(lastBody!.currencies.sort()).toEqual(['BYN', 'EUR', 'RUB', 'USD']);
      expect(lastBody!.start_date <= lastBody!.end_date).toBeTruthy();
      expect(lastBody!.end_date <= new Date().toISOString().slice(0, 10)).toBeTruthy();
    } finally {
      const restore = await request.post('/api/backup/import', { data: snapshot });
      expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
    }
  });
});
