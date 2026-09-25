import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('custom subcategory and tag stay connected to spending and filters', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  const marker = `P2 ${Date.now()}`;
  const parentName = `${marker} parent`;
  const childName = `${marker} child`;
  const tagName = `${marker} tag`;
  const description = `${marker} purchase`;
  try {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    expect((await request.patch('/api/settings', { data: { currency: 'USD' } })).ok()).toBeTruthy();
    const account = await (await request.post('/api/accounts', { data: { name: `${marker} account`, currency: 'USD' } })).json();

    await page.goto('/categories');
    const createCategory = async (name: string, parent?: string) => {
      await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('#category-name').fill(name);
      if (parent) await dialog.locator('#category-parent').selectOption({ label: parent });
      await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('li').filter({ hasText: name })).toBeVisible();
    };
    await createCategory(parentName);
    await createCategory(childName, parentName);
    const child = (await (await request.get('/api/categories')).json()).find((item: { name: string }) => item.name === childName);

    await page.goto('/transactions');
    await page.getByRole('button', { name: /Добавить|Add/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#type').selectOption('expense');
    await dialog.locator('#account').selectOption(String(account.id));
    await dialog.locator('#amount').fill('25');
    await dialog.locator('#description').fill(description);
    await dialog.locator('#category').selectOption(String(child.id));
    await dialog.getByPlaceholder(/Начните вводить|Type to find/).fill(tagName);
    await dialog.getByRole('button', { name: /Создать тег|Create tag/ }).click();
    await expect(dialog.getByText(tagName, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('li').filter({ hasText: description })).toBeVisible();
    const tag = (await (await request.get('/api/tags')).json()).find((item: { name: string }) => item.name === tagName);
    const read = async (path: string, params?: Record<string, number>) => {
      const response = await requestWithRateLimit(request, path, { params });
      expect(response.ok(), `${path}: ${response.status()}`).toBeTruthy();
      return response.json();
    };
    expect(Number((await read('/api/reports/category-spending', { category_id: child.id })).total_amount)).toBe(25);
    expect((await read('/api/transactions', { category_id: child.id, tag_id: tag.id })).total).toBe(1);

    await page.locator('select').filter({ has: page.locator(`option[value="${child.id}"]`) }).first().selectOption(String(child.id));
    await page.locator('select').filter({ has: page.locator(`option[value="${tag.id}"]`) }).last().selectOption(String(tag.id));
    await expect(page.locator('li').filter({ hasText: description })).toBeVisible();
    await page.goto('/categories');
    await page.locator('li').filter({ hasText: childName }).getByRole('button', { name: /Изменить|Edit/ }).click();
    await page.getByRole('dialog').locator('#category-name').fill(`${childName} renamed`);
    await page.getByRole('dialog').getByRole('button', { name: /Сохранить|Save/ }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    const dialogs: string[] = [];
    page.on('dialog', prompt => { dialogs.push(prompt.message()); void prompt.accept(); });
    await page.locator('li').filter({ hasText: `${childName} renamed` }).getByRole('button', { name: /Удалить|Delete/ }).click();
    await expect.poll(() => dialogs.length).toBe(2);
    expect(dialogs[1]).toMatch(/операц|transactions/);
    expect((await read('/api/transactions', { category_id: child.id, tag_id: tag.id })).total).toBe(1);
    expect(Number((await read('/api/reports/category-spending', { category_id: child.id })).total_amount)).toBe(25);
    await page.goto('/transactions');
    await expect(page.locator('li').filter({ hasText: description })).toContainText(`${childName} renamed`);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
