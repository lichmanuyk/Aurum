import { useEffect, useState, type FormEvent } from "react";
import { CurrencySelect } from "@/components/ui/CurrencySelect";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { useAccounts } from "@/hooks/useAccounts";
import { useBusinessDate } from "@/hooks/useBusinessDate";
import { useCreateDebt, useUpdateDebt } from "@/hooks/useDebts";
import { getCurrency, useTranslation, type TranslationKey } from "@/lib/i18n";
import type { Debt, DebtDirection, DebtFunding } from "@/types";

interface DebtFormModalProps {
  open: boolean;
  onClose: () => void;
  debt?: Debt | null;
}

const DIRECTIONS: DebtDirection[] = ["owed_to_me", "owed_by_me"];

// `date` starts as "" until the server's business date has loaded — same
// "never a client-guessed new Date()" rule as every other form in the app
// (see AssetMovementModal.tsx's own EMPTY builder).
function emptyForm(currency: string, date: string) {
  return {
    direction: "owed_to_me" as DebtDirection,
    counterparty: "",
    currency,
    principal_amount: "",
    start_date: date,
    due_date: "",
    note: "",
    funding: "opening_balance" as DebtFunding,
    account_id: "",
    issuance_account_amount: "",
    idempotency_key: crypto.randomUUID(),
  };
}

type FormState = ReturnType<typeof emptyForm>;

