import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';
import type { APIRequestContext, Page } from '@playwright/test';

// See docs/tasks/debt-tracking.md: who owes whom, in each debt's own
// native currency; an "opening" debt (existing debt, no cash movement) or
// a "new loan" (real cash through a chosen account); partial/full
// repayment and reversal; never ordinary income/expense/category
// spending; Capital = cash + assets + receivables - liabilities, with
// liabilities surfaced as an explicit subtraction, never a positive slice.

async function isolate(request: APIRequestContext) {
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
  expect((await request.patch('/api/settings', { data: { currency: 'USD' } })).ok()).toBeTruthy();
  return async () => {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  };
}

async function today(request: APIRequestContext): Promise<string> {
  // The server's own business date, not the runner's local clock — see
  // docs/tasks/business-date-timezone.md and every other spec's own
  // "dashboard.end_date" read for the exact same reason.
  const dashboard = await (await request.get('/api/dashboard/summary?period=all')).json();
  return dashboard.end_date;
}

async function accountBalance(request: APIRequestContext, accountId: number): Promise<number> {
  const accounts = await (await request.get('/api/accounts')).json();
  return Number(accounts.find((row: { id: number }) => row.id === accountId).balance);
}

async function makeAccount(request: APIRequestContext, name: string, currency = 'USD') {
  const response = await request.post('/api/accounts', { data: { name, type: 'checking', currency } });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}

/** Opens the "Add debt" dialog and returns its own dialog locator. */
async function openAddDebt(page: Page) {
  await page.goto('/debts');
  await page.getByRole('button', { name: /Добавить долг|Add debt/ }).click();
  return page.getByRole('dialog');
}

function debtRow(page: Page, counterparty: string) {
  return page.locator('li').filter({ hasText: counterparty });
}

test('an opening-balance debt moves no cash either direction; Net Worth shows the liability as an explicit subtraction, never a positive slice', async ({ page, request }) => {
  test.setTimeout(60000);
  const restore = await isolate(request);
  try {
    const account = await makeAccount(request, 'Debts opening account');
    const day = await today(request);
    const balanceBefore = await accountBalance(request, account.id);

    const dialog = await openAddDebt(page);
    await dialog.locator('#debt-counterparty').fill('Opening friend');
    await dialog.locator('#debt-principal').fill('100');
    await dialog.locator('#debt-start-date').fill(day);
    await dialog.getByRole('button', { name: /Добавить долг|Add debt/ }).click();
    await expect(dialog).toBeHidden();
    await expect(debtRow(page, 'Opening friend')).toContainText(/100[.,]00/);

    // A second, liability-direction opening debt — same reporting
    // currency (USD) as the receivable above, so this test's own Net
    // Worth assertions never depend on an FX rate being configured (a
    // dedicated multicurrency test below covers cross-currency amounts
    // directly through the Debts API instead).
    const dialog2 = await openAddDebt(page);
    await dialog2.locator('#debt-direction').selectOption('owed_by_me');
    await dialog2.locator('#debt-counterparty').fill('Opening lender');
    await dialog2.locator('#debt-principal').fill('50');
    await dialog2.locator('#debt-start-date').fill(day);
    await dialog2.getByRole('button', { name: /Добавить долг|Add debt/ }).click();
    await expect(dialog2).toBeHidden();

    // No cash moved at all for either debt.
    expect(await accountBalance(request, account.id)).toBe(balanceBefore);
    const transactions = (await (await request.get('/api/transactions')).json()).items;
    expect(transactions).toEqual([]);

    const summary = await (await request.get('/api/net-worth/summary', { params: { range: 'all' } })).json();
    expect(Number(summary.total_receivables)).toBe(100);
    expect(Number(summary.total_liabilities)).toBe(50);

    await page.goto('/net-worth');
    const allocationCard = page.locator('div.rounded-xl').filter({ has: page.getByText(/^Активы/) }).first();
    // Two matches inside the card by design — the legend chip and the
    // detail row share the same visible label (see AssetAllocationCard.tsx)
    // — .first() only needs to confirm the slice is present at all.
    await expect(allocationCard.getByText(/Мне должны/).first()).toBeVisible();
    await expect(page.getByText(/Обязательства/)).toBeVisible();
    // The liability shows as an explicit negative figure (its own row's
    // last span), and never as one of the allocation bar's own positive
    // segments (only the receivable slice does) — read structurally
    // instead of matching a locale-specific currency symbol/decimal style.
    const calloutAmount = await page.evaluate(() => {
      const label = [...document.querySelectorAll('span')].find((el) => /Обязательства|Liabilities/.test(el.textContent ?? ""));
      const row = label?.parentElement;
      // The amount is the row's other *direct* child — read via
      // `row.children`, not a subtree query, so the label's own nested
      // hint <span> (also technically a "last child", just of the label
      // span rather than the row) is never picked up by mistake.
      const directChildren = row ? Array.from(row.children) : [];
      return directChildren[directChildren.length - 1]?.textContent ?? "";
    });
    expect(calloutAmount.trim().startsWith('-')).toBe(true);
    expect(calloutAmount.replace(/[^\d]/g, '')).toBe('50');
    expect(await allocationCard.getByRole('button', { name: /Обязательства/ }).count()).toBe(0);
  } finally {
    await restore();
  }
});

