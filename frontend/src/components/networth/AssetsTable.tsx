import { ArrowLeftRight, Pencil, Trash2 } from "lucide-react";
import { getCategoryIcon } from "@/lib/icons";
import { formatMoney, formatTransactionDate } from "@/lib/format";
import { useTranslation, type TranslationKey } from "@/lib/i18n";
import type { Asset, CapitalRole } from "@/types";

const CLASS_ICONS: Record<Asset["asset_class"], string> = {
  investments: "trending-up",
  crypto: "bitcoin",
  real_estate: "building-2",
  vehicles: "car",
  precious_metals: "gem",
  other: "package",
};

const ROLE_COLORS: Record<CapitalRole, string> = {
  income: "var(--success)",
  neutral: "var(--text-muted)",
  drain: "var(--danger)",
};

interface AssetsTableProps {
  items: Asset[];
  onEdit: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  onMovement: (asset: Asset) => void;
}

/** Native amounts in different currencies (EUR/USD/PLN…) can't be compared
 * as plain numbers — this orders by each asset's own `capital_value` (its
 * real contribution to the capital summary, see useAssets/list_assets)
 * instead. Rows with nothing to compare (no valuation yet, or a missing FX
 * rate) sort after every valued row rather than being lost or landing
 * arbitrarily among them — still shown, just with an explicit label instead
 * of a number (see the render below). Equal values, and the unvalued group
 * itself, get a stable order: name, then id. */
function compareByCapitalValue(a: Asset, b: Asset): number {
  const valueOf = (asset: Asset) => (asset.capital_value !== null ? Number(asset.capital_value) : null);
  const av = valueOf(a);
  const bv = valueOf(b);
  if (av !== null && bv !== null && av !== bv) return bv - av;
  if ((av !== null) !== (bv !== null)) return av !== null ? -1 : 1;
  return a.name.localeCompare(b.name) || a.id - b.id;
}

export function AssetsTable({ items, onEdit, onDelete, onMovement }: AssetsTableProps) {
  const { t, language } = useTranslation();

  if (items.length === 0) {
    return <p className="py-10 text-center text-sm text-text-muted">{t("netWorth.assetsTable.empty")}</p>;
  }

  const sorted = [...items].sort(compareByCapitalValue);

  return (
    <ul className="divide-y divide-gridline">
      {sorted.map((asset) => {
        const Icon = getCategoryIcon(CLASS_ICONS[asset.asset_class]);
        const roleColor = ROLE_COLORS[asset.capital_role];
        const cashFlow = asset.monthly_cash_flow !== null ? Number(asset.monthly_cash_flow) : null;
        const currentValue = Number(asset.current_value);
        // Annual ROI only makes sense for money coming in against what was
        // paid for the asset — same formula as RoiCalculatorCard.
        const annualRoiPercent = cashFlow !== null && cashFlow > 0 && currentValue > 0 ? (cashFlow * 12) / currentValue * 100 : null;

        return (
          <li key={asset.id} className="flex items-center gap-3 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-2">
              <Icon size={16} className="text-text-secondary" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text-primary">{asset.name}</span>
              <span className="flex items-center gap-1 truncate text-xs text-text-muted">
                {t(`netWorth.assetClass.${asset.asset_class}` as TranslationKey)} ·{" "}
                {t("netWorth.assetsTable.asOf", { date: formatTransactionDate(asset.as_of_date) })}
                <span className="inline-flex items-center gap-1" style={{ color: roleColor }}>
                  · <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: roleColor }} />
                  {t(`netWorth.capitalRole.${asset.capital_role}` as TranslationKey)}
                </span>
              </span>
            </span>
            <span className="shrink-0 text-right">
              <span className="block text-sm font-medium tabular-nums text-text-primary">
                {formatMoney(asset.current_value, asset.currency)}
              </span>
              {/* The sort order above (compareByCapitalValue) is by this
                  equivalent, not the native amount shown above it — surface
                  it too, so the order is explainable, not just trusted. An
                  explicit label instead when there's nothing to convert:
                  never a fabricated 0 or a silent 1:1. */}
              {asset.capital_value_error && (
                <span className="block text-xs text-text-muted">
                  {t(
                    asset.capital_value_error === "no_valuation"
                      ? "netWorth.assetsTable.noValuation"
                      : "netWorth.assetsTable.fxRateMissing"
                  )}
                </span>
              )}
              {asset.capital_value !== null && asset.currency !== asset.capital_currency && (
                <span className="block text-xs text-text-muted">
                  {t("netWorth.assetsTable.capitalEquivalent", { amount: formatMoney(asset.capital_value, asset.capital_currency) })}
                </span>
              )}
              {cashFlow !== null && cashFlow !== 0 && (
                <span
                  className="block text-xs tabular-nums"
                  style={{ color: cashFlow > 0 ? "var(--success)" : "var(--danger)" }}
                >
                  {cashFlow > 0 ? "+" : ""}
                  {formatMoney(cashFlow, asset.currency)}
                  {t("common.perMonth")}
                  {annualRoiPercent !== null && ` · ${t("netWorth.assetsTable.annualRoi", { percent: annualRoiPercent.toFixed(1) })}`}
                </span>
              )}
            </span>
            <span className="flex shrink-0 gap-1">
              <button type="button" aria-label={`${asset.name}: ${language === "ru" ? "Покупка и продажа" : "Buy and sell"}`} title={language === "ru" ? "Покупка и продажа" : "Buy and sell"} onClick={() => onMovement(asset)} className="rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"><ArrowLeftRight size={15} /></button>
              <button
                type="button"
                aria-label={t("common.edit")}
                onClick={() => onEdit(asset)}
                className="rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                aria-label={t("common.delete")}
                onClick={() => onDelete(asset)}
                className="rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-danger"
              >
                <Trash2 size={15} />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
