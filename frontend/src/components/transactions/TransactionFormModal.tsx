import { CurrencySelect } from "@/components/ui/CurrencySelect";
import { getCurrency } from "@/lib/i18n";
import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { TagInput } from "@/components/transactions/TagInput";
import { ExpenseAssetSelect } from "@/components/transactions/ExpenseAssetSelect";
import { MandatoryPaymentFields } from "@/components/transactions/MandatoryPaymentFields";
import { useAccounts } from "@/hooks/useAccounts";
import { useBusinessDate } from "@/hooks/useBusinessDate";
import { useCategories } from "@/hooks/useCategories";
import { useCreateTransaction, useUpdateTransaction } from "@/hooks/useTransactions";
import { useTranslation } from "@/lib/i18n";
import { buildHierarchicalCategories, translateCategoryName } from "@/lib/categoryLabels";
import { formatCurrency } from "@/lib/format";
import type { Tag, Transaction, TransactionInput, TransactionSplitInput, TransactionType, AdjustmentReason, MandatoryPaymentKind } from "@/types";

interface TransactionFormModalProps {
  open: boolean;
  onClose: () => void;
  transaction?: Transaction | null;
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
  // Filled in from the server's business date (see
  // docs/tasks/business-date-timezone.md), never a client-guessed
  // `new Date()` — starts empty and is filled by the effect below the
  // first time that date becomes available, so there's no brief flash of
  // the wrong day before it loads. See the "date" input's own render for
  // the explicit loading/error state while this is still "".
  date: "",
  // "" = no link; an asset id otherwise — only meaningful while
  // type === "expense" and splitMode is off (see
  // docs/tasks/property-expense-links.md). A split's lines carry their own
  // link instead (SplitRowState.expense_asset_id below).
  expense_asset_id: "",
  // Gross-income/mandatory-tax classification — see
  // docs/tasks/income-tax-separation.md. Same "parent only while not
  // splitting" shape as expense_asset_id above.
  assigned_period: null as string | null,
  mandatory_payment_kind: null as MandatoryPaymentKind | null,
};

