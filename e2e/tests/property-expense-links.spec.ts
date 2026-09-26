import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

// See docs/tasks/property-expense-links.md: an existing manually-tracked
// asset's optional "Expenses" view — a plain expense, a split line, and a
// linked recurring template's payment all feed the same total, without ever
// creating a second transaction or moving the asset's own valuation.

async function resetToEmpty(request: import('@playwright/test').APIRequestContext) {
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
  return snapshot;
}

async function createAsset(request: import('@playwright/test').APIRequestContext, name: string, overrides: Record<string, unknown> = {}) {
  const response = await request.post('/api/assets', { data: {
    name, asset_class: 'real_estate', currency: 'USD', value: '100000', as_of_date: '2026-01-01', ...overrides,
  } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

test('a plain expense and a paid template feed one asset\'s Expenses total, without moving its own valuation', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'PEL account', currency: 'USD' } })).json();
    const asset = await createAsset(request, 'PEL apartment');

    // Creating the asset never posted a transaction — no cash movement.
    const accountsBefore = await (await requestWithRateLimit(request, '/api/accounts')).json();
    expect(Number(accountsBefore.find((a: { id: number }) => a.id === account.id).balance)).toBe(0);

    await page.goto('/transactions');
    await page.getByRole('button', { name: /Добавить|Add/ }).click();
    const form = page.getByRole('dialog');
    await form.locator('#account').selectOption(String(account.id));
    await form.locator('#expense-asset').selectOption(String(asset.id));
    await form.locator('#amount').fill('120');
    await form.locator('#description').fill('PEL utility bill');
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();

    await page.goto('/net-worth');
    const row = page.locator('li').filter({ hasText: 'PEL apartment' });
    await row.getByRole('button', { name: /Расходы|Expenses/ }).click();
    const expensesModal = page.getByRole('dialog').filter({ hasText: 'PEL apartment' });
    await expect(expensesModal).toBeVisible();
    await expect(expensesModal).toContainText('PEL utility bill');
    await expect(expensesModal).toContainText('120');
    await expensesModal.getByRole('button', { name: /Закрыть|Close/ }).first().click();
    await expect(expensesModal).toBeHidden();

    // The asset's own valuation is a separate, self-reported number —
    // linking/posting an expense never changes it.
    const assets = await (await requestWithRateLimit(request, '/api/assets')).json();
    expect(Number(assets.find((a: { id: number }) => a.id === asset.id).current_value)).toBe(100000);

    // Now a linked recurring template, paid through the existing modal.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const template = await (await request.post('/api/recurring', { data: {
      account_id: account.id, type: 'expense', amount: '30.00', description: 'PEL internet bill',
      frequency: 'monthly', anchor_date: yesterday, expense_asset_id: asset.id,
    } })).json();

    await page.goto('/net-worth');
    await row.getByRole('button', { name: /Расходы|Expenses/ }).click();
    await expect(expensesModal).toBeVisible();
    await expect(expensesModal).toContainText('PEL internet bill');
    await expensesModal.getByRole('button', { name: /Провести|Post/ }).click();
    // The payment modal is a sibling dialog, not nested inside the
    // expenses one (see components/networth/AssetExpensesModal.tsx) —
    // "Оплата: …"/"Payment: …" is a title only that dialog carries.
    const paymentModal = page.getByRole('dialog').filter({ hasText: /Оплата: PEL internet bill|Payment: PEL internet bill/ });
    await expect(paymentModal).toBeVisible();
    await paymentModal.getByRole('button', { name: /Подтвердить оплату|Confirm payment/ }).click();
    await expect(paymentModal).toBeHidden();

    // The report refreshes to include the just-posted payment — exactly
    // one new expense, no duplicate, no change to the template itself.
    await expect(expensesModal.getByText(/150/)).toBeVisible();
    const transactions = (await (await requestWithRateLimit(request, '/api/transactions')).json()).items;
    expect(transactions.filter((t: { description: string }) => t.description === 'PEL internet bill')).toHaveLength(1);
    const templates = await (await requestWithRateLimit(request, '/api/recurring')).json();
    expect(Number(templates.find((r: { id: number }) => r.id === template.id).amount)).toBe(30);
    expect(Number(assets.find((a: { id: number }) => a.id === asset.id).current_value)).toBe(100000);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('split lines link different assets independently, with no double counting', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'PEL split account', currency: 'USD' } })).json();
    const house = await createAsset(request, 'PEL split house');
    const car = await createAsset(request, 'PEL split car', { asset_class: 'vehicles' });
    const categories = await (await request.get('/api/categories')).json();
    const groceries = categories.find((c: { name: string }) => c.name === 'Groceries');
    const sweetsResp = await request.post('/api/categories', { data: { name: 'PEL Sweets', kind: 'expense', color: '#7a869a', parent_id: groceries.id } });
    const sweets = await sweetsResp.json();

    await page.goto('/transactions');
    await page.getByRole('button', { name: /Добавить|Add/ }).click();
    const form = page.getByRole('dialog');
    await form.locator('#account').selectOption(String(account.id));
    await form.locator('#amount').fill('100');
    await form.locator('#description').fill('PEL split receipt');
    await form.locator('#category').selectOption(String(groceries.id));
    await form.getByRole('button', { name: /Разбить на несколько категорий|Split across multiple categories/ }).click();
    const rows = form.locator('.space-y-2 > div.rounded-lg');
    await rows.nth(0).locator('select').first().selectOption(String(groceries.id));
    await rows.nth(0).locator('input[type="number"]').fill('60');
    await rows.nth(0).locator('select').nth(1).selectOption(String(house.id));
    await rows.nth(1).locator('select').first().selectOption(String(sweets.id));
    await rows.nth(1).locator('input[type="number"]').fill('40');
    await rows.nth(1).locator('select').nth(1).selectOption(String(car.id));
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();

    const houseReport = await (await requestWithRateLimit(request, `/api/assets/${house.id}/expenses`)).json();
    const carReport = await (await requestWithRateLimit(request, `/api/assets/${car.id}/expenses`)).json();
    expect(Number(houseReport.total_amount)).toBe(60);
    expect(Number(carReport.total_amount)).toBe(40);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('clearing the link removes it from the total, and a fresh asset shows the empty-state hint', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'PEL unlink account', currency: 'USD' } })).json();
    const asset = await createAsset(request, 'PEL unlink asset');
    const created = await (await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'expense', amount: '75', description: 'PEL unlink bill',
      date: '2026-01-05', expense_asset_id: asset.id,
    } })).json();

    let report = await (await requestWithRateLimit(request, `/api/assets/${asset.id}/expenses`)).json();
    expect(Number(report.total_amount)).toBe(75);

    // Dated in January while the page defaults to the current month — the
    // search box spans all time regardless of the period pickers, so the
    // row is found without switching them first.
    await page.goto('/transactions');
    await page.getByPlaceholder(/Поиск по описанию|Search by description/).fill('PEL unlink bill');
    const row = page.locator('li').filter({ hasText: 'PEL unlink bill' }).first();
    await row.getByRole('button', { name: /Изменить|Edit/ }).click();
    const form = page.getByRole('dialog');
    await expect(form).toBeVisible();
    await form.locator('#expense-asset').selectOption('');
    await form.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(form).toBeHidden();

    report = await (await requestWithRateLimit(request, `/api/assets/${asset.id}/expenses`)).json();
    expect(Number(report.total_amount)).toBe(0);
    expect(report.items).toHaveLength(0);

    const refetched = (await (await requestWithRateLimit(request, '/api/transactions')).json()).items
      .find((t: { id: number }) => t.id === created.id);
    expect(refetched.expense_asset_id).toBeNull();

    // A never-linked asset explains how to link something, not a bare 0.
    const emptyAsset = await createAsset(request, 'PEL empty asset');
    await page.goto('/net-worth');
    const emptyRow = page.locator('li').filter({ hasText: 'PEL empty asset' });
    await emptyRow.getByRole('button', { name: /Расходы|Expenses/ }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'PEL empty asset' });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText(/Свяжите этот актив|Link this asset/);
    void emptyAsset;
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('a missing historical FX rate shows a retry-able error, never a fabricated zero', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const eurAccount = await (await request.post('/api/accounts', { data: { name: 'PEL fx account', currency: 'EUR' } })).json();
    const asset = await createAsset(request, 'PEL fx asset');
    await request.post('/api/transactions', { data: {
      account_id: eurAccount.id, type: 'expense', amount: '50', description: 'PEL fx bill',
      date: '2025-03-01', expense_asset_id: asset.id,
    } });

    await page.goto('/net-worth');
    const row = page.locator('li').filter({ hasText: 'PEL fx asset' });
    await row.getByRole('button', { name: /Расходы|Expenses/ }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'PEL fx asset' });
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('alert')).toBeVisible();
    await expect(modal).not.toContainText('0,00');

    // Adding the missing rate and retrying recovers cleanly.
    await request.post('/api/fx-rates/bulk', { data: { items: [{ base_currency: 'EUR', quote_currency: 'USD', rate_date: '2025-03-01', rate: '1.1' }] } });
    await modal.getByRole('button', { name: /Повторить|Retry/ }).click();
    await expect(modal.getByRole('alert')).toBeHidden();
    await expect(modal).toContainText('PEL fx bill');
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});

