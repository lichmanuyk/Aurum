import { CurrencySelect } from "@/components/ui/CurrencySelect";
import { getCurrency } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { TagInput } from "@/components/transactions/TagInput";
import { useAccounts } from "@/hooks/useAccounts";
import { useCategories } from "@/hooks/useCategories";
import { useCreateTransaction, useUpdateTransaction } from "@/hooks/useTransactions";
import { useTranslation } from "@/lib/i18n";
import { buildHierarchicalCategories, translateCategoryName } from "@/lib/categoryLabels";
import { formatCurrency } from "@/lib/format";
import type { Tag, Transaction, TransactionInput, TransactionSplitInput, TransactionType, AdjustmentReason } from "@/types";

interface TransactionFormModalProps {
  open: boolean;
  onClose: () => void;
  transaction?: Transaction | null;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const EMPTY_FORM = {
  type: "expense" as TransactionType,
  account_id: "",
  category_id: "",
  transfer_account_id: "",
  amount: "",
  destination_amount: "",
  adjustment_reason: "opening_balance" as AdjustmentReason,
  description: "",
  merchant: "",
  notes: "",
  date: todayIso(),
};

interface SplitRowState {
  key: string;
  category_id: string;
  amount: string;
  note: string;
}

// crypto.randomUUID() only exists in secure contexts (HTTPS/localhost) — on plain
// HTTP (e.g. accessing the app by LAN IP) it's undefined and throws a TypeError.
// This key is only a local React list key, never sent to the backend, so a
// Math.random()-based fallback is fine when the Web Crypto API isn't available.
function generateRowKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `split-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function emptySplitRow(): SplitRowState {
  return { key: generateRowKey(), category_id: "", amount: "", note: "" };
}

// Cents, not floats — a plain Number sum of "0.10" + "0.20" style amounts can
// drift from the transaction total by fractions of a cent, which would
// falsely trip the "must add up exactly" check the backend also enforces.
// Ledger precision extends cents to millionths, with integer arithmetic throughout.
function toCents(value: string): bigint {
  if (!/^\d*(?:\.\d{0,6})?$/.test(value)) return 0n;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole || "0") * 1000000n + BigInt(fraction.padEnd(6, "0"));
}

export function TransactionFormModal({ open, onClose, transaction }: TransactionFormModalProps) {
  const { t, language } = useTranslation();
  const { data: allAccounts } = useAccounts(true);
  const accounts = allAccounts?.filter(a => !a.is_archived || a.id === transaction?.account_id || a.id === transaction?.transfer_account_id);
  const { data: categories } = useCategories();
  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();

  const [form, setForm] = useState(EMPTY_FORM);
  const [overrideAmount, setOverrideAmount] = useState("");
  const [overrideCurrency, setOverrideCurrency] = useState(getCurrency());
  const [tags, setTags] = useState<Tag[]>([]);
  const [splitMode, setSplitMode] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitRowState[]>([emptySplitRow(), emptySplitRow()]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOverrideAmount(transaction?.reporting_amount_override ?? "");
    setOverrideCurrency(transaction?.reporting_currency_override ?? getCurrency());
    if (transaction) {
      const hasSplits = transaction.splits.length > 0;
      // A split's categories always share one parent (see
      // routes/transactions.py's _build_splits) — derive that shared base
      // from whichever split's category is still live. If every split's
      // category was since deleted, there's nothing to derive from; the
      // base field is left blank and the user has to pick one again.
      const baseCategory = hasSplits ? transaction.splits.find((split) => split.category)?.category : null;
      setForm({
        type: transaction.type,
        adjustment_reason: transaction.adjustment_reason ?? "opening_balance",
        account_id: String(transaction.account_id),
        category_id: hasSplits
          ? baseCategory
            ? String(baseCategory.parent_id ?? baseCategory.id)
            : ""
          : transaction.category_id
            ? String(transaction.category_id)
            : "",
        transfer_account_id: transaction.transfer_account_id ? String(transaction.transfer_account_id) : "",
        amount: transaction.amount,
        destination_amount: transaction.destination_amount ?? "",
        description: transaction.description,
        merchant: transaction.merchant ?? "",
        notes: transaction.notes ?? "",
        date: transaction.date,
      });
      setTags(transaction.tags);
      setSplitMode(hasSplits);
      setSplitRows(
        hasSplits
          ? transaction.splits.map((split) => ({
              key: String(split.id),
              category_id: split.category_id ? String(split.category_id) : "",
              amount: split.amount,
              note: split.note ?? "",
            }))
          : [emptySplitRow(), emptySplitRow()]
      );
    } else {
      setForm({ ...EMPTY_FORM, account_id: accounts?.[0] ? String(accounts[0].id) : "" });
      setTags([]);
      setSplitMode(false);
      setSplitRows([emptySplitRow(), emptySplitRow()]);
    }
    setError(null);
  }, [open, transaction, allAccounts]);

  const kindCategories = (categories ?? []).filter((category) =>
    form.type === "income" ? category.kind === "income" : category.kind === "expense"
  );
  // Subcategories are listed right under their parent (not scattered by
  // name) so the hierarchy set up on the Categories page reads the same way
  // here.
  const relevantCategories = buildHierarchicalCategories(kindCategories, language);

  const sourceCurrency = accounts?.find(a => a.id === Number(form.account_id))?.currency;
  const destinationCurrency = accounts?.find(a => a.id === Number(form.transfer_account_id))?.currency;
  const crossCurrency = sourceCurrency !== destinationCurrency;
  const isSaving = createTransaction.isPending || updateTransaction.isPending;

  function updateSplitRow(key: string, patch: Partial<SplitRowState>) {
    setSplitRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function addSplitRow() {
    setSplitRows((prev) => [...prev, emptySplitRow()]);
  }

  function removeSplitRow(key: string) {
    setSplitRows((prev) => (prev.length <= 2 ? prev : prev.filter((row) => row.key !== key)));
  }

  const isSplitEditingNow = (form.type === "income" || form.type === "expense") && splitMode;
  const splitAllocatedCents = splitRows.reduce((sum, row) => sum + toCents(row.amount), 0n);
  const splitRemainingCents = toCents(form.amount) - splitAllocatedCents;

  // The category select becomes the split's "base" category while
  // splitting — restricted to top-level categories — and each split row can
  // only pick that base itself or one of its direct children (see
  // routes/transactions.py's _build_splits: a split's categories always
  // share one parent).
  const topLevelCategories = relevantCategories.filter((category) => !category.indented);
  const baseChildCategories = kindCategories.filter((category) => category.parent_id === Number(form.category_id));
  const categorySelectOptions = splitMode ? topLevelCategories : relevantCategories;

  function toggleSplitMode() {
    setSplitMode((prev) => {
      const next = !prev;
      if (next) {
        const current = relevantCategories.find((category) => String(category.id) === form.category_id);
        if (current?.parent_id) {
          setForm((f) => ({ ...f, category_id: String(current.parent_id) }));
        }
        setSplitRows([emptySplitRow(), emptySplitRow()]);
      }
      return next;
    });
  }

  function handleBaseCategoryChange(value: string) {
    setForm((prev) => ({ ...prev, category_id: value }));
    if (splitMode) setSplitRows([emptySplitRow(), emptySplitRow()]);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    if (!form.account_id) {
      setError(t("transactions.form.errorSelectAccount"));
      return;
    }
    if (form.type === "transfer" && !form.transfer_account_id) {
      setError(t("transactions.form.errorSelectDestination"));
      return;
    }
    if (form.type === "transfer" && form.transfer_account_id === form.account_id) {
      setError(t("transactions.form.errorSameAccount"));
      return;
    }

    // Undefined -> leave the transaction's existing splits untouched on
    // update, and create a normal single-category transaction. [] -> clears
    // splits that used to be there (the user turned split mode off, or
    // switched the transaction to a transfer, which can't carry splits).
    let splits: TransactionSplitInput[] | undefined;
    if (isSplitEditingNow) {
      if (!form.category_id) {
        setError(t("transactions.form.errorSplitNoBaseCategory"));
        return;
      }
      const filledRows = splitRows.filter((row) => row.category_id || row.amount);
      if (filledRows.length < 2) {
        setError(t("transactions.form.errorSplitMinRows"));
        return;
      }
      if (filledRows.some((row) => !row.category_id || !row.amount || Number(row.amount) <= 0)) {
        setError(t("transactions.form.errorSplitIncomplete"));
        return;
      }
      const allocatedCents = filledRows.reduce((sum, row) => sum + toCents(row.amount), 0n);
      if (allocatedCents !== toCents(form.amount)) {
        setError(t("transactions.form.errorSplitMismatch"));
        return;
      }
      splits = filledRows.map((row) => ({
        category_id: Number(row.category_id),
        amount: row.amount,
        note: row.note || null,
      }));
    } else if (transaction && transaction.splits.length > 0) {
      splits = [];
    }

    const payload: TransactionInput = {
      type: form.type,
      account_id: Number(form.account_id),
      category_id:
        (form.type === "transfer" || form.type === "adjustment") || (splits && splits.length > 0)
          ? null
          : form.category_id
            ? Number(form.category_id)
            : null,
      transfer_account_id: form.type === "transfer" ? Number(form.transfer_account_id) : null,
      amount: form.amount,
      adjustment_reason: form.type === "adjustment" ? form.adjustment_reason : null,
      destination_amount: form.type === "transfer" ? (crossCurrency ? form.destination_amount : form.amount) : null,
      reporting_amount_override: (form.type === "income" || form.type === "expense") && overrideAmount ? overrideAmount : null,
      reporting_currency_override: (form.type === "income" || form.type === "expense") && overrideAmount ? overrideCurrency : null,
      reporting_override_source: (form.type === "income" || form.type === "expense") && overrideAmount ? (overrideAmount === transaction?.reporting_amount_override && overrideCurrency === transaction?.reporting_currency_override ? transaction.reporting_override_source : "manual") : null,
      description: form.description,
      merchant: form.merchant || null,
      notes: form.notes || null,
      date: form.date,
      tag_ids: tags.map((tag) => tag.id),
      splits,
    };

    try {
      if (transaction) {
        await updateTransaction.mutateAsync({ id: transaction.id, input: payload });
      } else {
        await createTransaction.mutateAsync(payload);
      }
      onClose();
    } catch {
      setError(t("transactions.form.saveError"));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={transaction ? t("transactions.form.editTitle") : t("transactions.form.newTitle")}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <Label htmlFor="type">{t("transactions.form.typeLabel")}</Label>
          <Select
            id="type"
            value={form.type}
            onChange={(event) => {
              const nextType = event.target.value as TransactionType;
              setForm((prev) => ({ ...prev, type: nextType, category_id: "" }));
              if (nextType === "transfer" || nextType === "adjustment") setSplitMode(false);
            }}
          >
            <option value="expense">{t("transactions.form.typeExpense")}</option>
            <option value="income">{t("transactions.form.typeIncome")}</option>
            <option value="transfer">{t("transactions.form.typeTransfer")}</option>
            <option value="adjustment">{t("transactions.form.typeAdjustment")}</option>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="amount">{form.type === "transfer" ? (language === "ru" ? "Фактически списано" : "Actually sent") : t("transactions.form.amountLabel")}</Label>
            <Input
              id="amount"
              type="number"
              step="0.000001"
              min={form.type === "adjustment" ? undefined : "0.000001"}
              required
              value={form.amount}
              onChange={(event) => setForm((prev) => ({ ...prev, amount: event.target.value }))}
            />
          </div>
          <div>
            <Label htmlFor="date">{t("transactions.form.dateLabel")}</Label>
            <Input
              id="date"
              type="date"
              required
              value={form.date}
              onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="description">{t("transactions.form.descriptionLabel")}</Label>
          <Input
            id="description"
            required
            placeholder={t("transactions.form.descriptionPlaceholder")}
            value={form.description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          />
        </div>

        <div>
          <Label htmlFor="account">{t("transactions.form.accountLabel")}</Label>
          <Select
            id="account"
            required
            value={form.account_id}
            onChange={(event) => setForm((prev) => ({ ...prev, account_id: event.target.value }))}
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
        </div>

        {form.type === "adjustment" ? (
          <div><Label htmlFor="adjustment_reason">{t("transactions.adjustmentReason")}</Label>
            <Select id="adjustment_reason" value={form.adjustment_reason} onChange={e => setForm({ ...form, adjustment_reason: e.target.value as AdjustmentReason })}>
              <option value="opening_balance">{t("transactions.openingBalance")}</option>
              <option value="reconciliation">{t("transactions.reconciliation")}</option>
              <option value="migration">{t("transactions.migration")}</option>
            </Select><p className="mt-2 text-xs text-text-muted">{t("transactions.adjustmentHint")}</p>
          </div>
        ) : form.type === "transfer" ? (
          <div>
            <Label htmlFor="transfer_account">{t("transactions.form.transferAccountLabel")}</Label>
            <Select
              id="transfer_account"
              required
              value={form.transfer_account_id}
              onChange={(event) => setForm((prev) => ({ ...prev, transfer_account_id: event.target.value }))}
            >
              <option value="" disabled>
                {t("transactions.form.selectAccount")}
              </option>
              {accounts
                ?.filter((account) => String(account.id) !== form.account_id)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </Select>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="category">{t("transactions.form.categoryLabel")}</Label>
              <button
                type="button"
                className="mb-1 text-xs text-series-1 hover:underline"
                onClick={toggleSplitMode}
              >
                {splitMode ? t("transactions.form.splitToggleOff") : t("transactions.form.splitToggle")}
              </button>
            </div>

            <Select
              id="category"
              value={form.category_id}
              onChange={(event) => handleBaseCategoryChange(event.target.value)}
            >
              <option value="">{t("transactions.form.noCategory")}</option>
              {categorySelectOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.indented ? `    ↳ ` : ""}
                  {translateCategoryName(category.name)}
                </option>
              ))}
            </Select>

            {splitMode && (
              <div className="mt-2 space-y-2">
                {!form.category_id ? (
                  <p className="text-xs text-text-muted">{t("transactions.form.splitHint")}</p>
                ) : baseChildCategories.length === 0 ? (
                  <p className="text-xs text-text-muted">{t("transactions.form.splitNoChildren")}</p>
                ) : (
                  <p className="text-xs text-text-muted">{t("transactions.form.splitHint")}</p>
                )}
                {splitRows.map((row) => (
                  <div key={row.key} className="space-y-1.5 rounded-lg border border-border bg-surface-1 p-2">
                    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2">
                      <Select
                        aria-label={t("transactions.form.splitCategoryPlaceholder")}
                        className="sm:flex-1"
                        value={row.category_id}
                        disabled={!form.category_id}
                        onChange={(event) => updateSplitRow(row.key, { category_id: event.target.value })}
                      >
                        <option value="" disabled>
                          {t("transactions.form.splitCategoryPlaceholder")}
                        </option>
                        {form.category_id && (
                          <option value={form.category_id}>{t("transactions.form.splitDirectOption")}</option>
                        )}
                        {baseChildCategories.map((category) => (
                          <option key={category.id} value={category.id}>
                            {translateCategoryName(category.name)}
                          </option>
                        ))}
                      </Select>
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="number"
                          step="0.000001"
                          min={form.type === "adjustment" ? undefined : "0.000001"}
                          className="w-24"
                          placeholder={t("transactions.form.amountLabel")}
                          value={row.amount}
                          onChange={(event) => updateSplitRow(row.key, { amount: event.target.value })}
                        />
                        <button
                          type="button"
                          aria-label={t("transactions.form.splitRemoveRow")}
                          onClick={() => removeSplitRow(row.key)}
                          disabled={splitRows.length <= 2}
                          className="shrink-0 rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-danger disabled:opacity-30"
                        >
                          <X size={15} />
                        </button>
                      </div>
                    </div>
                    <Input
                      className="text-xs"
                      placeholder={t("transactions.form.splitNotePlaceholder")}
                      value={row.note}
                      onChange={(event) => updateSplitRow(row.key, { note: event.target.value })}
                    />
                  </div>
                ))}

                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={addSplitRow}
                    className="flex items-center gap-1 rounded-md py-1 text-xs text-series-1 hover:underline"
                  >
                    <Plus size={14} />
                    {t("transactions.form.splitAddRow")}
                  </button>
                  <p className={`text-xs ${splitRemainingCents === 0n ? "text-success" : "text-text-muted"}`}>
                    {splitRemainingCents > 0
                      ? t("transactions.form.splitRemainingLabel", {
                          amount: formatCurrency(Number(splitRemainingCents) / 1000000, sourceCurrency),
                        })
                      : splitRemainingCents < 0
                        ? t("transactions.form.splitOverAllocatedLabel", {
                            amount: formatCurrency(Math.abs(Number(splitRemainingCents)) / 1000000, sourceCurrency),
                          })
                        : t("transactions.form.splitFullyAllocatedLabel")}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        <div>
          <Label htmlFor="merchant">{t("transactions.form.merchantLabel")}</Label>
          <Input
            id="merchant"
            value={form.merchant}
            onChange={(event) => setForm((prev) => ({ ...prev, merchant: event.target.value }))}
          />
        </div>

        <div>
          <Label htmlFor="notes">{t("transactions.form.notesLabel")}</Label>
          {/* Matches the server's max_length on notes — without it an overlong
              note only fails on save, as an untranslated 422. */}
          <Input
            id="notes"
            maxLength={2000}
            value={form.notes}
            onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
          />
        </div>

        <div>
          <Label htmlFor="transaction-tags">{t("transactions.form.tagsLabel")}</Label>
          <TagInput value={tags} onChange={setTags} />
        </div>

        {(form.type === "income" || form.type === "expense") && <details open={Boolean(overrideAmount)}>
          <summary className="text-sm">{language === "ru" ? "Фактическая сумма для отчёта (необязательно)" : "Actual reporting amount (optional)"}</summary>
          <CurrencySelect value={overrideCurrency} onChange={setOverrideCurrency} />
          <Input aria-label="Reporting amount override" type="number" min="0.000001" step="0.000001" value={overrideAmount} onChange={e => setOverrideAmount(e.target.value)} />
        </details>}
        {form.type === "transfer" && crossCurrency && <label className="block text-sm">
          {language === "ru" ? "Фактически получено" : "Actually received"} ({destinationCurrency})
          <Input aria-describedby="transfer-amount-help" type="number" min="0.000001" step="0.000001" required value={form.destination_amount} onChange={e => setForm(prev => ({ ...prev, destination_amount: e.target.value }))} />
        </label>}
        {form.type === "transfer" && crossCurrency && <p id="transfer-amount-help" className="text-xs text-text-muted">{language === "ru" ? "Укажите сумму, которую реально получили. Она сохраняется только в этом переводе: другие обмены и обновление справочных курсов её не изменят. Этот перевод не меняет справочный курс." : "Enter the amount you actually received. It is saved for this transfer only: other exchanges and reference rate updates will not change it. This transfer does not change the reference rate."}</p>}
        <p className="text-xs text-text-muted">{language === "ru" ? "Валюта списания" : "Source currency"}: {sourceCurrency}</p>
        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={isSaving}>
            {isSaving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
