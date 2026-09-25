import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('a goal contribution leaves cash alone and asset valuation changes capital only from its date', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    expect((await request.patch('/api/settings', { data: { currency: 'USD' } })).ok()).toBeTruthy();
    const account = await (await request.post('/api/accounts', { data: { name: 'P1 goal cash', currency: 'USD' } })).json();
    expect((await request.post('/api/transactions', { data: {
      account_id: account.id, type: 'adjustment', amount: '1000', adjustment_reason: 'opening_balance',
      description: 'P1 goal opening', date: today,
    } })).ok()).toBeTruthy();
    const balance = async () => Number((await (await requestWithRateLimit(request, '/api/accounts')).json())
      .find((row: { id: number }) => row.id === account.id).balance);
    const capital = async () => Number((await (await requestWithRateLimit(request, '/api/net-worth/summary')).json()).current);

    await page.goto('/goals');
    await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
    let dialog = page.getByRole('dialog');
    await dialog.locator('#goal-name').fill('P1 reserve goal');
    await dialog.locator('#goal-target').fill('500');
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(dialog).toBeHidden();
    const goal = page.locator('li').filter({ hasText: 'P1 reserve goal' });
    await goal.getByRole('button', { name: /Добавить взнос|Add contribution/ }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('#contribution-account').selectOption(String(account.id));
    await dialog.locator('#contribution-amount').fill('300');
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(dialog).toBeHidden();
    await expect(goal).toContainText(/300[,.]00/);
    expect(await balance()).toBe(1000);
    expect(Number((await (await request.get('/api/accounts')).json()).find((row: { id: number }) => row.id === account.id).available_balance)).toBe(700);
    expect(await capital()).toBe(1000);

    const asset = await (await request.post('/api/assets', { data: {
      name: 'P1 valued asset', asset_class: 'other', currency: 'USD', value: '200', as_of_date: today,
    } })).json();
    expect(await capital()).toBe(1200);
    await page.goto('/net-worth');
    const assetRow = page.locator('li').filter({ hasText: 'P1 valued asset' }).last();
    await assetRow.getByRole('button', { name: /Изменить|Edit/ }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('#asset-value').fill('250');
    await dialog.locator('#asset-date').fill(tomorrow);
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await (await requestWithRateLimit(request, `/api/assets/${asset.id}/valuations`)).json()).length).toBe(2);
    expect(await capital()).toBe(1200);

    await assetRow.getByRole('button', { name: /Изменить|Edit/ }).click();
    dialog = page.getByRole('dialog');
    await dialog.locator('#asset-value').fill('220');
    await dialog.locator('#asset-date').fill(today);
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(capital).toBe(1220);
    expect(await balance()).toBe(1000);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
