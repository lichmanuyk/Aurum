import type { SelectHTMLAttributes } from "react";
import { Select } from "@/components/ui/Input";
import { useAssets } from "@/hooks/useAssets";
import { useTranslation } from "@/lib/i18n";

interface ExpenseAssetSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> {
  value: string; // "" for no link, else the asset id as a string
  onChange: (value: string) => void;
}

/** Shared "Property (optional)" picker for an expense/split line/recurring
 * template's optional link to a manually-tracked asset — see
 * docs/tasks/property-expense-links.md. Crypto-class assets are excluded:
 * they're always a CryptoHolding's own shell, never a valid expense target
 * (the backend rejects them too — see routes/transactions.py's own
 * _ensure_expense_asset_valid), so offering one here would just be a dead
 * end after submit. */
export function ExpenseAssetSelect({ value, onChange, ...rest }: ExpenseAssetSelectProps) {
  const { t } = useTranslation();
  const { data: assets } = useAssets();
  const linkable = (assets ?? []).filter((asset) => asset.asset_class !== "crypto");

  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)} {...rest}>
      <option value="">{t("transactions.form.expenseAssetNone")}</option>
      {linkable.map((asset) => (
        <option key={asset.id} value={asset.id}>
          {asset.name}
        </option>
      ))}
    </Select>
  );
}