export function DebtFormModal({ open, onClose, debt }: DebtFormModalProps) {
  const { t } = useTranslation();
  const { businessDate, isError: businessDateError, refetch: retryBusinessDate } = useBusinessDate();
  const { data: accounts } = useAccounts();
  const createDebt = useCreateDebt();
  const updateDebt = useUpdateDebt();

  const [form, setForm] = useState<FormState>(emptyForm(getCurrency(), ""));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (debt) {
      setForm({
        direction: debt.direction,
        counterparty: debt.counterparty,
        currency: debt.currency,
        principal_amount: debt.principal_amount,
        start_date: debt.start_date,
        due_date: debt.due_date ?? "",
        note: debt.note ?? "",
        funding: debt.funding,
        account_id: debt.account_id !== null ? String(debt.account_id) : "",
        issuance_account_amount: debt.issuance_account_amount ?? "",
        idempotency_key: crypto.randomUUID(),
      });
    } else {
      setForm(emptyForm(getCurrency(), ""));
    }
    setError(null);
  }, [open, debt]);

  // Fills "today" in once the business date is available — never
  // overwrites a date the user (or the edit branch above, loading an
  // existing debt's own start_date) already put there.
  useEffect(() => {
    if (open && businessDate) {
      setForm((prev) => (prev.start_date === "" ? { ...prev, start_date: businessDate } : prev));
    }
  }, [open, businessDate]);

  if (!open) return null;

  // Locked once a debt has been "used" — a new loan (cash already moved)
  // or any repayment recorded — see models/debt.py's own docstring and
  // services/debt_service.py's update_debt, the actual enforcement point
  // this only mirrors client-side for a clear explanation instead of a
  // round-trip 409.
  const locked = Boolean(debt) && (debt!.funding === "new_loan" || debt!.repayment_count > 0);
  const eligibleAccounts = accounts?.filter((account) => !account.is_archived) ?? [];
  const selectedAccount = eligibleAccounts.find((account) => account.id === Number(form.account_id));
  const crossCurrency = form.funding === "new_loan" && selectedAccount && selectedAccount.currency !== form.currency;
  const isSaving = createDebt.isPending || updateDebt.isPending;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (form.funding === "new_loan") {
      if (!form.account_id) {
        setError(t("debts.form.saveError"));
        return;
      }
      if (crossCurrency && !form.issuance_account_amount) {
        setError(t("debts.form.issuanceAmountHint"));
        return;
      }
    }

    try {
      if (debt) {
        await updateDebt.mutateAsync({
          id: debt.id,
          input: {
            // Metadata is always editable — see DebtUpdate's own docstring.
            counterparty: form.counterparty,
            due_date: form.due_date || null,
            note: form.note || null,
            // Financial fields are only ever sent while still unlocked —
            // sending them once locked would get an explicit 409 back even
            // when the value is unchanged (see services/debt_service.py's
            // update_debt: presence in the payload is what's checked, not
            // whether the value actually differs).
            ...(locked
              ? {}
              : {
                  direction: form.direction,
                  currency: form.currency,
                  principal_amount: form.principal_amount,
                  start_date: form.start_date,
                }),
          },
        });
      } else {
        await createDebt.mutateAsync({
          direction: form.direction,
          counterparty: form.counterparty,
          currency: form.currency,
          principal_amount: form.principal_amount,
          start_date: form.start_date,
          due_date: form.due_date || null,
          note: form.note || null,
          funding: form.funding,
          idempotency_key: form.idempotency_key,
          ...(form.funding === "new_loan"
            ? {
                account_id: Number(form.account_id),
                ...(crossCurrency ? { issuance_account_amount: form.issuance_account_amount } : {}),
              }
            : {}),
        });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("debts.form.saveError"));
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={debt ? t("debts.form.editTitle", { name: debt.counterparty }) : t("debts.form.createTitle")}>
      <p className="mb-3 text-xs text-text-muted">{t("debts.pageIntro")}</p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <Label htmlFor="debt-direction">{t("debts.form.directionLabel")}</Label>
          <Select
            id="debt-direction"
            value={form.direction}
            disabled={locked}
            onChange={(event) => setForm((prev) => ({ ...prev, direction: event.target.value as DebtDirection }))}
          >
            {DIRECTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`debts.direction.${value}` as TranslationKey)}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="debt-counterparty">{t("debts.form.counterpartyLabel")}</Label>
          <Input
            id="debt-counterparty"
            required
            maxLength={150}
            placeholder={t("debts.form.counterpartyPlaceholder")}
            value={form.counterparty}
            onChange={(event) => setForm((prev) => ({ ...prev, counterparty: event.target.value }))}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <CurrencySelect value={form.currency} disabled={locked} onChange={(currency) => setForm((prev) => ({ ...prev, currency }))} />
          <div>
            <Label htmlFor="debt-principal">{t("debts.form.principalLabel")}</Label>
            <Input
              id="debt-principal"
              type="number"
              min="0.01"
              step="0.01"
              required
              disabled={locked}
              value={form.principal_amount}
              onChange={(event) => setForm((prev) => ({ ...prev, principal_amount: event.target.value }))}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="debt-start-date">{t("debts.form.startDateLabel")}</Label>
            <Input
              id="debt-start-date"
              type="date"
              required
              disabled={locked}
              max={businessDate}
              value={form.start_date}
              onChange={(event) => setForm((prev) => ({ ...prev, start_date: event.target.value }))}
            />
            {form.start_date === "" && (
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
            <Label htmlFor="debt-due-date">{t("debts.form.dueDateLabel")}</Label>
            <Input
              id="debt-due-date"
              type="date"
              min={form.start_date || undefined}
              value={form.due_date}
              onChange={(event) => setForm((prev) => ({ ...prev, due_date: event.target.value }))}
            />
          </div>
        </div>

        {!debt && (
          <div>
            <Label htmlFor="debt-funding">{t("debts.form.fundingLabel")}</Label>
            <Select
              id="debt-funding"
              value={form.funding}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, funding: event.target.value as DebtFunding, account_id: "", issuance_account_amount: "" }))
              }
            >
              <option value="opening_balance">{t("debts.funding.opening_balance")}</option>
              <option value="new_loan">{t("debts.funding.new_loan")}</option>
            </Select>
            <p className="mt-1 text-xs text-text-muted">
              {t(form.funding === "opening_balance" ? "debts.form.fundingOpeningHint" : "debts.form.fundingNewLoanHint")}
            </p>
          </div>
        )}

        {debt && debt.funding === "new_loan" && (
          <p className="rounded-lg bg-surface-2 p-2 text-xs text-text-secondary">
            {t("debts.funding.new_loan")} · {debt.account_name} · {debt.issuance_account_amount} {debt.issuance_account_currency}
          </p>
        )}

        {!debt && form.funding === "new_loan" && (
          <>
            <div>
              <Label htmlFor="debt-account">{t("debts.form.accountLabel")}</Label>
              <Select
                id="debt-account"
                required
                value={form.account_id}
                onChange={(event) => setForm((prev) => ({ ...prev, account_id: event.target.value }))}
              >
                <option value="" disabled>
                  {t("debts.form.accountLabel")}
                </option>
                {eligibleAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency}
                  </option>
                ))}
              </Select>
              {selectedAccount && (
                <p className="mt-1 text-xs text-text-secondary">
                  {t(form.direction === "owed_to_me" ? "debts.form.cashOutHint" : "debts.form.cashInHint")}: {selectedAccount.currency}
                </p>
              )}
            </div>
            {crossCurrency && (
              <div>
                <Label htmlFor="debt-issuance-amount">
                  {t("debts.form.issuanceAmountLabel", { currency: selectedAccount!.currency })}
                </Label>
                <Input
                  id="debt-issuance-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={form.issuance_account_amount}
                  onChange={(event) => setForm((prev) => ({ ...prev, issuance_account_amount: event.target.value }))}
                />
                <p className="mt-1 text-xs text-text-muted">{t("debts.form.issuanceAmountHint")}</p>
              </div>
            )}
          </>
        )}

        <div>
          <Label htmlFor="debt-note">{t("debts.form.noteLabel")}</Label>
          <Input id="debt-note" maxLength={2000} value={form.note} onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))} />
        </div>

        {locked && <p className="text-xs text-text-muted">{t("debts.form.lockedHint")}</p>}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={isSaving}>
            {isSaving ? t("common.saving") : debt ? t("common.save") : t("debts.form.submitCreate")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
