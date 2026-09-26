import { useEffect, useState } from "react";
import { ApiError } from "@/api/client";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { useAccounts } from "@/hooks/useAccounts";
import { useInvalidateRecurring, usePostRecurring } from "@/hooks/useRecurring";
import { useTranslation } from "@/lib/i18n";
import type { RecurringTransaction } from "@/types";

interface RecurringPaymentModalProps {
  open: boolean;
  onClose: () => void;
  recurring: RecurringTransaction | null;
}

/** Confirms the *actual* amount/account of one expense template's payment
 * (a utility bill, say) — see docs/tasks/recurring-variable-payments.md.
 * The template's own stored amount/account never change; this only ever
 * posts one ordinary expense Transaction dated today. Income/transfer
 * templates keep their prior (RecurringPage's own window.prompt-based)
 * flow — this modal is expense-only. */
export function RecurringPaymentModal({ open, onClose, recurring }: RecurringPaymentModalProps) {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const postRecurring = usePostRecurring();
  const invalidateRecurring = useInvalidateRecurring();

  const [accountId, setAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const [currencyChanged, setCurrencyChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Retrying is pointless once the server has told us *why* — either the
  // payment already went through (a lost response) or the template can't
  // be posted right now at all — so further submission stays blocked
  // until the user closes and reopens on fresh data.
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    if (!open || !recurring) return;
    setAccountId(String(recurring.account_id));
    setAmount(recurring.amount);
    setCurrencyChanged(false);
    setError(null);
    setBlocked(false);
  }, [open, recurring]);

  if (!recurring) return null;
  // TS doesn't retain the null-narrowing above inside nested closures
  // (handleSubmit is defined further down) — a local const does.
  const recurringId = recurring.id;

  const selectedCurrency = accounts?.find((account) => String(account.id) === accountId)?.currency ?? recurring.currency;

  function handleAccountChange(nextAccountId: string) {
    const previousCurrency = accounts?.find((account) => String(account.id) === accountId)?.currency;
    const nextCurrency = accounts?.find((account) => String(account.id) === nextAccountId)?.currency;
    setAccountId(nextAccountId);
    // A different-currency account can't keep the old number under a new
    // label — the actual amount always needs a fresh, explicit entry.
    if (nextCurrency !== previousCurrency) {
      setAmount("");
      setCurrencyChanged(true);
    } else {
      setCurrencyChanged(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (postRecurring.isPending || blocked) return;
    setError(null);

    if (!accountId) {
      setError(t("transactions.form.errorSelectAccount"));
      return;
    }
    if (!amount) {
      setError(t("recurring.payment.currencyChanged"));
      return;
    }

    try {
      await postRecurring.mutateAsync({ id: recurringId, amount, account_id: Number(accountId) });
      onClose();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setBlocked(true);
        if (caught.code === "ALREADY_POSTED") {
          // The response to an earlier, actually-successful submit was
          // lost and this is the retry — a real Transaction exists that
          // the client doesn't know about yet, so balances/reports need
          // the full refresh, not just the template list.
          setError(t("recurring.payment.alreadyPosted"));
          await invalidateRecurring(true);
        } else {
          // TEMPLATE_INACTIVE / TEMPLATE_NOT_DUE — nothing was posted by
          // this attempt, so there's nothing to reconcile beyond the
          // template's own (possibly now-stale) due/active state.
          setError(t("recurring.payment.notDue"));
          await invalidateRecurring(false);
        }
      } else {
        setError(t("recurring.payment.saveError"));
      }
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("recurring.payment.title", { name: recurring.description })}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <Label htmlFor="recurring-payment-amount">{t("transactions.form.amountLabel")}</Label>
          <Input
            id="recurring-payment-amount"
            type="number"
            step="0.01"
            min="0.01"
            required
            autoFocus
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setCurrencyChanged(false);
            }}
          />
          <p className="mt-1 text-xs text-text-muted">
            {currencyChanged ? t("recurring.payment.currencyChanged") : t("recurring.payment.amountHint")}
          </p>
        </div>

        <div>
          <Label htmlFor="recurring-payment-account">{t("transactions.form.accountLabel")}</Label>
          <Select
            id="recurring-payment-account"
            required
            value={accountId}
            onChange={(event) => handleAccountChange(event.target.value)}
          >
            <option value="" disabled>
              {t("transactions.form.selectAccount")}
            </option>
            {accounts?.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-text-muted">
            {t("recurring.payment.currencyLabel")}: {selectedCurrency}
          </p>
        </div>

        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={postRecurring.isPending || blocked}>
            {postRecurring.isPending ? t("recurring.payment.confirming") : t("recurring.payment.confirm")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
