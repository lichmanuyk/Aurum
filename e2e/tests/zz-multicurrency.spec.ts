import { test, expect } from '@playwright/test';

test('native EUR balance, actual PLN transfer amount, rate entry and reporting switch', async ({ page, request }) => {
  test.setTimeout(60000);
  page.setDefaultTimeout(10000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const suffix = Date.now();
  const sourceName = `FX EUR wallet ${suffix}`;
  const targetName = `FX PLN wallet ${suffix}`;
  try {
    await request.patch('/api/settings', { data: { currency: 'PLN' } });
    const source = await (await request.post('/api/accounts', { data: { name: sourceName, currency: 'EUR' } })).json();
    const target = await (await request.post('/api/accounts', { data: { name: targetName, currency: 'PLN' } })).json();
    const today = new Date().toISOString().slice(0, 10);
    expect((await request.post('/api/transactions', { data: { account_id: source.id, type: 'income', amount: '200', description: 'FX opening test income', date: today } })).ok()).toBeTruthy();
    await page.goto('/transactions');
    await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#type').selectOption('transfer');
    await dialog.locator('#account').selectOption(String(source.id));
    await dialog.locator('#transfer_account').selectOption(String(target.id));
    await dialog.locator('#amount').fill('100');
    await dialog.locator('#description').fill('FX transfer browser');
    await dialog.getByLabel(/Фактически получено|Actually received/).fill('431.27');
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('FX transfer browser', { exact: true })).toBeVisible();
    await page.goto('/accounts');
    const sourceRow = page.locator('li').filter({ hasText: sourceName });
    const targetRow = page.locator('li').filter({ hasText: targetName });
    await expect(sourceRow).toContainText(/100[,.]00/);
    await expect(sourceRow).toContainText('€');
    await expect(targetRow).toContainText(/431[,.]27/);
    await page.goto('/settings');
    const rates = page.locator('div.rounded-xl').filter({ has: page.getByText(/Справочные курсы валют|Reference exchange rates/, { exact: true }) });
    await rates.getByRole('combobox').nth(0).selectOption('EUR');
    await rates.getByRole('combobox').nth(1).selectOption('PLN');
    await rates.getByLabel('FX rate').fill('4.3127');
    await rates.getByRole('button', { name: /Сохранить курс|Save rate/ }).click();
    await expect(rates.locator('table')).toContainText('4.3127');
    const cash = await request.get('/api/cash-flow', { params: { start_date: today, end_date: today } });
    expect(cash.ok()).toBeTruthy();
    // Source income is converted; internal transfer never becomes an expense.
    expect(Number((await cash.json()).total_income)).toBeGreaterThanOrEqual(862.54);
    await page.screenshot({ path: 'test-results/multicurrency-settings.png', fullPage: true });
    const currencyCard = page.locator('div.rounded-xl').filter({ has: page.getByText(/Основная валюта|Primary currency/, { exact: true }) });
    const changed = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().method() === 'PATCH');
    await currencyCard.getByRole('combobox').selectOption('EUR');
    expect((await changed).ok()).toBeTruthy();
    await page.goto('/accounts');
    await expect(sourceRow).toContainText(/100[,.]00/);
    await expect(sourceRow).toContainText('€');
    await expect(targetRow).toContainText(/431[,.]27/);
    const converted = await request.get('/api/cash-flow', { params: { start_date: today, end_date: today } });
    expect((await converted.json()).reporting_currency).toBe('EUR');
  } finally {
    expect((await request.post('/api/backup/import', { data: snapshot })).ok()).toBeTruthy();
  }
});
