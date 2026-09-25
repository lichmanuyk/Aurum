import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

const DISPLAY_CARD_HEADING = /Валюта отображения сводок|Summary display currency/;
const VIEW_IN_PLN = /Показать в PLN|Show in PLN/;

test('cash flow and reports display currency preferences inherit/override, convert historically, and isolate same-day exchange rates', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  try {
    const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
      [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    await request.patch('/api/settings', { data: { currency: 'PLN' } });

    // Two dated EUR expenses (historically rated: 4 on Jan 3, 5 on Jan 17,
    // both vs. a flat USD rate of 2) — the same fixture the backend tests
    // use, so the expected converted totals below (900/450/200) line up.
    const eur = await (await request.post('/api/accounts', { data: { name: 'CF Reports EUR', currency: 'EUR' } })).json();
    const categories = await (await request.get('/api/categories')).json();
    const groceries = categories.find((c: { name: string }) => c.name === 'Groceries').id;
    for (const [day, rate] of [['2025-01-03', '4'], ['2025-01-17', '5']]) {
      await request.post('/api/fx-rates/bulk', { data: { items: [
        { base_currency: 'EUR', quote_currency: 'PLN', rate_date: day, rate },
        { base_currency: 'USD', quote_currency: 'PLN', rate_date: day, rate: '2' },
      ] } });
      await request.post('/api/transactions', { data: {
        account_id: eur.id, type: 'expense', amount: '100', category_id: groceries, date: day, description: 'CF/Reports fixture',
      } });
    }
    // Two same-day currency exchanges at different actual rates — the
    // classic FX-model edge case. Cash Flow/Reports exclude transfers from
    // their own totals, so this only has to prove switching currency there
    // never disturbs either transfer's own recorded rate. Dated on one of
    // the fixture's own rated days (2025-01-17, already has EUR/USD -> PLN
    // rates above) rather than "today", so converting the funding income
    // to any of PLN/USD/EUR never needs a rate this test didn't set up.
    const exchangeDay = '2025-01-17';
    const usd = await (await request.post('/api/accounts', { data: { name: 'CF Exchange USD', currency: 'USD' } })).json();
    const pln = await (await request.post('/api/accounts', { data: { name: 'CF Exchange PLN', currency: 'PLN' } })).json();
    await request.post('/api/transactions', { data: { account_id: usd.id, type: 'income', amount: '1000', date: exchangeDay, description: 'Funding' } });
    const firstExchange = await (await request.post('/api/transactions', { data: {
      account_id: usd.id, type: 'transfer', transfer_account_id: pln.id, amount: '100', destination_amount: '360', date: exchangeDay, description: 'Exchange 1',
    } })).json();
    const secondExchange = await (await request.post('/api/transactions', { data: {
      account_id: usd.id, type: 'transfer', transfer_account_id: pln.id, amount: '100', destination_amount: '380', date: exchangeDay, description: 'Exchange 2',
    } })).json();
    const beforeFxRates = await (await request.get('/api/fx-rates')).json();

    // Settings: general = USD, Cash Flow overridden to EUR, Reports left
    // inheriting the general USD.
    await page.goto('/settings');
    const displayCard = page.locator('div.rounded-xl').filter({ has: page.getByText(DISPLAY_CARD_HEADING, { exact: true }) });
    await displayCard.getByLabel(/Общая|General/).selectOption('USD');
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).summary_currency).toBe('USD');
    await displayCard.getByLabel(/Движение денег|Cash Flow/).selectOption('EUR');
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).cash_flow_currency).toBe('EUR');

    await page.reload();
    await expect(displayCard.getByLabel(/Общая|General/)).toHaveValue('USD');
    await expect(displayCard.getByLabel(/Движение денег|Cash Flow/)).toHaveValue('EUR');
    await expect(displayCard.getByLabel(/Отчёты|Reports/)).toHaveValue('');

    // Cash Flow uses its explicit EUR override. Default range is "this
    // year" — switch to "all time" so the fixture's 2025-dated expenses
    // are actually included.
    await page.goto('/cash-flow');
    // Settings load asynchronously — the very first request can briefly use
    // the primary currency before the real (server-persisted) currency
    // settles in. Wait for that initial settle before clicking, so the
    // click's own request is the one the listener below actually captures.
    await page.waitForResponse(r => r.url().includes('/cash-flow?') && r.url().includes('currency=EUR'));
    const cashFlowResponse = page.waitForResponse(r => r.url().includes('/cash-flow?') && r.url().includes('currency=EUR'));
    await page.getByRole('button', { name: /Всё время|All time/, exact: true }).click();
    const cashFlowBody = await (await cashFlowResponse).json();
    expect(cashFlowBody.reporting_currency).toBe('EUR');
    expect(Number(cashFlowBody.total_expense)).toBe(200);
    const cashFlowAction = page.getByRole('button', { name: VIEW_IN_PLN });
    await expect(cashFlowAction).toBeVisible();
    const plnCashFlow = page.waitForResponse(r => r.url().includes('/cash-flow?') && r.url().includes('currency=PLN'));
    await cashFlowAction.click();
    expect(Number((await (await plnCashFlow).json()).total_expense)).toBe(900);
    await expect(page.getByRole('button', { name: /Показать в EUR|Show in EUR/ })).toBeVisible();
    // The temporary view never wrote back to settings.
    expect((await (await request.get('/api/settings')).json()).cash_flow_currency).toBe('EUR');

    // Reports inherits the general USD (its own override is unset). Default
    // range is "all", so the ranking request fires with no date params on
    // its own — nothing to click first.
    const rankingResponse = page.waitForResponse(r => r.url().includes('/reports/category-ranking') && r.url().includes('currency=USD'));
    await page.goto('/reports');
    const ranking = await (await rankingResponse).json();
    expect(ranking.reporting_currency).toBe('USD');
    await expect(page.getByRole('button', { name: VIEW_IN_PLN })).toBeVisible();

    // A page outside this feature never shows the action.
    await page.goto('/accounts');
    await expect(page.getByRole('button', { name: /Показать в|Show in/ })).toHaveCount(0);

    // Neither switching currency nor the temporary view derived a new
    // global FX rate or touched either exchange's own recorded rate.
    const afterFxRates = await (await request.get('/api/fx-rates')).json();
    expect(afterFxRates).toEqual(beforeFxRates);
    const exportData = await (await request.get('/api/backup/export')).json();
    const transfers: Record<number, string | null> = {};
    for (const row of exportData.transactions) if (row.id === firstExchange.id || row.id === secondExchange.id) transfers[row.id] = row.destination_amount;
    expect(Number(transfers[firstExchange.id])).toBe(360);
    expect(Number(transfers[secondExchange.id])).toBe(380);
  } finally {
    await page.waitForLoadState('networkidle');
    const restore = await request.post('/api/backup/import', { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('cash flow and reports preferences hold in a brand-new browser context, but a temporary view never does', async ({ browser, request }) => {
  test.setTimeout(60000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  try {
    const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
      [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    // General USD; Cash Flow pinned back to the primary PLN (no action at
    // all); Reports overridden to EUR.
    expect((await request.patch('/api/settings', { data: {
      currency: 'PLN', summary_currency: 'USD', cash_flow_currency: 'PLN', reports_currency: 'EUR',
    } })).ok()).toBeTruthy();

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await pageA.route('**/api/fx-rates/nbp/latest', route => route.fulfill({ json: { saved: 0, absent_currencies: [] } }));
    await pageA.goto('/reports');
    const toggleInA = pageA.getByRole('button', { name: VIEW_IN_PLN });
    await expect(toggleInA).toBeVisible();
    await toggleInA.click();
    await expect(pageA.getByRole('button', { name: /Показать в EUR|Show in EUR/ })).toBeVisible();
    await contextA.close();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.route('**/api/fx-rates/nbp/latest', route => route.fulfill({ json: { saved: 0, absent_currencies: [] } }));

    const reportsResponse = pageB.waitForResponse(r => r.url().includes('/reports/category-ranking') && r.url().includes('currency=EUR'));
    await pageB.goto('/reports');
    expect((await (await reportsResponse).json()).reporting_currency).toBe('EUR');
    await expect(pageB.getByRole('button', { name: VIEW_IN_PLN })).toBeVisible();
    await expect(pageB.getByRole('button', { name: /Показать в EUR|Show in EUR/ })).toHaveCount(0);

    await pageB.goto('/cash-flow');
    await expect(pageB.getByRole('button', { name: /Показать в|Show in/ })).toHaveCount(0);

    await contextB.close();
  } finally {
    const restore = await request.post('/api/backup/import', { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('cash flow and reports display currency settings and the temporary-view action work on a narrow viewport', async ({ page, request }) => {
  const snapshot = await (await request.get('/api/backup/export')).json();
  try {
    await request.patch('/api/settings', { data: { currency: 'PLN', summary_currency: 'USD', cash_flow_currency: null, reports_currency: null } });
    await page.setViewportSize({ width: 375, height: 812 });

    await page.goto('/settings');
    const displayCard = page.locator('div.rounded-xl').filter({ has: page.getByText(DISPLAY_CARD_HEADING, { exact: true }) });
    await displayCard.getByLabel(/Отчёты|Reports/).selectOption('EUR');
    await expect.poll(async () => (await (await request.get('/api/settings')).json()).reports_currency).toBe('EUR');

    await page.goto('/reports');
    const action = page.getByRole('button', { name: VIEW_IN_PLN });
    await expect(action).toBeVisible();
    await action.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /Показать в EUR|Show in EUR/ })).toBeVisible();
  } finally {
    const restore = await request.post('/api/backup/import', { data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
