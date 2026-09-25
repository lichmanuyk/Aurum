import { useEffect, useState, type FormEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { useAccounts } from "@/hooks/useAccounts";
import { useAssetMovements, useAssetMovementActions } from "@/hooks/useAssetMovements";
import { formatMoney, formatTransactionDate } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import type { Asset, AssetMovement, AssetMovementInput } from "@/types";

const cashTypes = new Set(["checking", "debit_card", "savings", "cash", "investment"]);
const today = () => new Date().toLocaleDateString("en-CA");
const empty = (asset: Asset, accountId: number): AssetMovementInput => ({
  asset_id: asset.id, account_id: accountId, type: "buy", gross_amount: "", fee_amount: "0",
  asset_value_after: asset.asset_class === "crypto" ? null : asset.current_value,
  quantity: null, price_per_unit: null, date: today(), note: null,
  idempotency_key: crypto.randomUUID(),
});

interface Props { open: boolean; onClose: () => void; asset: Asset | null }

export function AssetMovementModal({ open, onClose, asset }: Props) {
  const { language } = useTranslation();
  const ru = language === "ru";
  const { data: accounts } = useAccounts();
  const { data: movements } = useAssetMovements(open ? asset?.id ?? null : null);
  const { create, update, remove } = useAssetMovementActions();
  const [editing, setEditing] = useState<AssetMovement | null>(null);
  const [form, setForm] = useState<AssetMovementInput | null>(null);
  const [error, setError] = useState("");
  const eligible = accounts?.filter((account) => cashTypes.has(account.type) && !account.is_archived) ?? [];
  const selected = eligible.find((account) => account.id === form?.account_id);

  useEffect(() => {
    if (open && asset) {
      setEditing(null);
      setForm(empty(asset, eligible[0]?.id ?? 0));
      setError("");
    }
  }, [open, asset?.id, asset?.asset_class === "crypto" ? null : asset?.current_value, eligible[0]?.id]);

  if (!asset || !form) return null;
  const isCrypto = asset.asset_class === "crypto";
  const pending = create.isPending || update.isPending || remove.isPending;
  const cash = Number(form.gross_amount || 0) + (form.type === "buy" ? 1 : -1) * Number(form.fee_amount || 0);

  function editMovement(item: AssetMovement) {
    setEditing(item);
    setForm({ asset_id: item.asset_id, account_id: item.account_id, type: item.type,
      gross_amount: item.gross_amount, fee_amount: item.fee_amount,
      asset_value_after: item.asset_value_after, quantity: item.quantity,
      price_per_unit: item.price_per_unit, date: item.date, note: item.note,
      idempotency_key: item.idempotency_key });
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form || !asset) return;
    setError("");
    try {
      if (editing) await update.mutateAsync({ id: editing.id, input: form });
      else await create.mutateAsync(form);
      setEditing(null);
      setForm(empty(asset, form.account_id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function deleteMovement(item: AssetMovement) {
    if (!asset) return;
    if (!window.confirm(ru ? "Удалить покупку/продажу и вернуть деньги на счёт?" : "Delete this trade and reverse its cash movement?")) return;
    try {
      await remove.mutateAsync(item.id);
      if (editing?.id === item.id) { setEditing(null); setForm(empty(asset, item.account_id)); }
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  return <Dialog open={open} onClose={onClose} title={`${ru ? "Покупка и продажа" : "Buy and sell"}: ${asset.name}`}>
    <p className="mb-3 text-xs text-text-muted">{ru ? "Деньги со счёта и изменение актива записываются одной операцией. Покупка не считается расходом, продажа — доходом." : "Cash and asset changes are recorded together. Buys are not expenses; sells are not income."}</p>
    <form onSubmit={submit} className="space-y-3">
      <div><Label htmlFor="movement-type">{ru ? "Операция" : "Operation"}</Label><Select id="movement-type" value={form.type} disabled={Boolean(editing)} onChange={(e) => setForm({ ...form, type: e.target.value as "buy" | "sell" })}><option value="buy">{ru ? "Покупка" : "Buy"}</option><option value="sell">{ru ? "Продажа" : "Sell"}</option></Select></div>
      <div><Label htmlFor="movement-account">{ru ? "Денежный счёт" : "Cash account"}</Label><Select id="movement-account" required value={form.account_id || ""} onChange={(e) => setForm({ ...form, account_id: Number(e.target.value) })}><option value="" disabled>{ru ? "Выберите счёт" : "Choose account"}</option>{eligible.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</Select></div>
      <div><Label htmlFor="movement-gross">{ru ? "Сумма сделки" : "Trade amount"} · {selected?.currency}</Label><Input id="movement-gross" type="number" min="0.01" step="0.01" required value={form.gross_amount} onChange={(e) => setForm({ ...form, gross_amount: e.target.value })} /></div>
      <div><Label htmlFor="movement-fee">{ru ? "Комиссия" : "Fee"} · {selected?.currency}</Label><Input id="movement-fee" type="number" min="0" step="0.01" required value={form.fee_amount} onChange={(e) => setForm({ ...form, fee_amount: e.target.value })} /></div>
      {selected && form.gross_amount && <p className="text-sm text-text-secondary">{form.type === "buy" ? (ru ? "Со счёта уйдёт" : "Account debit") : (ru ? "На счёт придёт" : "Account credit")}: {formatMoney(cash, selected.currency)}</p>}
      {isCrypto ? <>
        <p className="text-xs text-text-muted">{ru ? "Связанную покупку/продажу криптовалюты можно записать только сегодняшней датой. Цена за монету — в валюте актива." : "Linked crypto trades can currently be recorded only for today. Unit price uses the asset currency."}</p>
        <div><Label htmlFor="movement-quantity">{ru ? "Количество монет" : "Coin quantity"}</Label><Input id="movement-quantity" type="number" min="0.000000000000000001" step="any" required value={form.quantity ?? ""} onChange={(e) => setForm({ ...form, quantity: e.target.value || null })} /></div>
        <div><Label htmlFor="movement-price">{ru ? "Цена одной монеты" : "Unit price"} · {asset.currency}</Label><Input id="movement-price" type="number" min="0.000000000000000001" step="any" required value={form.price_per_unit ?? ""} onChange={(e) => setForm({ ...form, price_per_unit: e.target.value || null })} /></div>
      </> : <><p className="text-xs text-text-muted">{ru ? "Для одного актива доступна одна связанная операция в день. Изменить её можно ниже." : "One linked trade per asset per day. You can edit it below."}</p><div><Label htmlFor="movement-value">{ru ? "Стоимость актива после операции" : "Asset value after trade"} · {asset.currency}</Label><Input id="movement-value" type="number" min="0" step="0.01" required value={form.asset_value_after ?? ""} onChange={(e) => setForm({ ...form, asset_value_after: e.target.value })} /></div></>}
      <div><Label htmlFor="movement-date">{ru ? "Дата" : "Date"}</Label><Input id="movement-date" type="date" required disabled={Boolean(editing)} max={isCrypto ? today() : undefined} min={isCrypto ? today() : undefined} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
      <div><Label htmlFor="movement-note">{ru ? "Примечание" : "Note"}</Label><Input id="movement-note" value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.target.value || null })} /></div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2"><Button type="submit" disabled={pending || !selected}>{editing ? (ru ? "Сохранить" : "Save") : (ru ? "Записать операцию" : "Record trade")}</Button>{editing && <Button type="button" variant="secondary" onClick={() => { setEditing(null); setForm(empty(asset, form.account_id)); }}>{ru ? "Отмена" : "Cancel"}</Button>}</div>
    </form>
    <div className="mt-5 border-t border-border pt-3"><h3 className="mb-2 text-sm font-semibold">{ru ? "Связанные операции" : "Linked trades"}</h3>{!movements?.length ? <p className="text-xs text-text-muted">{ru ? "Пока нет" : "None yet"}</p> : <ul className="divide-y divide-gridline">{movements.map((item) => <li key={item.id} className="flex items-center justify-between gap-2 py-2 text-xs"><span>{formatTransactionDate(item.date)} · {item.type === "buy" ? (ru ? "Покупка" : "Buy") : (ru ? "Продажа" : "Sell")} · {formatMoney(item.cash_amount, item.account_currency)} · {item.account_name}</span><span className="flex gap-2"><button type="button" className="text-text-secondary" onClick={() => editMovement(item)}>{ru ? "Изменить" : "Edit"}</button><button type="button" className="text-danger" onClick={() => deleteMovement(item)}>{ru ? "Удалить" : "Delete"}</button></span></li>)}</ul>}</div>
  </Dialog>;
}
