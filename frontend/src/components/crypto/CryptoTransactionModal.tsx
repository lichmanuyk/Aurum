import { CurrencySelect } from "@/components/ui/CurrencySelect";
import { getCurrency } from "@/lib/i18n";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Label } from "@/components/ui/Input";
import { useAddCryptoTransaction, useUpdateCryptoTransaction } from "@/hooks/useCrypto";
import { useBusinessDate } from "@/hooks/useBusinessDate";
import { trimTrailingZeros } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CryptoHolding, CryptoTransaction, CryptoTransactionType } from "@/types";

interface CryptoTransactionModalProps {
  open: boolean;
  onClose: () => void;
  holding: CryptoHolding | null;
  // Present -> editing that transaction (pre-filled, PATCHes it). Absent ->
  // recording a new buy/sell against `holding` (the "+" action).
  transaction?: CryptoTransaction | null;
}

/** Buy more of, or sell some of, a coin already being tracked — the "+"
 * action on the holdings table — or edit/view an existing entry from its
 * trade history. Never calls CoinGecko either way (see
 * services/crypto_service.py's add_transaction/update_transaction): value
 * is recomputed from the last cached price. */
export function CryptoTransactionModal({ open, onClose, holding, transaction = null }: CryptoTransactionModalProps) {
  const { t, language } = useTranslation();
  const { businessDate, isError: businessDateError, refetch: retryBusinessDate } = useBusinessDate();
  const addTransaction = useAddCryptoTransaction();
  const updateTransaction = useUpdateCryptoTransaction();
  const isEditing = transaction !== null;

  const [type, setType] = useState<CryptoTransactionType>("buy");
  const [quoteCurrency, setQuoteCurrency] = useState(getCurrency());
  const [quantity, setQuantity] = useState("");
  const [pricePerUnit, setPricePerUnit] = useState("");
  // Filled in from the server's business date (see
  // docs/tasks/business-date-timezone.md) by the effect below — starts
  // empty, never a client-guessed `new Date()`.
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuoteCurrency(transaction?.quote_currency ?? holding?.quote_currency ?? getCurrency());
    if (transaction) {
      setType(transaction.type);
      // The API returns these at full Numeric(38,18) scale (e.g.
      // "3.000000000000000000") — trimmed here so the field shows what was
      // actually entered, not a wall of padding zeros.
      setQuantity(trimTrailingZeros(transaction.quantity));
      setPricePerUnit(transaction.price_per_unit === null ? "" : trimTrailingZeros(transaction.price_per_unit));
      setDate(transaction.date);
      setNote(transaction.note ?? "");
    } else {
      setType("buy");
      setQuantity("");
      setPricePerUnit("");
      // "" (not a re-guessed date) so a modal reopened after being left
      // closed across midnight re-fills from the *current* business date.
      setDate("");
      setNote("");
    }
    setError(null);
  }, [open, holding, transaction]);

  // Fills the "today" default in for a new (non-editing) trade the first
  // time the business date is available — never overwrites a date the user
  // has since edited (guarded by `date === ""`), and never runs at all
  // while editing an existing transaction (its own recorded date is set
  // above instead).
  useEffect(() => {
    if (open && !transaction && businessDate) {
      setDate((current) => (current === "" ? businessDate : current));
    }
  }, [open, transaction, businessDate]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!holding) return;
    setError(null);
    const input = { type, quantity, quote_currency: quoteCurrency, price_per_unit: type === "opening" ? null : pricePerUnit, date, note: note || null };
    try {
      if (transaction) {
        await updateTransaction.mutateAsync({ transactionId: transaction.id, input });
      } else {
        await addTransaction.mutateAsync({ assetId: holding.asset_id, input });
      }
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 400 ? t("crypto.form.errorSellTooMuch") : t("crypto.form.saveError")
      );
    }
  }

  if (!holding) return null;

  const isPending = addTransaction.isPending || updateTransaction.isPending;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isEditing ? t("crypto.form.editTradeTitle", { name: holding.name }) : t("crypto.form.tradeTitle", { name: holding.name })}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <CurrencySelect value={quoteCurrency} onChange={setQuoteCurrency} />
        <div className="grid grid-cols-3 gap-2">
          <button type="button" onClick={() => setType("opening")} className="rounded-lg border px-3 py-2 text-sm">{language === "ru" ? "Остаток" : "Opening"}{type === "opening" ? " ✓" : ""}</button>
          <button
            type="button"
            onClick={() => setType("buy")}
            className={cn(
              "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
              type === "buy" ? "border-success bg-success/10 text-success" : "border-border text-text-secondary"
            )}
          >
            {t("crypto.form.buy")}
          </button>
          <button
            type="button"
            onClick={() => setType("sell")}
            className={cn(
              "rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
              type === "sell" ? "border-danger bg-danger/10 text-danger" : "border-border text-text-secondary"
            )}
          >
            {t("crypto.form.sell")}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="tx-quantity">{t("crypto.form.quantityLabel")}</Label>
            <Input
              id="tx-quantity"
              type="number"
              step="any"
              min="0"
              required
              autoFocus
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="tx-price">{t("crypto.form.pricePerUnitLabel")}</Label>
            <Input
              id="tx-price"
              type="number"
              step="any"
              min="0"
              required
              disabled={type === "opening"}
              value={pricePerUnit}
              onChange={(event) => setPricePerUnit(event.target.value)}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="tx-date">{t("crypto.form.dateLabel")}</Label>
          <Input id="tx-date" type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
          {!transaction && date === "" && (
            businessDateError ? (
              <p className="mt-1 text-xs text-danger">
                {t("businessDate.error")}{" "}
                <button type="button" className="underline" onClick={retryBusinessDate}>
                  {t("businessDate.retry")}
                </button>
              </p>
            ) : (
              <p className="mt-1 text-xs text-text-muted">{t("businessDate.loading")}</p>
            )
          )}
        </div>

        <div>
          <Label htmlFor="tx-note">{t("crypto.form.noteLabel")}</Label>
          <Input id="tx-note" value={note} onChange={(event) => setNote(event.target.value)} />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={isPending}>
            {isPending ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