test('a new loan moves real cash atomically, nets to zero net worth change same-currency, and is never income/expense/category spending', async ({ page, request }) => {
  test.setTimeout(60000);
  const restore = await isolate(request);
  try {
    const account = await makeAccount(request, 'Debts new-loan account');
    const day = await today(request);
    const balanceBefore = await accountBalance(request, account.id);
    const cashBefore = await (await request.get('/api/cash-flow')).json();
    const dashboardBefore = await (await request.get('/api/dashboard/summary?period=all')).json();

    const dialog = await openAddDebt(page);
    await dialog.locator('#debt-counterparty').fill('New loan borrower');
    await dialog.locator('#debt-principal').fill('200');
    await dialog.locator('#debt-start-date').fill(day);
    await dialog.locator('#debt-funding').selectOption('new_loan');
    await dialog.locator('#debt-account').selectOption(String(account.id));
    await dialog.getByRole('button', { name: /Добавить долг|Add debt/ }).click();
    await expect(dialog).toBeHidden();

    // Cash actually left the account (I lent it out)...
    expect(await accountBalance(request, account.id)).toBe(balanceBefore - 200);
    // ...but net worth is unchanged: cash -200, receivable +200.
    const summary = await (await request.get('/api/net-worth/summary')).json();
    expect(Number(summary.current)).toBe(balanceBefore);

    // Never ordinary income/expense/category spending.
    const cashAfter = await (await request.get('/api/cash-flow')).json();
    expect(Number(cashAfter.total_income)).toBe(Number(cashBefore.total_income));
    expect(Number(cashAfter.total_expense)).toBe(Number(cashBefore.total_expense));
    const dashboardAfter = await (await request.get('/api/dashboard/summary?period=all')).json();
    expect(Number(dashboardAfter.spent)).toBe(Number(dashboardBefore.spent));
    expect(Number(dashboardAfter.real_income)).toBe(Number(dashboardBefore.real_income));

    // The linked Transaction shows up in the transaction/account history
    // (it's a real cash event), but only through the Debts page, never
    // through the generic edit/delete routes.
    const transactions = (await (await request.get('/api/transactions')).json()).items;
    const linkedTx = transactions.find((tx: { description: string }) => tx.description.includes('New loan borrower'));
    expect(linkedTx).toBeTruthy();
    expect((await request.patch(`/api/transactions/${linkedTx.id}`, { data: { amount: '999' } })).status()).toBe(409);
    expect((await request.delete(`/api/transactions/${linkedTx.id}`)).status()).toBe(409);

    await page.goto('/transactions');
    await expect(page.getByText('New loan borrower', { exact: false }).first()).toBeVisible();
  } finally {
    await restore();
  }
});

