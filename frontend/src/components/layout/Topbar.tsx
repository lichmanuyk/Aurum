import { useLocation } from "react-router-dom";
import { ArrowLeftRight, Menu } from "lucide-react";
import { NAV_ITEMS } from "@/lib/navigation";
import { useDisplayCurrencyAction } from "@/lib/displayCurrency";
import { useTranslation } from "@/lib/i18n";

interface TopbarProps {
  onOpenMobileNav: () => void;
}

export function Topbar({ onOpenMobileNav }: TopbarProps) {
  const location = useLocation();
  const { t } = useTranslation();
  const activeItem = NAV_ITEMS.find((item) => (item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to)));
  const currencyAction = useDisplayCurrencyAction();

  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-border bg-surface-0/95 px-4 py-3.5 backdrop-blur sm:px-6 lg:px-8">
      <button
        type="button"
        onClick={onOpenMobileNav}
        aria-label={t("topbar.openMenu")}
        className="rounded-md p-1.5 text-text-secondary hover:bg-surface-2 lg:hidden"
      >
        <Menu size={20} />
      </button>
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-text-primary">{activeItem ? t(activeItem.labelKey) : "Aurum"}</h1>
      {currencyAction && (
        <button
          type="button"
          onClick={currencyAction.toggle}
          title={t("summaryCurrency.viewInAction", {
            currency: currencyAction.isTemporaryPrimaryView ? currencyAction.configuredCurrency : currencyAction.primaryCurrency,
          })}
          aria-label={t("summaryCurrency.viewInAction", {
            currency: currencyAction.isTemporaryPrimaryView ? currencyAction.configuredCurrency : currencyAction.primaryCurrency,
          })}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-2 sm:text-sm"
        >
          <ArrowLeftRight size={14} />
          {currencyAction.isTemporaryPrimaryView ? currencyAction.configuredCurrency : currencyAction.primaryCurrency}
        </button>
      )}
    </header>
  );
}
