import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { useRefreshCryptoPrices } from '@/hooks/useCrypto';
import { useTranslation } from '@/lib/i18n';

export type QuoteStatus = {
  as_of: string; reporting_currency: string;
  fx: { currency: string; status: 'current' | 'previous' | 'missing'; rate_date: string | null; saved_at: string | null; sources: string[] }[];
  crypto: { status: 'empty' | 'missing' | 'stale' | 'current'; last_synced_at: string | null; missing_prices: number };
};

export function QuoteFreshness({ compact = false }: { compact?: boolean }) {
  const { t, language } = useTranslation();
  const cache = useQueryClient();
  const status = useQuery({ queryKey: ['quote-status'], queryFn: () => api.get<QuoteStatus>('/fx-rates/status'), refetchInterval: 60000 });
  const crypto = useRefreshCryptoPrices();
  const fx = useMutation({
    mutationFn: async () => {
      const plan = await api.get<{ end_date: string; currencies: string[] }>('/fx-rates/nbp/plan');
      if (!plan.currencies.length) return;
      const start = new Date(`${plan.end_date}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() - 14);
      await api.post('/fx-rates/nbp', { start_date: start.toISOString().slice(0, 10), end_date: plan.end_date, currencies: plan.currencies });
    },
    onSettled: () => cache.invalidateQueries(),
  });
  const time = (value: string) => new Date(value).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-US');
  const data = status.data;
  if (compact && data?.crypto.status === 'empty' && !status.error) return null;
  return <section aria-label={t('quotes.title')} className="space-y-2 rounded-xl border border-border p-4 text-sm">
    {!compact && <h2 className="font-medium">{t('quotes.title')}</h2>}
    {status.isPending && <p>{t('common.loading')}</p>}
    {status.error && <p role="alert" className="text-danger">{t('quotes.statusError')}</p>}
    {data && <>
      {!compact && <>
      <p className="text-xs text-text-muted">{t('quotes.fxHint', { currency: data.reporting_currency, date: data.as_of })}</p>
      {!data.fx.length && <p>{t('quotes.noFx')}</p>}
      {data.fx.map(item => <div key={item.currency} className="text-xs">
        <p className={item.status === 'missing' ? 'text-danger' : undefined}>
          {item.currency} → {data.reporting_currency}: {item.rate_date ?? t('quotes.missing')} · {t(`quotes.fx.${item.status}`)}
        </p>
        {item.saved_at && <p className="text-text-muted">{t('quotes.savedAt', { time: time(item.saved_at) })} · {item.sources.join(', ')}</p>}
      </div>)}
      {!!data.fx.length && <Button variant="secondary" disabled={fx.isPending} onClick={() => fx.mutate()}>{fx.isPending ? t('quotes.updating') : t('quotes.updateFx')}</Button>}
      {fx.isSuccess && <p role="status">{t('quotes.fxDone')}</p>}
      {fx.error && <p role="alert" className="text-danger">{t('quotes.fxFailed')}</p>}
      </>}
      {data.crypto.status !== 'empty' && <div className="space-y-2">
        <p>{t('quotes.cryptoTime')}: {data.crypto.last_synced_at ? time(data.crypto.last_synced_at) : t('quotes.missing')}</p>
        {(!compact || data.crypto.status !== 'current') && <p className={data.crypto.status !== 'current' ? 'text-danger' : 'text-text-muted'}>{t(`quotes.crypto.${data.crypto.status}`)}</p>}
        <Button variant="secondary" disabled={crypto.isPending} onClick={() => crypto.mutate()}>{crypto.isPending ? t('quotes.updating') : t('crypto.refreshButton')}</Button>
        {(crypto.error || crypto.data?.error_key) && <p role="alert" className="text-danger">{crypto.data?.error_key ? t(`crypto.syncError.${crypto.data.error_key}`) : t('quotes.cryptoFailed')}</p>}
        {crypto.data?.synced && !crypto.isPending && <p role="status">{t('quotes.cryptoDone')}</p>}
      </div>}
    </>}
  </section>;
}