test('a cross-currency new loan requires an explicit actual account amount in the UI, never inferred from a rate', async ({ page, request }) => {
  test.setTimeout(60000);
  const restore = await isolate(request);
  try {
    const usdAccount = await makeAccount(request, 'Debts FX account', 'USD');
    const day = await today(request);

    const dialog = await openAddDebt(page);
    await dialog.locator('#debt-counterparty').fill('FX borrower');
    await dialog.getByLabel(/Валюта|Currency/).selectOption('EUR');
    await dialog.locator('#debt-principal').fill('100');
    await dialog.locator('#debt-start-date').fill(day);
    await dialog.locator('#debt-funding').selectOption('new_loan');
    await dialog.locator('#debt-account').selectOption(String(usdAccount.id));

    // The explicit actual-account-amount field must appear (and be marked
    // required) once the account's own currency (USD) differs from the
    // debt's own (EUR) — submitting without it is already refused by the
    // browser's own native required-field validation before this form's
    // onSubmit ever runs, so there is nothing further to assert about that
    // path here; what matters is that the field exists and is required.
    const issuanceAmount = dialog.locator('#debt-issuance-amount');
    await expect(issuanceAmount).toBeVisible();
    expect(await issuanceAmount.getAttribute('required')).not.toBeNull();

    await issuanceAmount.fill('92.50');
    await dialog.getByRole('button', { name: /Добавить долг|Add debt/ }).click();
    await expect(dialog).toBeHidden();

    const debts = await (await request.get('/api/debts')).json();
    const debt = debts.find((item: { counterparty: string }) => item.counterparty === 'FX borrower');
    // Native debt principal (EUR) and actual cash amount (USD) stay
    // distinct — never one inferred from the other via FX.
    expect(debt.currency).toBe('EUR');
    expect(Number(debt.principal_amount)).toBe(100);
    expect(debt.issuance_account_currency).toBe('USD');
    expect(Number(debt.issuance_account_amount)).toBe(92.5);
  } finally {
    await restore();
  }
});

test('partial then full repayment settles a debt; reversing the repayment reopens it with outstanding restored', async ({ page, request }) => {
  test.setTimeout(60000);
  const restore = await isolate(request);
  try {
    const account = await makeAccount(request, 'Debts repay account');
    const day = await today(request);
    const balanceBefore = await accountBalance(request, account.id);

    // I owe 100 — an opening liability.
    const dialog = await openAddDebt(page);
    await dialog.locator('#debt-direction').selectOption('owed_by_me');
    await dialog.locator('#debt-counterparty').fill('Repay lender');
    await dialog.locator('#debt-principal').fill('100');
    await dialog.locator('#debt-start-date').fill(day);
    await dialog.getByRole('button', { name: /Добавить долг|Add debt/ }).click();
    await expect(dialog).toBeHidden();

    await debtRow(page, 'Repay lender').getByRole('button', { name: /Возврат \/ история|Repay \/ history/ }).click();
    const repayDialog = page.getByRole('dialog');

    // Partial repayment first — repaying a liability moves cash OUT. The
    // debt already reads "Активен" before this too (only a *full*
    // repayment changes that text) — wait on the history row count
    // instead, the one thing that actually only becomes true once the
    // mutation has committed and the UI has refetched.
    await repayDialog.locator('#repay-account').selectOption(String(account.id));
    await repayDialog.locator('#repay-date').fill(day);
    await repayDialog.locator('#repay-amount').fill('40');
    await repayDialog.getByRole('button', { name: /Записать возврат|Record repayment/ }).click();
    await expect(repayDialog.locator('ul li')).toHaveCount(1);
    await expect.poll(() => accountBalance(request, account.id)).toBe(balanceBefore - 40);

    // Full repayment — the "full outstanding" button autofills the
    // remaining 60, settling the debt.
    await repayDialog.getByRole('button', { name: /Весь остаток|Full outstanding/ }).click();
    await expect.poll(async () => Number(await repayDialog.locator('#repay-amount').inputValue())).toBe(60);
    await repayDialog.locator('#repay-date').fill(day);
    await repayDialog.getByRole('button', { name: /Записать возврат|Record repayment/ }).click();
    await expect(repayDialog.getByText(/Закрыт|Settled/)).toBeVisible();
    await expect(repayDialog.locator('ul li')).toHaveCount(2);
    await expect.poll(() => accountBalance(request, account.id)).toBe(balanceBefore - 100);

    // Reverse the full (most recent) repayment — reopens the debt and
    // gives the cash back, dated as a new, separate correction event.
    await repayDialog.getByRole('button', { name: /Отменить|Reverse/ }).first().click();
    await repayDialog.locator('form').filter({ hasText: /Отмена возврата|Reverse the/ }).locator('select').selectOption(String(account.id));
    await repayDialog.locator('form').filter({ hasText: /Отмена возврата|Reverse the/ }).locator('input[type="date"]').fill(day);
    await repayDialog.getByRole('button', { name: /Записать отмену|Record reversal/ }).click();
    await expect(repayDialog.getByText(/Активен|Active/)).toBeVisible();
    await expect(repayDialog.locator('ul li')).toHaveCount(3);
    await expect.poll(() => accountBalance(request, account.id)).toBe(balanceBefore - 40);

    const debts = await (await request.get('/api/debts')).json();
    const debt = debts.find((item: { counterparty: string }) => item.counterparty === 'Repay lender');
    expect(Number(debt.outstanding_amount)).toBe(60);
    expect(debt.status).toBe('active');
  } finally {
    await restore();
  }
});

