import { test, expect } from '../fixtures';
import { makeHolding } from '../../frontend/src/test/cryptoFixtures';
import { requestWithRateLimit } from './helpers';

const DISPLAY_CARD_HEADING = /Валюта отображения сводок|Summary display currency/;
const VIEW_IN_PLN = /Показать в PLN|Show in PLN/;

function mockCrypto(page: import('@playwright/test').Page) {
  // UI-only fixture, same approach as the other crypto-tab specs — native
  // holdings/conversion math is covered against the real backend elsewhere
  // (test_summary_currency.py on the backend side).
  return Promise.all([
    page.route('**/api/crypto/holdings?*', route => {
      const currency = new URL(route.request().url()).searchParams.get('currency') ?? 'PLN';
      const value = currency === 'USD' ? '250' : currency === 'EUR' ? '200' : '500';
      return route.fulfill({ json: { synced: false, last_synced_at: null, error_key: null,
        holdings: [makeHolding({ currency, quote_currency: 'EUR', value, current_price: value, cost_basis: null, avg_buy_price: null, profit_loss: null })] } });
    }),
    page.route('**/api/crypto/history?*', route => {
      const currency = new URL(route.request().url()).searchParams.get('currency');
      const current = currency === 'USD' ? '250' : currency === 'EUR' ? '200' : '500';
      return route.fulfill({ json: { reporting_currency: currency, range: 'all', current, change_amount: '0', change_percent: null, series: [] } });
    }),
  ]);
}

test('display currency preferences persist server-side, inherit/override per page, and a temporary primary view never touches settings', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  try {
    const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
      [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    await request.patch('/api/settings', { data: { currency: 'PLN' } });
    const account = await (await request.post('/api/accounts', { data: { name: 'Summary EUR', currency: 'EUR' } })).json();
    const day = new Date().toISOString().slice(0, 10);
    await request.post('/api/fx-rates/bulk', { data: { items: [
      { base_currency: 'EUR', quote_currency: 'PLN', rate_date: day, rate: '5' },
      { base_currency: 'USD', quote_currency: 'PLN', rate_date: day, rate: '2' },
    ] } });
    await request.post('/api/transactions', { data: { account_id: account.id, type: 'income', amount: '100', date: day, description: 'Native EUR stays EUR' } });
    const before = await (await requestWithRateLimit(request, '/api/backup/export')).json();

    // Settings: general = USD, Net Worth explicitly overridden to EUR,
    // Dashboard and Crypto left inheriting the general choice.
    await page.goto('/settings');
    const displayCard = page.locator('div.rounded-xl').filter({ has: page.getByText(DISPLAY_CARD_HEADING, { exact: true }) });
    await displayCard.getByLabel(/Общая|General/).selectOption('USD');
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).summary_currency).toBe('USD');
    await displayCard.getByLabel(/Капитал|Net Worth/).selectOption('EUR');
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).net_worth_currency).toBe('EUR');
    // No selector exposes a raw currency other than PLN/USD/EUR — confirms
    // this card, not the removed full CURRENCIES picker, is what's under test.
    await expect(displayCard.getByLabel(/Общая|General/).locator('option')).toHaveCount(3);

    await page.reload();
    await expect(displayCard.getByLabel(/Общая|General/)).toHaveValue('USD');
    await expect(displayCard.getByLabel(/Капитал|Net Worth/)).toHaveValue('EUR');
    await expect(displayCard.getByLabel(/Дашборд|Dashboard/)).toHaveValue('');
    await expect(displayCard.getByLabel(/Криптовалюта|Crypto/)).toHaveValue('');

    // Dashboard inherits USD (100 EUR income * 2 = 200 USD-equivalent... the
    // fixture's own account currency conversion is asserted precisely by the
    // backend test; here it's enough that the page renders in USD and offers
    // the temporary-primary-view action.
    const dashboardResponse = page.waitForResponse(r => r.url().includes('/dashboard/summary') && r.url().includes('currency=USD'));
    await page.goto('/');
    expect((await (await dashboardResponse).json()).reporting_currency).toBe('USD');
    const dashboardAction = page.getByRole('button', { name: VIEW_IN_PLN });
    await expect(dashboardAction).toBeVisible();
    const pln = page.waitForResponse(r => r.url().includes('/dashboard/summary') && r.url().includes('currency=PLN'));
    await dashboardAction.click();
    expect((await (await pln).json()).reporting_currency).toBe('PLN');
    await expect(page.getByRole('button', { name: /Показать в USD|Show in USD/ })).toBeVisible();
    // The temporary view never wrote back to settings.
    expect((await (await request.get('/api/settings')).json()).summary_currency).toBe('USD');

    // Net Worth uses its explicit EUR override, independent of the general USD.
    const netWorthResponse = page.waitForResponse(r => r.url().includes('/net-worth/summary') && r.url().includes('currency=EUR'));
    await page.goto('/net-worth');
    expect((await (await netWorthResponse).json()).reporting_currency).toBe('EUR');
    await expect(page.getByRole('button', { name: VIEW_IN_PLN })).toBeVisible();

    // Crypto inherits the general USD (its own override is unset).
    await mockCrypto(page);
    await page.goto('/crypto');
    await expect(page.getByText(/250\s*\$/, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: VIEW_IN_PLN })).toBeVisible();

    // A page outside this feature never shows the action, even though the
    // configured currency differs from primary.
    await page.goto('/accounts');
    await expect(page.getByRole('button', { name: /Показать в|Show in/ })).toHaveCount(0);

    const after = await (await requestWithRateLimit(request, '/api/backup/export')).json();
    for (const key of ['accounts', 'transactions', 'fx_rates']) expect(after[key]).toEqual(before[key]);
  } finally {
    await page.waitForLoadState('networkidle');
    const restore = await request.post('/api/backup/import', { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('display currency settings and the temporary-view action work on a narrow viewport', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/backup/export')).json();
  try {
    await request.patch('/api/settings', { data: { currency: 'PLN', summary_currency: 'USD', net_worth_currency: null } });
    await page.setViewportSize({ width: 375, height: 812 });

    await page.goto('/settings');
    const displayCard = page.locator('div.rounded-xl').filter({ has: page.getByText(DISPLAY_CARD_HEADING, { exact: true }) });
    await expect(displayCard.getByLabel(/Общая|General/)).toHaveValue('USD');
    await displayCard.getByLabel(/Дашборд|Dashboard/).selectOption('EUR');
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).dashboard_currency).toBe('EUR');

    await page.goto('/');
    const action = page.getByRole('button', { name: /Показать в PLN|Show in PLN/ });
    await expect(action).toBeVisible();
    // Reachable and operable by keyboard, not just pointer.
    await action.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /Показать в EUR|Show in EUR/ })).toBeVisible();
  } finally {
    const restore = await request.post('/api/backup/import', { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
