import { test, expect } from '@playwright/test';

test('freshness distinguishes publication dates and preserves visible warnings on refresh failure', async ({ page }) => {
  await page.route('**/api/fx-rates/status', route => route.fulfill({ json: {
    as_of: '2026-09-25', reporting_currency: 'PLN',
    fx: [{ currency: 'EUR', status: 'previous', rate_date: '2026-09-24', saved_at: '2026-09-25T08:00:00Z', sources: ['NBP:A:test'] }],
    crypto: { status: 'stale', last_synced_at: '2026-09-22T08:00:00Z', missing_prices: 0 },
  } }));
  await page.route('**/api/fx-rates/nbp/plan', route => route.fulfill({ json: { end_date: '2026-09-25', currencies: ['EUR'] } }));
  await page.route('**/api/fx-rates/nbp', route => route.fulfill({ status: 502, json: { detail: 'Provider unavailable' } }));
  await page.route('**/api/crypto/refresh', route => route.fulfill({ status: 502, json: { detail: 'Provider unavailable' } }));
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/net-worth');
  const panel = page.getByRole('region', { name: /Свежесть курсов|Quote freshness/ });
  await expect(panel).toContainText('2026-09-24');
  await expect(panel).toContainText(/Предыдущая публикация|Previous publication/);
  await expect(panel).toContainText(/Цены устарели|Prices are stale/);
  await panel.getByRole('button', { name: /Обновить курсы NBP|Update NBP rates/ }).click();
  await expect(panel.getByRole('alert')).toContainText(/Ранее сохранённые курсы не изменены|Previously saved rates were not changed/);
  await panel.getByRole('button', { name: /Обновить цены|Refresh prices/ }).click();
  await expect(panel).toContainText(/Обновление не удалось|Refresh failed/);
  await expect(panel).toContainText('2026-09-24');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});
