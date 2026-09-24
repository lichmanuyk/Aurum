import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/api/client';
import { useTranslation } from '@/lib/i18n';

// Refresh reference rates while the app is in use. Each tab checks on open,
// hourly, and on focus after an hour; failed requests retry after five minutes.
export function AutoFxRefresh() {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const refresh = useQuery({
    queryKey: ['automatic-fx-refresh'],
    queryFn: async () => {
      const result = await api.post<{ saved: number; absent_currencies: string[] }>('/fx-rates/nbp/latest', {});
      await cache.invalidateQueries({ predicate: query => query.queryKey[0] !== 'automatic-fx-refresh' });
      return result;
    },
    staleTime: 60 * 60 * 1000,
    refetchInterval: query => query.state.status === 'error' ? 5 * 60 * 1000 : 60 * 60 * 1000,
    retry: false,
  });
  if (!refresh.error && !refresh.data?.absent_currencies.length) return null;
  return <p role="alert" className="mb-4 rounded-lg border border-border p-3 text-sm text-danger">
    {t(refresh.error ? 'quotes.autoFailed' : 'quotes.autoIncomplete')}{' '}
    <Link className="underline" to="/settings">{t('quotes.details')}</Link>{' '}
    <button className="underline" disabled={refresh.isFetching} onClick={() => void refresh.refetch()}>{t('quotes.retry')}</button>
  </p>;
}