test('a retried repayment (same idempotency key) never double-charges the account, and the UI shows exactly one entry', async ({ page, request }) => {
  test.setTimeout(60000);
  const restore = await isolate(request);
  try {
    const account = await makeAccount(request, 'Debts idempotency account');
    const day = await today(request);
    const balanceBefore = await accountBalance(request, account.id);

    const debt = await (await request.post('/api/debts', { data: {
      direction: 'owed_to_me', counterparty: 'Idempotent friend', currency: 'USD', principal_amount: '100',
      start_date: day, funding: 'opening_balance', idempotency_key: `debt-${Date.now()}`,
    } })).json();

    const key = `repay-${Date.now()}`;
    const payload = { account_id: account.id, date: day, amount_debt_currency: '40', idempotency_key: key };
    const first = await request.post(`/api/debts/${debt.id}/repayments`, { data: payload });
    expect(first.ok(), await first.text()).toBeTruthy();
    const firstBody = await first.json();

    // A retried request (e.g. a dropped response, then a client retry) —
    // same key, same payload — must resolve to the *same* row, not a
    // second one, and must not move the cash a second time.
    const retry = await request.post(`/api/debts/${debt.id}/repayments`, { data: payload });
    expect(retry.ok(), await retry.text()).toBeTruthy();
    const retryBody = await retry.json();
    expect(retryBody.id).toBe(firstBody.id);

    // direction=owed_to_me: someone else repaying ME is cash coming IN,
    // not out — see debt_service._debt_cash_type.
    expect(await accountBalance(request, account.id)).toBe(balanceBefore + 40);
    const repayments = await (await request.get(`/api/debts/${debt.id}/repayments`)).json();
    expect(repayments).toHaveLength(1);

    await page.goto('/debts');
    await debtRow(page, 'Idempotent friend').getByRole('button', { name: /Возврат \/ история|Repay \/ history/ }).click();
    const repayDialog = page.getByRole('dialog');
    await expect(repayDialog.getByText(/История|History/)).toBeVisible();
    await expect(repayDialog.locator('ul li')).toHaveCount(1);
  } finally {
    await restore();
  }
});

test.describe('mobile viewport (375px)', () => {
  // Real touch dispatch (touchstart/touchend via .tap()), not just a mouse
  // click at a narrow width — `hasTouch` is a browser *context* option, so
  // it has to be set here via test.use(), not mid-test (see
  // donut-chart-interaction.spec.ts's own identical setup).
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('adding a debt and recording a repayment stays inside the viewport and works by touch', async ({ page, request }) => {
    test.setTimeout(60000);
    const restore = await isolate(request);
    try {
      const account = await makeAccount(request, 'Debts mobile account');
      const day = await today(request);

      const dialog = await openAddDebt(page);
      await expect(dialog).toBeVisible();
      let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(375);

      await dialog.locator('#debt-counterparty').tap();
      await dialog.locator('#debt-counterparty').fill('Mobile borrower');
      await dialog.locator('#debt-principal').fill('75');
      await dialog.locator('#debt-start-date').fill(day);
      await dialog.locator('#debt-funding').selectOption('new_loan');
      await dialog.locator('#debt-account').selectOption(String(account.id));
      scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(375);
      await dialog.getByRole('button', { name: /Добавить долг|Add debt/ }).tap();
      await expect(dialog).toBeHidden();

      await debtRow(page, 'Mobile borrower').getByRole('button', { name: /Возврат \/ история|Repay \/ history/ }).tap();
      const repayDialog = page.getByRole('dialog');
      await expect(repayDialog).toBeVisible();
      scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(375);

      await repayDialog.locator('#repay-account').selectOption(String(account.id));
      await repayDialog.locator('#repay-date').fill(day);
      await repayDialog.getByRole('button', { name: /Весь остаток|Full outstanding/ }).tap();
      await repayDialog.getByRole('button', { name: /Записать возврат|Record repayment/ }).tap();
      await expect(repayDialog.getByText(/Закрыт|Settled/)).toBeVisible();
      scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(375);
    } finally {
      await restore();
    }
  });
});
