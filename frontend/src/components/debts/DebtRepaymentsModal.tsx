import { useEffect, useState, type FormEvent } from "react";
import { Undo2, Check, Pencil, Trash2 } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { useAccounts } from "@/hooks/useAccounts";
import { useBusinessDate } from "@/hooks/useBusinessDate";
import { useDebtRepaymentActions, useDebtRepayments } from "@/hooks/useDebts";
import { formatMoney, formatTransactionDate } from "@/lib/format";
import { useTranslation, type TranslationKey } from "@/lib/i18n";
import type { Debt, DebtRepayment } from "@/types";

interface DebtRepaymentsModalProps {
  open: boolean;
  onClose: () => void;
  debt: Debt | null;
}

function emptyRepaymentForm(accountId: number | "", date: string, outstanding: string) {
  return { account_id: accountId, date, amount_debt_currency: outstanding, account_amount: "", note: "", idempotency_key: crypto.randomUUID() };
}

function emptyReverseForm(accountId: number | "", date: string) {
  return { account_id: accountId, date, account_amount: "", note: "", idempotency_key: crypto.randomUUID() };
}

export function DebtRepaymentsModal({ open, onClose, debt }: DebtRepaymentsModalProps) {
  const { t } = useTranslation();
  const { businessDate, isError: businessDateError, refetch: retryBusinessDate } = useBusinessDate();
  const { data: accounts } = useAccounts();
  const { data: repayments } = useDebtRepayments(open ? debt?.id ?? null : null);
  const actions = useDebtRepaymentActions(debt?.id ?? 0);

  const eligibleAccounts = accounts?.filter((account) => !account.is_archived) ?? [];

  const [form, setForm] = useState(emptyRepaymentForm("", "", ""));
  const [error, setError] = useState<string | null>(null);
  const [reversingId, setReversingId] = useState<number | null>(null);
  const [reverseForm, setReverseForm] = useState(emptyReverseForm("", ""));
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    if (open && debt) {
      setForm(emptyRepaymentForm(eligibleAccounts[0]?.id ?? "", businessDate ?? "", debt.outstanding_amount));
      setError(null);
      setReversingId(null);
      setEditingNoteId(null);
    }
    // eligibleAccounts/businessDate deliberately excluded — this resets the
    // whole form on open/debt change only, same "fill-once" split as
    // AssetMovementModal.tsx's own two effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, debt?.id]);

  useEffect(() => {
    if (open && businessDate) {
      setForm((prev) => (prev.date === "" ? { ...prev, date: businessDate } : prev));
    }
  }, [open, businessDate]);

  if (!debt) return null;
  const account = eligibleAccounts.find((item) => item.id === Number(form.account_id));
  const crossCurrency = account && account.currency !== debt.currency;
  const reverseAccount = eligibleAccounts.find((item) => item.id === Number(reverseForm.account_id));
  const reversingRepayment = repayments?.find((item) => item.id === reversingId) ?? null;
  const reverseCrossCurrency = reverseAccount && reverseAccount.currency !== debt.currency;
  const pending = actions.create.isPending || actions.reverse.isPending || actions.remove.isPending || actions.updateNote.isPending;

  async function submitRepayment(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!form.account_id) {
      setError(t("debts.form.saveError"));
      return;
    }
    if (crossCurrency && !form.account_amount) {
      setError(t("debts.form.issuanceAmountHint"));
      return;
    }
    try {
      await actions.create.mutateAsync({
        account_id: Number(form.account_id),
        date: form.date,
        amount_debt_currency: form.amount_debt_currency,
        note: form.note || null,
        idempotency_key: form.idempotency_key,
        ...(crossCurrency ? { account_amount: form.account_amount } : {}),
      });
      // Deliberately not the new outstanding — the just-invalidated `debt`
      // query hasn't refetched yet at this exact moment, so pre-filling
      // from its still-stale value here would risk quietly offering a
      // repeat of the same already-recorded amount instead of an explicit,
      // honest blank the user (or the "full outstanding" button, reading
      // the now-fresh `debt` prop on its own next render) fills in.
      setForm(emptyRepaymentForm(form.account_id, form.date, ""));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("debts.repay.error.saveFailed"));
    }
  }

  function startReverse(repayment: DebtRepayment) {
    setReversingId(repayment.id);
    setReverseForm(emptyReverseForm(repayment.account_id, businessDate ?? repayment.date));
    setError(null);
  }

  async function submitReverse(event: FormEvent) {
    event.preventDefault();
    if (!reversingId) return;
    setError(null);
    if (!reverseForm.account_id) {
      setError(t("debts.form.saveError"));
      return;
    }
    if (reverseCrossCurrency && !reverseForm.account_amount) {
      setError(t("debts.form.issuanceAmountHint"));
      return;
    }
    try {
      await actions.reverse.mutateAsync({
        id: reversingId,
        input: {
          account_id: Number(reverseForm.account_id),
          date: reverseForm.date,
          note: reverseForm.note || null,
          idempotency_key: reverseForm.idempotency_key,
          ...(reverseCrossCurrency ? { account_amount: reverseForm.account_amount } : {}),
        },
      });
      setReversingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("debts.repay.error.saveFailed"));
    }
  }

  async function removeRepayment(repayment: DebtRepayment) {
    if (!window.confirm(t("debts.repay.confirmDelete"))) return;
    setError(null);
    try {
      await actions.remove.mutateAsync(repayment.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("debts.repay.error.saveFailed"));
    }
  }

  function startEditNote(repayment: DebtRepayment) {
    setEditingNoteId(repayment.id);
    setNoteDraft(repayment.note ?? "");
  }

  async function saveNote(repayment: DebtRepayment) {
    setError(null);
    try {
      await actions.updateNote.mutateAsync({ id: repayment.id, input: { note: noteDraft || null } });
      setEditingNoteId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("debts.repay.error.saveFailed"));
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("debts.repay.title", { name: debt.counterparty })}>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="text-text-muted">
          {t("debts.repay.principalLabel")}: <span className="font-medium text-text-primary">{formatMoney(debt.principal_amount, debt.currency)}</span>
        </span>
        <span className="text-text-muted">
          {t("debts.repay.outstandingLabel")}: <span className="font-medium text-text-primary">{formatMoney(debt.outstanding_amount, debt.currency)}</span>
        </span>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-text-secondary">
          {t(debt.status === "active" ? "debts.status.active" : "debts.status.settled")}
        </span>
      </div>

      {debt.status === "settled" ? (
        <p className="mb-3 rounded-lg bg-surface-2 p-2 text-xs text-text-secondary">{t("debts.repay.settledHint")}</p>
      ) : (
        <form onSubmit={submitRepayment} className="mb-4 space-y-3 border-b border-gridline pb-4">
          <div>
            <Label htmlFor="repay-account">{t("debts.repay.accountLabel")}</Label>
            <Select id="repay-account" required value={form.account_id} onChange={(event) => setForm((prev) => ({ ...prev, account_id: Number(event.target.value) }))}>
              <option value="" disabled>
                {t("debts.repay.accountLabel")}
              </option>
              {eligibleAccounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.currency}
                </option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="repay-date">{t("debts.repay.dateLabel")}</Label>
              <Input
                id="repay-date"
                type="date"
                required
                min={debt.start_date}
                max={businessDate}
                value={form.date}
                onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
              />
              {form.date === "" && (
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
              <Label htmlFor="repay-amount">{t("debts.repay.amountLabel", { currency: debt.currency })}</Label>
              <div className="flex gap-1">
                <Input
                  id="repay-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={form.amount_debt_currency}
                  onChange={(event) => setForm((prev) => ({ ...prev, amount_debt_currency: event.target.value }))}
                />
                <Button type="button" variant="secondary" className="shrink-0 px-2 text-xs" onClick={() => setForm((prev) => ({ ...prev, amount_debt_currency: debt.outstanding_amount }))}>
                  {t("debts.repay.fullButton")}
                </Button>
              </div>
            </div>
          </div>
          {crossCurrency && (
            <div>
              <Label htmlFor="repay-account-amount">{t("debts.repay.accountAmountLabel", { currency: account!.currency })}</Label>
              <Input
                id="repay-account-amount"
                type="number"
                min="0.01"
                step="0.01"
                required
                value={form.account_amount}
                onChange={(event) => setForm((prev) => ({ ...prev, account_amount: event.target.value }))}
              />
              <p className="mt-1 text-xs text-text-muted">{t("debts.form.issuanceAmountHint")}</p>
            </div>
          )}
          <div>
            <Label htmlFor="repay-note">{t("debts.repay.noteLabel")}</Label>
            <Input id="repay-note" value={form.note} onChange={(event) => setForm((prev) => ({ ...prev, note: event.target.value }))} />
          </div>
          <Button type="submit" disabled={pending}>
            {t("debts.repay.submitButton")}
          </Button>
        </form>
      )}

      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-text-primary">{t("debts.repay.historyTitle")}</h3>
        {!repayments?.length ? (
          <p className="text-xs text-text-muted">{t("debts.repay.emptyHistory")}</p>
        ) : (
          <ul className="divide-y divide-gridline">
            {repayments.map((repayment) => {
              const rowCrossCurrency = repayment.account_currency !== debt.currency;
              return (
                <li key={repayment.id} className="py-2 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0">
                      <span className="font-medium text-text-primary">{formatTransactionDate(repayment.date, true)}</span>{" "}
                      <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                        {t(`debts.repay.kind.${repayment.kind}` as TranslationKey)}
                      </span>
                      {repayment.is_reversed && (
                        <span className="ml-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                          {t("debts.repay.reversedBadge")}
                        </span>
                      )}
                      {rowCrossCurrency && (
                        <span className="ml-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                          {t("debts.repay.crossCurrencyBadge")}
                        </span>
                      )}
                      <span className="ml-1 text-text-muted">
                        {formatMoney(repayment.amount_debt_currency, debt.currency)}
                        {rowCrossCurrency && ` (${formatMoney(repayment.account_amount, repayment.account_currency)})`}
                        {" "}
                        {t("debts.repay.viaAccount", { account: repayment.account_name })}
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-1">
                      {repayment.kind === "repayment" && !repayment.is_reversed && (
                        <button type="button" aria-label={t("debts.repay.reverseButton")} onClick={() => startReverse(repayment)} className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
                          <Undo2 size={14} />
                        </button>
                      )}
                      <button type="button" aria-label={t("common.edit")} onClick={() => startEditNote(repayment)} className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-text-primary">
                        <Pencil size={14} />
                      </button>
                      <button type="button" aria-label={t("common.delete")} onClick={() => removeRepayment(repayment)} className="rounded-md p-1 text-text-muted hover:bg-surface-2 hover:text-danger">
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </div>

                  {editingNoteId === repayment.id && (
                    <div className="mt-1.5 flex gap-1.5">
                      <Input value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder={t("debts.repay.noteLabel")} className="h-8" />
                      <Button type="button" className="h-8 px-2" onClick={() => saveNote(repayment)} disabled={actions.updateNote.isPending}>
                        <Check size={14} />
                      </Button>
                      <Button type="button" variant="ghost" className="h-8 px-2" onClick={() => setEditingNoteId(null)}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                  )}
                  {editingNoteId !== repayment.id && repayment.note && <p className="mt-1 text-text-muted">{repayment.note}</p>}

                  {reversingId === repayment.id && reversingRepayment && (
                    <form onSubmit={submitReverse} className="mt-2 space-y-2 rounded-lg bg-surface-2 p-2">
                      <p className="text-xs font-medium text-text-primary">{t("debts.repay.reverseTitle", { date: formatTransactionDate(reversingRepayment.date, true) })}</p>
                      <div>
                        <Select
                          required
                          value={reverseForm.account_id}
                          onChange={(event) => setReverseForm((prev) => ({ ...prev, account_id: Number(event.target.value) }))}
                        >
                          <option value="" disabled>
                            {t("debts.repay.accountLabel")}
                          </option>
                          {eligibleAccounts.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name} · {item.currency}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Input type="date" required min={reversingRepayment.date} max={businessDate} value={reverseForm.date} onChange={(event) => setReverseForm((prev) => ({ ...prev, date: event.target.value }))} />
                        {reverseCrossCurrency && (
                          <Input
                            type="number"
                            min="0.01"
                            step="0.01"
                            required
                            placeholder={t("debts.repay.accountAmountLabel", { currency: reverseAccount!.currency })}
                            value={reverseForm.account_amount}
                            onChange={(event) => setReverseForm((prev) => ({ ...prev, account_amount: event.target.value }))}
                          />
                        )}
                      </div>
                      <Input placeholder={t("debts.repay.noteLabel")} value={reverseForm.note} onChange={(event) => setReverseForm((prev) => ({ ...prev, note: event.target.value }))} />
                      <div className="flex gap-2">
                        <Button type="submit" className="h-8 px-3 text-xs" disabled={actions.reverse.isPending}>
                          {t("debts.repay.reverseSubmit")}
                        </Button>
                        <Button type="button" variant="ghost" className="h-8 px-3 text-xs" onClick={() => setReversingId(null)}>
                          {t("common.cancel")}
                        </Button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
