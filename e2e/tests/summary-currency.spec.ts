import { test, expect } from '../fixtures';
import { makeHolding } from '../../frontend/src/test/cryptoFixtures';

test('summary currency persists across screens without changing accounting or native amounts', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/backup/export')).json();
  try {
    const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
      [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
    expect((await request.post('/api/backup/import', { data: empty })).ok()).toBeTruthy();
    await request.patch('/api/settings', { data: { currency: 'PLN' } });
    const account = await (await request.post('/api/accounts', { data: { name: 'Summary EUR', currency: 'EUR' } })).json();
    const day = new Date().toISOString().slice(0, 10);
    await request.post('/api/fx-rates/bulk', { data: { items: [
      { base_currency: 'EUR', quote_currency: 'PLN', rate_date: day, rate: '5' },
      { base_currency: 'USD', quote_currency: 'PLN', rate_date: day, rate: '2' },
    ] } });
    await request.post('/api/transactions', { data: { account_id: account.id, type: 'income', amount: '100', date: day, description: 'Native EUR remains EUR' } });
    const before = await (await request.get('/api/backup/export')).json();
    await page.goto('/');
    const selector = page.getByLabel(/Валюта сводки|Summary currency/);
    const changed = page.waitForResponse(r => r.url().includes('/dashboard/summary') && r.url().includes('currency=USD'));
    await selector.selectOption('USD');
    expect((await (await changed).json()).real_income).toBe('250.00');
    await expect(page.getByText(/250\s*\$/, { exact: true }).first()).toBeVisible();
    await page.goto('/net-worth');
    await expect(selector).toHaveValue('USD');
    await expect(page.getByText(/250\s*\$/, { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(selector).toHaveValue('USD');
    await selector.selectOption('EUR');
    await expect(page.getByText(/100\s*€/, { exact: true }).first()).toBeVisible();
    // UI-only crypto fixture; native holdings are tested against the real backend separately.
    await page.route('**/api/crypto/holdings?*', route => {
      const currency = new URL(route.request().url()).searchParams.get('currency') ?? 'PLN';
      const value = currency === 'EUR' ? '100' : currency === 'USD' ? '250' : '500';
      return route.fulfill({ json: { synced: false, last_synced_at: null, error_key: null,
        holdings: [makeHolding({ currency, quote_currency: 'EUR', value, current_price: value, cost_basis: null, avg_buy_price: null, profit_loss: null })] } });
    });
    await page.route('**/api/crypto/history?*', route => {
      const currency = new URL(route.request().url()).searchParams.get('currency');
      return route.fulfill({ json: { reporting_currency: currency, range: 'all', current: currency === 'EUR' ? '100' : '250', change_amount: '0', change_percent: null, series: [] } });
    });
    await page.goto('/crypto');
    await expect(selector).toHaveValue('EUR');
    await expect(page.getByText(/100\s*€/, { exact: true }).first()).toBeVisible();
    await selector.selectOption('USD');
    await expect(page.getByText(/250\s*\$/, { exact: true }).first()).toBeVisible();
    const after = await (await request.get('/api/backup/export')).json();
    for (const key of ['accounts', 'transactions', 'app_settings', 'crypto_transactions']) expect(after[key]).toEqual(before[key]);
    await page.goto('/accounts');
    await expect(page.locator('li').filter({ hasText: 'Summary EUR' })).toContainText(/100[,.]00\s*€/);
    await expect(selector).toHaveCount(0);
  } finally {
    // Let app-open quote checks finish before replacing the shared test DB.
    await page.waitForLoadState('networkidle');
    const restore = await request.post('/api/backup/import', { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
