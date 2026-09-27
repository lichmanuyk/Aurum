import { Input, Label, Select } from "@/components/ui/Input";
import { monthInputToPeriod, periodToMonthInput } from "@/lib/period";
import { useTranslation } from "@/lib/i18n";
import type { MandatoryPaymentKind, TransactionType } from "@/types";

interface MandatoryPaymentFieldsProps {
  /** Only "income" and "expense" ever render anything — see
   * docs/tasks/income-tax-separation.md. */
  type: TransactionType;
  assignedPeriod: string | null; // "YYYY-MM-01" or null
  onAssignedPeriodChange: (value: string | null) => void;
  mandatoryPaymentKind: MandatoryPaymentKind | null; // expense-only
  onMandatoryPaymentKindChange: (value: MandatoryPaymentKind | null) => void;
  idPrefix: string;
}

/** Shared "gross work income" (income) / "mandatory payment" (expense)
 * classification fields — see docs/tasks/income-tax-separation.md. Reused
 * by TransactionFormModal (parent row and each split line) and
 * RecurringFormModal (template-level kind only, no period there — see that
 * component). Setting a kind without a period (or vice versa) is rejected
 * by the backend on an EXPENSE row (tax_classification_violation); this
 * component keeps both fields in lockstep so that combination is never
 * submitted in the first place. */
export function MandatoryPaymentFields({
  type,
  assignedPeriod,
  onAssignedPeriodChange,
  mandatoryPaymentKind,
  onMandatoryPaymentKindChange,
  idPrefix,
}: MandatoryPaymentFieldsProps) {
  const { t } = useTranslation();

  if (type === "income") {
    const checked = assignedPeriod !== null;
    return (
      <div className="rounded-lg border border-border bg-surface-1 p-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) =>
              onAssignedPeriodChange(event.target.checked ? monthInputToPeriod(periodToMonthInput(assignedPeriod)) || "" : null)
            }
          />
          {t("transactions.form.workIncomeToggle")}
        </label>
        {checked && (
          <div className="mt-2">
            <Label htmlFor={`${idPrefix}-assigned-period`}>{t("transactions.form.assignedPeriodLabel")}</Label>
            <Input
              id={`${idPrefix}-assigned-period`}
              type="month"
              required
              value={periodToMonthInput(assignedPeriod)}
              onChange={(event) => onAssignedPeriodChange(monthInputToPeriod(event.target.value))}
            />
            <p className="mt-1 text-xs text-text-muted">{t("transactions.form.workIncomeHint")}</p>
          </div>
        )}
      </div>
    );
  }

  if (type !== "expense") return null;

  return (
    <div className="rounded-lg border border-border bg-surface-1 p-2">
      <Label htmlFor={`${idPrefix}-mandatory-kind`}>{t("transactions.form.mandatoryPaymentLabel")}</Label>
      <Select
        id={`${idPrefix}-mandatory-kind`}
        value={mandatoryPaymentKind ?? ""}
        onChange={(event) => {
          const value = (event.target.value || null) as MandatoryPaymentKind | null;
          onMandatoryPaymentKindChange(value);
          onAssignedPeriodChange(value ? monthInputToPeriod(periodToMonthInput(assignedPeriod)) || null : null);
        }}
      >
        <option value="">{t("transactions.form.mandatoryPaymentNone")}</option>
        <option value="zus">{t("transactions.form.mandatoryPaymentZus")}</option>
        <option value="ppe">{t("transactions.form.mandatoryPaymentPpe")}</option>
        <option value="vat">{t("transactions.form.mandatoryPaymentVat")}</option>
      </Select>
      {mandatoryPaymentKind && (
        <div className="mt-2">
          <Label htmlFor={`${idPrefix}-assigned-period`}>{t("transactions.form.assignedPeriodLabel")}</Label>
          <Input
            id={`${idPrefix}-assigned-period`}
            type="month"
            required
            value={periodToMonthInput(assignedPeriod)}
            onChange={(event) => onAssignedPeriodChange(monthInputToPeriod(event.target.value))}
          />
          <p className="mt-1 text-xs text-text-muted">{t("transactions.form.mandatoryPaymentHint")}</p>
        </div>
      )}
    </div>
  );
}
