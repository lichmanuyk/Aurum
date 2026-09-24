import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/lib/i18n';

type Plan = { start_date: string; end_date: string; currencies: string[] };
type Coverage = { complete: boolean; start_date: string; end_date: string; reporting_currency: string;
  items: { currency: string; missing_days: number; missing_ranges: { start_date: string; end_date: string }[] }[] };
const moveDay = (day: string, offset: number) => {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};

export function NbpImport() {
  const { language } = useTranslation();
  const ru = language === 'ru';
  const cache = useQueryClient();
  const [progress, setProgress] = useState('');
  const [saved, setSaved] = useState(0);
  const [protectedCount, setProtectedCount] = useState(0);
  const coverage = useQuery({ queryKey: ['fx-coverage'], queryFn: () => api.get<Coverage>('/fx-rates/coverage') });
  const load = useMutation({
    mutationFn: async (full: boolean) => {
      setSaved(0); setProtectedCount(0); setProgress('');
      const plan = await api.get<Plan>('/fx-rates/nbp/plan');
      if (!plan.currencies.length) return;
      const start = full ? plan.start_date : [plan.start_date, moveDay(plan.end_date, -14)].sort().at(-1)!;
      // Newest intervals first; every completed interval is durable and retries
      // are idempotent. Closing this page stops further requests, not saved work.
      for (let end = plan.end_date; end >= start;) {
        const from = [start, moveDay(end, -92)].sort().at(-1)!;
        setProgress(`${from} — ${end}`);
        const result = await api.post<{ saved: number; protected: number }>('/fx-rates/nbp', {
          start_date: from, end_date: end, currencies: plan.currencies,
        });
        setSaved(value => value + result.saved);
        setProtectedCount(value => value + result.protected);
        end = moveDay(from, -1);
      }
    },
    onSettled: async () => { await cache.invalidateQueries(); },
  });
  return <div className="space-y-3 rounded-lg border border-border p-3">
    <p className="text-sm font-medium">{ru ? 'Официальные курсы NBP' : 'Official NBP rates'}</p>
    <p className="text-xs text-text-muted">{ru
      ? 'Загрузка из Национального банка Польши. Выбираются валюты и период вашей истории, включая архивные счета. Ручные курсы и суммы операций сохраняются.'
      : 'Download from the National Bank of Poland for the currencies and dates in your history, including archived accounts. Manual rates and transaction amounts are preserved.'}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={load.isPending} onClick={() => load.mutate(true)}>{ru ? 'Загрузить всю историю' : 'Load full history'}</Button>
      <Button disabled={load.isPending} onClick={() => load.mutate(false)}>{ru ? 'Обновить последние курсы' : 'Update recent rates'}</Button>
    </div>
    {load.isPending && <p role="status" className="text-sm">{ru ? 'Загрузка' : 'Loading'}: {progress || '…'}. {ru ? 'Сохранено' : 'Saved'}: {saved}</p>}
    {load.isSuccess && <p role="status" className="text-sm">{ru ? 'Загрузка завершена. Сохранено курсов' : 'Download complete. Rates saved'}: {saved}. {ru ? 'Сохранено ручных значений без замены' : 'Manual values preserved'}: {protectedCount}.</p>}
    {load.error && <p role="alert" className="text-sm text-danger">{load.error.message} {ru ? 'Завершённые интервалы сохранены; загрузку можно повторить.' : 'Completed intervals are saved; you can retry.'}</p>}
    {coverage.error && <p role="alert" className="text-sm text-danger">{coverage.error.message}</p>}
    {coverage.data && <div className="text-xs text-text-muted">
      <p>{coverage.data.complete
        ? (ru ? 'Курсы покрывают всю историю' : 'Rates cover the full history')
        : (ru ? 'В курсах есть пробелы' : 'Rate coverage has gaps')}: {coverage.data.start_date} — {coverage.data.end_date} ({coverage.data.reporting_currency}).</p>
      {!coverage.data.complete && <details className="mt-2"><summary>{ru ? 'Показать пробелы' : 'Show gaps'}</summary>
        {coverage.data.items.filter(item => item.missing_days > 0).map(item => <div key={item.currency} className="mt-1">
          {item.currency}: {item.missing_days} {ru ? 'дней' : 'days'}
          <ul>{item.missing_ranges.map(range => <li key={range.start_date}>{range.start_date} — {range.end_date}</li>)}</ul>
        </div>)}
      </details>}
    </div>}
    <p className="text-xs text-text-muted"><a className="underline" href="https://api.nbp.pl/en.html" target="_blank" rel="noreferrer">NBP API</a> · {ru ? 'Без API-ключа. Даты публикаций сохраняются.' : 'No API key. Publication dates are preserved.'}</p>
  </div>;
}
