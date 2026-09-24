import { createContext, useContext, useState, type ReactNode } from 'react';
import { useTranslation } from '@/lib/i18n';
import { formatCurrency, formatSignedCurrency, formatCryptoAmount } from '@/lib/format';

const CurrencyContext = createContext<string | null>(null);
const choices = ['PLN', 'USD', 'EUR'];
const storageKey = 'aurum:summary-currency';

export function SummaryCurrencyScope({ children }: { children: ReactNode }) {
  const { currency: primary, t } = useTranslation();
  const [selected, setSelected] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored && choices.includes(stored) ? stored : '';
  });
  return <CurrencyContext.Provider value={selected || primary}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <label className="flex items-center gap-2 text-sm">
        {t('summaryCurrency.label')}
        <select className="rounded-lg border border-border bg-surface-1 px-3 py-2" value={selected}
          onChange={event => { setSelected(event.target.value); localStorage.setItem(storageKey, event.target.value); }}>
          <option value="">{t('summaryCurrency.primary', { currency: primary })}</option>
          {choices.map(currency => <option key={currency} value={currency}>{currency}</option>)}
        </select>
      </label>
      <p className="text-xs text-text-muted">{t('summaryCurrency.hint')}</p>
    </div>
    {children}
  </CurrencyContext.Provider>;
}

export function useSummaryCurrency() {
  const scoped = useContext(CurrencyContext);
  const { currency } = useTranslation();
  return scoped ?? currency;
}

export function useSummaryFormat() {
  const selected = useSummaryCurrency();
  return {
    formatCurrency: (amount: number | string, currency = selected) => formatCurrency(amount, currency),
    formatSignedCurrency: (amount: number | string, currency = selected) => formatSignedCurrency(amount, currency),
    formatCryptoAmount: (amount: number | string, currency = selected) => formatCryptoAmount(amount, currency),
  };
}
