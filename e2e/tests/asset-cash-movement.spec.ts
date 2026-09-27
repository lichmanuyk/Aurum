import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('buy and sell an asset from an account without counting trades as income or spending', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  try {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    expect((await request.patch('/api/settings', { data: { currency: 'USD' } })).ok()).toBeTruthy();
    // The server's own "today" (used everywhere balances/reports clamp to
    // an end date), not the test runner's local clock: near midnight the
    // two can legitimately disagree by a day (e.g. CI host in a timezone
    // ahead of the container's UTC clock), which would silently date
    // every fixture below "tomorrow" from the server's point of view and
    // exclude them from every balance/report query — see
    // docs/project-roadmap.md's limitations note on this exact case.
    const dashboard = await (await request.get('/api/dashboard/summary?period=all')).json();
    const today: string = dashboard.end_date;
    const account = await (await request.post('/api/accounts', { data: { name: 'Asset flow USD', type: 'checking', currency: 'USD' } })).json();
    const asset = await (await request.post('/api/assets', { data: { name: 'Asset flow test', asset_class: 'investments', currency: 'USD', value: '0', as_of_date: today } })).json();
    expect((await request.post('/api/transactions', { data: { account_id: account.id, type: 'adjustment', amount: '1000', adjustment_reason: 'opening_balance', description: 'Test opening', date: today } })).ok()).toBeTruthy();
    const balance = async () => Number((await (await request.get('/api/accounts')).json()).find((row: { id: number }) => row.id === account.id).balance);
    const value = async () => Number((await (await request.get('/api/assets')).json()).find((row: { id: number }) => row.id === asset.id).current_value);
    const capital = async () => Number((await (await request.get('/api/net-worth/summary')).json()).current);
    const flow = async () => (await request.get('/api/cash-flow')).json();
    await page.goto('/net-worth');
    // Narrowed to the "Buy and sell" action specifically — AssetsTable now
    // has a second per-row button sharing the same "{name}: …" aria-label
    // prefix (the "Expenses" action, see docs/tasks/property-expense-links.md).
    await page.getByRole('button', { name: /Asset flow test:.*(Покупка и продажа|Buy and sell)/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#movement-account').selectOption(String(account.id));
    await dialog.locator('#movement-gross').fill('300');
    await dialog.locator('#movement-value').fill('300');
    // The form defaults this to the *browser's* local today() (see
    // AssetMovementModal.tsx) — pinned to the server's own today so this
    // trade is never dated "tomorrow" from the server's point of view.
    await dialog.locator('#movement-date').fill(today);
    await dialog.getByRole('button', { name: /Записать операцию|Record trade/ }).click();
    await expect(dialog.locator('li').filter({ hasText: 'Asset flow USD' })).toContainText(/300/);
    expect(await balance()).toBe(700);
    expect(await value()).toBe(300);
    expect(await capital()).toBe(1000);
    expect(Number((await flow()).total_expense)).toBe(0);
    expect(Number((await flow()).total_income)).toBe(0);
    await dialog.getByRole('button', { name: /Изменить|Edit/ }).click();
    await dialog.locator('#movement-gross').fill('320');
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect.poll(balance).toBe(680);
    await expect.poll(capital).toBe(980);
    page.once('dialog', confirmation => confirmation.accept());
    await dialog.getByRole('button', { name: /Удалить|Delete/ }).click();
    await expect(dialog.getByText(/Пока нет|None yet/)).toBeVisible();
    expect(await balance()).toBe(1000);
    expect(await value()).toBe(0);
    expect(await capital()).toBe(1000);
    expect(Number((await flow()).total_expense)).toBe(0);
    await dialog.locator('#movement-gross').fill('300');
    await dialog.locator('#movement-value').fill('300');
    // The form reset to a fresh browser-local today() after the previous
    // submit — pin it again, same reason as the first trade above.
    await dialog.locator('#movement-date').fill(today);
    await dialog.getByRole('button', { name: /Записать операцию|Record trade/ }).click();
    await expect.poll(balance).toBe(700);
    await dialog.locator('#movement-gross').fill('200');
    await dialog.locator('#movement-value').fill('500');
    await dialog.locator('#movement-date').fill(today);
    await dialog.getByRole('button', { name: /Записать операцию|Record trade/ }).click();
    await expect(dialog.locator('li')).toHaveCount(2);
    expect(await balance()).toBe(500);
    expect(await value()).toBe(500);
    expect(await capital()).toBe(1000);
    page.once('dialog', confirmation => confirmation.accept());
    await dialog.locator('li').filter({ hasText: '200' }).getByRole('button', { name: /Удалить|Delete/ }).click();
    await expect(dialog.locator('li')).toHaveCount(1);
    expect(await balance()).toBe(700);
    expect(await value()).toBe(300);
    page.once('dialog', confirmation => confirmation.accept());
    await dialog.locator('li').getByRole('button', { name: /Удалить|Delete/ }).click();
    await expect(dialog.getByText(/Пока нет|None yet/)).toBeVisible();
    expect(await balance()).toBe(1000);
    expect(await value()).toBe(0);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