test('the year picker never leaves a stale total under a new period, and the modal works at 375px with a keyboard', async ({ page, request }) => {
  const snapshot = await resetToEmpty(request);
  try {
    const account = await (await request.post('/api/accounts', { data: { name: 'PEL period account', currency: 'USD' } })).json();
    const asset = await createAsset(request, 'PEL period asset');
    await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'expense', amount: '11', description: 'PEL 2025 bill',
      date: '2025-06-01', expense_asset_id: asset.id,
    } });
    await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'expense', amount: '22', description: 'PEL 2024 bill',
      date: '2024-06-01', expense_asset_id: asset.id,
    } });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/net-worth');
    const row = page.locator('li').filter({ hasText: 'PEL period asset' });
    await row.getByRole('button', { name: /Расходы|Expenses/ }).click();
    const modal = page.getByRole('dialog').filter({ hasText: 'PEL period asset' });
    await expect(modal).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();

    // All time: both bills counted.
    await expect(modal).toContainText('PEL 2025 bill');
    await expect(modal).toContainText('PEL 2024 bill');

    await modal.getByRole('button', { name: /^Год$|^Year$/ }).click();
    // Picking "year" lands on the current year — neither synthetic bill's
    // own year — so the stale all-time total/list must be gone already.
    await expect(modal).not.toContainText('PEL 2025 bill');
    await expect(modal).not.toContainText('PEL 2024 bill');

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    expect((await (await requestWithRateLimit(request, '/api/transactions')).json()).total).toBe(2);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
