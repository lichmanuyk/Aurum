import { CURRENCIES, getCurrencyLabel } from "@/lib/currency";
import { useTranslation } from "@/lib/i18n";
import { Select } from "@/components/ui/Input";

export function CurrencySelect({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const { language } = useTranslation();
  return <label className="block space-y-1">
    <span className="text-sm">{language === "ru" ? "Валюта" : "Currency"}</span>
    <Select aria-label={language === "ru" ? "Валюта" : "Currency"} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>
      {CURRENCIES.map(c => <option key={c.code} value={c.code}>{getCurrencyLabel(c.code, language)}</option>)}
    </Select>
  </label>;
}
