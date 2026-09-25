import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';
import { useTranslation } from '@/lib/i18n';

// Refresh reference rates while the app is in use. Each tab checks on open,
// twice a day, and on focus after 12 hours; failures retry after five minutes.
export function AutoFxRefresh() {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const refresh = useQuery({
    queryKey: ['automatic-fx-refresh'],
    queryFn: async () => {
      const result = await api.post<{ saved: number; absent_currencies: string[] }>('/fx-rates/nbp/latest', {});
      await cache.invalidateQueries({ predicate: query => !['automatic-fx-refresh', 'crypto-performance-90d'].includes(String(query.queryKey[0])) });
      return result;
    },
    staleTime: 12 * 60 * 60 * 1000,
    refetchInterval: query => query.state.status === 'error' ? 5 * 60 * 1000 : 12 * 60 * 60 * 1000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });
  if (!refresh.error && !refresh.data?.absent_currencies.length) return null;
  return <p role="alert" className="mb-4 rounded-lg border border-border p-3 text-sm text-danger">
    {t(refresh.error ? 'quotes.autoFailed' : 'quotes.autoIncomplete')}{' '}
    <Link className="underline" to="/settings">{t('quotes.details')}</Link>{' '}
    <button className="underline" disabled={refresh.isFetching} onClick={() => void refresh.refetch()}>{t('quotes.retry')}</button>
  </p>;
}