interface SplitRowState {
  key: string;
  category_id: string;
  amount: string;
  note: string;
  expense_asset_id: string;
  assigned_period: string | null;
  mandatory_payment_kind: MandatoryPaymentKind | null;
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
  return {
    key: generateRowKey(),
    category_id: "",
    amount: "",
    note: "",
    expense_asset_id: "",
    assigned_period: null,
    mandatory_payment_kind: null,
  };
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
  const { businessDate, isError: businessDateError, refetch: retryBusinessDate } = useBusinessDate();
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
        expense_asset_id: transaction.expense_asset_id ? String(transaction.expense_asset_id) : "",
        assigned_period: transaction.assigned_period ?? null,
        mandatory_payment_kind: transaction.mandatory_payment_kind ?? null,
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
              expense_asset_id: split.expense_asset_id ? String(split.expense_asset_id) : "",
              assigned_period: split.assigned_period ?? null,
              mandatory_payment_kind: split.mandatory_payment_kind ?? null,
            }))
          : [emptySplitRow(), emptySplitRow()]
      );
    } else {
      setForm(EMPTY_FORM);
      setTags([]);
      setSplitMode(false);
      setSplitRows([emptySplitRow(), emptySplitRow()]);
    }
    setError(null);
    // Deliberately NOT `allAccounts` — see the accounts-default effect right
    // below, which is split off from this one on purpose. This effect's own
    // job is initializing/resetting the form for a specific open/transaction
    // *identity* (a brand-new blank form, or loading a specific existing
    // transaction to edit) — it must fire exactly once per those, not every
    // time the accounts list happens to re-resolve (the initial GET
    // /api/accounts landing after the modal is already open, or any later
    // background refetch of it, e.g. from creating/editing an account
    // elsewhere). Before this split, either of those re-ran the *whole*
    // reset above mid-edit, silently discarding anything already
    // typed/toggled — amount, date, description, the split rows, and the
    // gross-income/mandatory-tax classification included.
  }, [open, transaction]);

  // The one piece of the reset above that *does* still depend on the
  // accounts list — split into its own effect for exactly the reason the
  // comment above explains. Only ever fills in the *first* available
  // account as a convenience default, and only while: the form is for a
  // brand-new transaction (never overwrites the account on one being
  // edited), and no account has been chosen yet (never overwrites a manual
  // selection, whether that came from the user or from this same effect on
  // an earlier render). Depends on the first account's id specifically, not
  // `allAccounts`/`accounts` themselves, so a refetch that resolves to an
  // equivalent (or even identical) list — same ids, e.g. just a renamed
  // account — is not a new dependency value and does not re-fire this.
  const firstAccountId = accounts?.[0]?.id;
  useEffect(() => {
    if (open && !transaction && !form.account_id && firstAccountId !== undefined) {
      setForm((prev) => (prev.account_id === "" ? { ...prev, account_id: String(firstAccountId) } : prev));
    }
  }, [open, transaction, firstAccountId, form.account_id]);

  // Fills the "today" default in from the server's business date (see
  // docs/tasks/business-date-timezone.md) the first time it becomes
  // available — deliberately a separate effect/dependency from the reset
  // above: the modal often opens before that first GET /api/settings
  // resolves, and this must not wait for (or re-trigger) the whole form
  // reset once it does. Only fires for a brand-new transaction with the
  // date field still untouched — editing an existing one always shows that
  // transaction's own recorded date instead (set above), and any date the
  // user has since typed here is left alone forever after.
  useEffect(() => {
    if (open && !transaction && businessDate && form.date === "") {
      setForm((prev) => (prev.date === "" ? { ...prev, date: businessDate } : prev));
    }
  }, [open, transaction, businessDate, form.date]);

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
        // The parent's own link/classification and a split's lines are
        // mutually exclusive (expense_asset_link_violation,
        // tax_classification_violation) — entering split mode clears the
        // parent's; each line gets its own picker instead.
        setForm((f) => ({ ...f, expense_asset_id: "", assigned_period: null, mandatory_payment_kind: null }));
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
        // Each line carries its own optional asset link — never the
        // parent's (see expense_asset_id below and
        // docs/tasks/property-expense-links.md). Expense-only: the
        // picker itself is already hidden for income (see the split-row
        // render above), this is the belt-and-suspenders guard so a
        // lingering value from before a type switch can never be sent.
        expense_asset_id: form.type === "expense" && row.expense_asset_id ? Number(row.expense_asset_id) : null,
        // Same "each line carries its own" reasoning, for the gross-
        // income/mandatory-tax classification — see
        // docs/tasks/income-tax-separation.md.
        assigned_period: row.assigned_period,
        mandatory_payment_kind: form.type === "expense" ? row.mandatory_payment_kind : null,
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
      // Only a plain (non-split) income/expense row can carry this on the
      // parent (tax_classification_violation) — a split sends null on the
      // parent, same "explicit clear" contract as expense_asset_id below.
      assigned_period: splits && splits.length > 0 ? null : form.assigned_period,
      mandatory_payment_kind: splits && splits.length > 0 ? null : form.mandatory_payment_kind,
      // Only a plain (non-split) expense can carry this on the parent row
      // (expense_asset_link_violation) — anything else always sends null,
      // which both creates "no link" and explicitly clears an existing one
      // on update.
      expense_asset_id:
        form.type === "expense" && !(splits && splits.length > 0) && form.expense_asset_id
          ? Number(form.expense_asset_id)
          : null,
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
              // A link only ever makes sense for an expense (see
              // expense_asset_link_violation) — switching away clears it
              // in the form too, so the next save can't submit a stale
              // combination the backend would reject anyway. Income can
              // still be split (unlike transfer/adjustment), so its split
              // *rows* need their own links cleared too, not just the
              // parent's — otherwise an income transaction's splits would
              // silently keep carrying an expense-only field. The gross-
              // income/mandatory-tax classification (see
              // docs/tasks/income-tax-separation.md) is cleared on every
              // type change too, on both the parent and each split row —
              // simplest way to never carry a stale combination (an
              // expense's kind into income, or either into a
              // transfer/adjustment) across a type switch; re-enabling it
              // for the new type is one click.
              setForm((prev) => ({
                ...prev,
                type: nextType,
                category_id: "",
                expense_asset_id: nextType === "expense" ? prev.expense_asset_id : "",
                assigned_period: null,
                mandatory_payment_kind: null,
              }));
              if (nextType === "transfer" || nextType === "adjustment") setSplitMode(false);
              if (nextType !== "expense") {
                setSplitRows((prev) => prev.map((row) => ({ ...row, expense_asset_id: "" })));
              }
              setSplitRows((prev) => prev.map((row) => ({ ...row, assigned_period: null, mandatory_payment_kind: null })));
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
            {/* Only shown while the "today" default itself hasn't arrived
                yet (new transaction, field still blank) — never a stale
                message once the user has picked/typed any date. */}
            {!transaction && form.date === "" && (
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

            {form.type === "expense" && !splitMode && !form.mandatory_payment_kind && (
              <div className="mt-2">
                <Label htmlFor="expense-asset">{t("transactions.form.expenseAssetLabel")}</Label>
                <ExpenseAssetSelect
                  id="expense-asset"
                  value={form.expense_asset_id}
                  onChange={(value) => setForm((prev) => ({ ...prev, expense_asset_id: value }))}
                />
              </div>
            )}

            {(form.type === "income" || form.type === "expense") && !splitMode && !form.expense_asset_id && (
              <div className="mt-2">
                <MandatoryPaymentFields
                  type={form.type}
                  idPrefix="transaction"
                  assignedPeriod={form.assigned_period}
                  onAssignedPeriodChange={(value) => setForm((prev) => ({ ...prev, assigned_period: value }))}
                  mandatoryPaymentKind={form.mandatory_payment_kind}
                  onMandatoryPaymentKindChange={(value) => setForm((prev) => ({ ...prev, mandatory_payment_kind: value }))}
                />
              </div>
            )}

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
                    {/* A split line's own link is expense-only (see
                        expense_asset_link_violation, schemas/transaction.py)
                        — income can otherwise be split too (unlike
                        transfer/adjustment), so this picker must not be
                        offered there; the type-switch handler above also
                        clears any link already entered before the type
                        changed. */}
                    {form.type === "expense" && !row.mandatory_payment_kind && (
                      <ExpenseAssetSelect
                        className="text-xs"
                        aria-label={t("transactions.form.expenseAssetLabel")}
                        value={row.expense_asset_id}
                        onChange={(value) => updateSplitRow(row.key, { expense_asset_id: value })}
                      />
                    )}
                    {/* Same classification as the parent row (see
                        MandatoryPaymentFields) — each split line's own
                        share of a mixed purchase (part ordinary, part a
                        mandatory tax payment or gross work income) can
                        carry it independently. Hidden once this line has
                        an asset link (mutually exclusive, same as the
                        parent) — clear that first to classify it instead. */}
                    {!row.expense_asset_id && (
                      <MandatoryPaymentFields
                        type={form.type}
                        idPrefix={`split-${row.key}`}
                        assignedPeriod={row.assigned_period}
                        onAssignedPeriodChange={(value) => updateSplitRow(row.key, { assigned_period: value })}
                        mandatoryPaymentKind={row.mandatory_payment_kind}
                        onMandatoryPaymentKindChange={(value) => updateSplitRow(row.key, { mandatory_payment_kind: value })}
                      />
                    )}
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
