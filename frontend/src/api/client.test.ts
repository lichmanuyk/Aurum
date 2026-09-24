import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from './client';

vi.mock('@/lib/auth', () => ({ getAuthHeader: () => null, clearCredentials: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
it('preserves structured missing-FX details instead of returning a zero result', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({detail:{code:'FX_RATE_MISSING',base_currency:'EUR',quote_currency:'PLN',date:'2026-01-02'}}),{status:409})));
  await expect(api.get('/cash-flow')).rejects.toMatchObject({status:409,message:expect.stringContaining('EUR → PLN, 2026-01-02')});
});
it('handles successful empty delete responses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null,{status:204})));
  await expect(api.delete('/tags/1')).resolves.toBeUndefined();
});
it('surfaces non-JSON outages without pretending the request succeeded', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Service unavailable',{status:503})));
  await expect(api.get('/accounts')).rejects.toBeInstanceOf(ApiError);
});
it('retains exact amount strings in write requests', async () => {
  const fetch=vi.fn().mockResolvedValue(new Response('{}',{status:200}));vi.stubGlobal('fetch',fetch);
  await api.post('/transactions',{amount:'999999999999.123456'});
  expect(JSON.parse(fetch.mock.calls[0][1].body).amount).toBe('999999999999.123456');
});
