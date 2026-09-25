import { test, expect } from '../fixtures';
import { makeHolding } from '../../frontend/src/test/cryptoFixtures';

test('opening crypto quantity has unknown cost and keeps its last quote through a provider failure', async ({ page }) => {
  let created = false;
  let price = 100;
  let unavailable = false;
  let submitted: Record<string, unknown> | null = null;
  await page.route('**/api/crypto/search?*', route => route.fulfill({ json: [
    { coingecko_id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', thumb_url: null },
  ] }));
  await page.route('**/api/crypto/holdings', async route => {
    submitted = route.request().postDataJSON();
    created = true;
    await route.fulfill({ json: makeHolding({ coingecko_id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', quantity: '2', current_price: '100', value: '200', cost_basis: null, avg_buy_price: null, profit_loss: null }) });
  });
  await page.route('**/api/crypto/holdings?*', route => route.fulfill({ json: {
    synced: false, last_synced_at: '2026-09-25T08:00:00Z', error_key: unavailable ? 'unreachable' : null,
    holdings: created ? [makeHolding({ coingecko_id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', quantity: '2',
      current_price: String(price), value: String(2 * price), cost_basis: null, avg_buy_price: null, profit_loss: null })] : [],
  } }));

  await page.goto('/crypto');
  await page.getByRole('button', { name: /Добавить монету|Add coin/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder(/Найти монету|Find a coin/).fill('Bitcoin');
  await dialog.getByRole('button', { name: /Bitcoin/ }).click();
  await dialog.getByRole('checkbox', { name: /цена покупки неизвестна|purchase cost unknown/ }).check();
  await dialog.locator('#crypto-quantity').fill('2');
  await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
  await expect(dialog).toBeHidden();
  expect(submitted).toMatchObject({ coingecko_id: 'bitcoin', quantity: '2', price_per_unit: null });
  const row = page.getByRole('row').filter({ hasText: 'Bitcoin' });
  await expect(row).toContainText('2 BTC');
  await expect(row).toContainText(/200[,.]00/);
  await expect(row).not.toContainText(/-100[,.]00/);

  price = 125;
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: 'Bitcoin' })).toContainText(/250[,.]00/);
  unavailable = true;
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: 'Bitcoin' })).toContainText(/250[,.]00/);
  await expect(page.getByText(/не удалось|unavailable|недоступен/i).first()).toBeVisible();
});
