import { test, expect } from '../fixtures';
import { requestWithRateLimit } from './helpers';

test('CSV preview imports income, expense and actual transfer once, leaving an ambiguous transfer out', async ({ page, request }) => {
  test.setTimeout(90000);
  const snapshot = await (await request.get('/api/backup/export')).json();
  const empty = Object.fromEntries(Object.entries(snapshot).map(([key, value]) =>
    [key, Array.isArray(value) && !['accounts', 'categories'].includes(key) ? [] : value]));
  const today = new Date().toISOString().slice(0, 10);
  const csv = [
    'Date,Amount,Description,Category,Destination Account,Destination Amount,Currency',
    `${today},-20,P1 CSV groceries,Groceries,,,USD`,
    `${today},50,P1 CSV salary,Salary,,,USD`,
    `${today},-10,P1 CSV transfer,ExpenseTransfer,P1 CSV PLN,38,USD`,
    `${today},-7,P1 CSV unknown transfer,ExpenseTransfer,,,USD`,
  ].join('\n');
  try {
    expect((await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: empty })).ok()).toBeTruthy();
    const source = await (await request.post('/api/accounts', { data: { name: 'P1 CSV USD', currency: 'USD' } })).json();
    const target = await (await request.post('/api/accounts', { data: { name: 'P1 CSV PLN', currency: 'PLN' } })).json();

    const preview = async () => {
      await page.goto('/transactions/import');
      await page.getByRole('combobox').first().selectOption(String(source.id));
      await page.locator('input[type="file"]').setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
      await page.getByRole('button', { name: /Показать превью|Show preview/ }).click();
    };
    await preview();
    await expect(page.getByText(/Готово к импорту: 3|Ready to import: 3/)).toBeVisible();
    await expect(page.getByText(/Строка 5:|Row 5:/)).toContainText(/перевод не импортирован|transfer not imported/);
    await page.getByRole('button', { name: /Импортировать 3|Import 3/ }).click();
    await expect(page.getByText(/добавлено транзакций: 3|3 transactions added/)).toBeVisible();

    const transactions = (await (await requestWithRateLimit(request, '/api/transactions')).json()).items;
    expect(transactions).toHaveLength(3);
    const transfer = transactions.find((item: { description: string }) => item.description === 'P1 CSV transfer');
    expect(transfer.type).toBe('transfer');
    expect(transfer.transfer_account_id).toBe(target.id);
    expect(Number(transfer.destination_amount)).toBe(38);
    const balances = await (await requestWithRateLimit(request, '/api/accounts')).json();
    expect(Number(balances.find((item: { id: number }) => item.id === source.id).balance)).toBe(20);
    expect(Number(balances.find((item: { id: number }) => item.id === target.id).balance)).toBe(38);

    await preview();
    await expect(page.getByText(/Найдено похожих на уже существующие: 3|Similar existing transactions: 3/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Импортировать 0|Import 0/ })).toBeDisabled();
    expect((await (await requestWithRateLimit(request, '/api/transactions')).json()).total).toBe(3);
  } finally {
    const restore = await requestWithRateLimit(request, '/api/backup/import', { method: 'POST', data: snapshot });
    expect(restore.ok(), `Restore failed: ${restore.status()} ${await restore.text()}`).toBeTruthy();
  }
});
