import { test as base, expect } from '@playwright/test';

// Keep browser regressions independent of live NBP availability. Tests for
// automatic refresh override this route explicitly to exercise failure/retry.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/api/fx-rates/nbp/latest', route => route.fulfill({ json: { saved: 0, absent_currencies: [] } }));
    await use(page);
  },
});
export { expect };
