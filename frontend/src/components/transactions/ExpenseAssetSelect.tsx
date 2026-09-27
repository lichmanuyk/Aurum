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
 * end after submit.
 *
 * "No link" is always present and always enabled — an existing link must
 * stay clearable even while the asset list is still loading or failed to
 * load at all, never blocked by that unrelated failure. */
export function ExpenseAssetSelect({ value, onChange, ...rest }: ExpenseAssetSelectProps) {
  const { t } = useTranslation();
  const { data: assets, isLoading, isError, refetch } = useAssets();
  const linkable = (assets ?? []).filter((asset) => asset.asset_class !== "crypto");
  // An already-linked value (from an existing transaction/split/template)
  // must never silently render as "No link" just because the list hasn't
  // loaded yet (or failed to) — that would look like the link was lost,
  // and a careless re-save could then actually lose it. See if the value
  // is on this asset's own PATCH... no: a caller with a real id whose row
  // simply hasn't arrived yet gets the disabled placeholder below instead
  // of falling back to the first real option.
  const hasCurrentOption = value === "" || linkable.some((asset) => String(asset.id) === value);

  return (
    <div>
      <Select value={value} onChange={(event) => onChange(event.target.value)} {...rest}>
        <option value="">{t("transactions.form.expenseAssetNone")}</option>
        {!hasCurrentOption && (
          // Disabled — never a real, user-choosable option — but a
          // <select>'s displayed value is whichever <option> matches the
          // controlled `value` regardless of `disabled`, so this is what
          // keeps the existing link visibly "still linked" (not blank/
          // "No link") while the real list is loading or unavailable.
          <option value={value} disabled>
            {isLoading ? t("common.loading") : t("transactions.form.expenseAssetLoadError")}
          </option>
        )}
        {linkable.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.name}
          </option>
        ))}
      </Select>
      {isError && (
        <p role="alert" className="mt-1 text-xs text-danger">
          {t("transactions.form.expenseAssetLoadError")}{" "}
          <button type="button" className="underline" onClick={() => refetch()}>
            {t("netWorth.expenses.retry")}
          </button>
        </p>
      )}
    </div>
  );
}
