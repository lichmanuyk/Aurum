import { QuoteFreshness } from "./QuoteFreshness";
import { NbpImport } from "./NbpImport";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CurrencySelect } from "@/components/ui/CurrencySelect";
import { getCurrency, useTranslation } from "@/lib/i18n";

type Rate = { id?: number; base_currency: string; quote_currency: string; rate_date: string; rate: string; source: string };
export function FxRatesCard() {
  const { language } = useTranslation();
  const ru = language === "ru";
  const cache = useQueryClient();
  const [form, setForm] = useState<Rate>({ base_currency: "EUR", quote_currency: getCurrency(), rate_date: new Date().toISOString().slice(0, 10), rate: "", source: "manual" });
  const [error, setError] = useState("");
  const query = useQuery({ queryKey: ["fx-rates"], queryFn: () => api.get<Rate[]>("/fx-rates") });
  const preflight = useQuery({ queryKey: ["money-preflight"], queryFn: () => api.get<{ unresolved_transfer_ids: number[]; unresolved_crypto_trade_ids: number[] }>("/fx-rates/preflight") });
  const save = useMutation({ mutationFn: (items: Rate[]) => api.post<Rate[]>("/fx-rates/bulk", { items }), onSuccess: async () => { setError(""); await cache.invalidateQueries(); }, onError: (e: Error) => setError(e.message) });
  async function importFile(file?: File) {
    if (!file) return;
    try {
      const payload: unknown = JSON.parse(await file.text());
      if (!Array.isArray(payload)) throw new Error(ru ? "Ожидается JSON-массив курсов" : "Expected a JSON array of rates");
      save.mutate(payload as Rate[]);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return <Card><CardHeader><CardTitle>{ru ? "Справочные курсы валют" : "Reference exchange rates"}</CardTitle></CardHeader>
    <CardContent className="space-y-3">
      <QuoteFreshness />
      <NbpImport />
      <p className="text-sm text-text-muted">{ru ? "Справочные курсы используются для оценки капитала и пересчёта отчётов в одну валюту. Они не меняют фактически списанные и полученные суммы переводов. Курс конкретного обмена задаётся его двумя суммами в форме перевода. Для выходных используется предыдущий курс, не старше 7 дней." : "Reference rates value capital and convert reports into one currency. They do not change the amounts actually sent and received in transfers. Each exchange uses the two amounts entered in its transfer form. Previous rates may be used for up to 7 days."}</p>
      {preflight.data && (preflight.data.unresolved_transfer_ids.length > 0 || preflight.data.unresolved_crypto_trade_ids.length > 0) && <p role="alert" className="text-danger">{ru ? "Требуется уточнение старых данных" : "Legacy data needs review"}: transfers [{preflight.data.unresolved_transfer_ids.join(", ")}], crypto [{preflight.data.unresolved_crypto_trade_ids.join(", ")}].</p>}
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={e => { e.preventDefault(); save.mutate([form]); }}>
        <CurrencySelect value={form.base_currency} onChange={base_currency => setForm({ ...form, base_currency })} />
        <CurrencySelect value={form.quote_currency} onChange={quote_currency => setForm({ ...form, quote_currency })} />
        <label>{ru ? "Дата курса" : "Rate date"}<Input type="date" required value={form.rate_date} onChange={e => setForm({ ...form, rate_date: e.target.value })} /></label>
        <label>{`1 ${form.base_currency} = … ${form.quote_currency}`}<Input aria-label="FX rate" type="number" step="any" min="0.000000000000000001" required value={form.rate} onChange={e => setForm({ ...form, rate: e.target.value })} /></label>
        <Button disabled={save.isPending || form.base_currency === form.quote_currency}>{ru ? "Сохранить курс" : "Save rate"}</Button>
      </form>
      <label className="block text-sm">{ru ? "Загрузить курсы из JSON" : "Import rates from JSON"}<input className="mt-2 block" type="file" accept="application/json,.json" disabled={save.isPending} onChange={e => void importFile(e.target.files?.[0])} /></label>
      <details className="text-xs"><summary>{ru ? "Формат файла" : "File format"}</summary><pre className="overflow-auto">{JSON.stringify([{ base_currency: "EUR", quote_currency: "PLN", rate_date: "2026-01-01", rate: "4.25", source: "manual" }], null, 2)}</pre></details>
      {(error || query.error) && <p role="alert" className="text-danger">{error || query.error?.message}</p>}
      <p className="text-xs text-text-muted">{ru ? `Последние ${Math.min(query.data?.length ?? 0, 100)} из ${query.data?.length ?? 0} курсов` : `Latest ${Math.min(query.data?.length ?? 0, 100)} of ${query.data?.length ?? 0} rates`}</p>
      <div className="max-h-64 overflow-auto"><table className="w-full text-sm"><tbody>{query.data?.slice(0, 100).map(r => <tr key={r.id}><td>{r.rate_date}</td><td>{r.base_currency} → {r.quote_currency}</td><td>{r.rate.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}</td><td>{r.source}</td><td><button type="button" onClick={() => setForm(r)}>{ru ? "Изменить" : "Edit"}</button></td></tr>)}</tbody></table></div>
    </CardContent></Card>;
}
