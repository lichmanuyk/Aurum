import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useAppSettings, useUpdateAppSettings } from "@/hooks/useSettings";
import { formatCurrency, formatCryptoAmount, formatSignedCurrency } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import type { AppSettings, DisplayCurrency } from "@/types";

type Section = "dashboard" | "netWorth" | "crypto";

// The old, browser-only selector this feature replaces (see lib/summaryCurrency.tsx,
// removed) stored its choice under this key. LEGACY_MIGRATED_KEY guarantees the
// one-time migration below runs at most once per browser, even across reloads.
const LEGACY_STORAGE_KEY = "aurum:summary-currency";
const LEGACY_MIGRATED_KEY = "aurum:summary-currency-migrated";
const DISPLAY_CURRENCIES: readonly DisplayCurrency[] = ["PLN", "USD", "EUR"];

const SECTIONS: { section: Section; test: (path: string) => boolean; overrideField: keyof AppSettings }[] = [
  { section: "dashboard", test: (p) => p === "/", overrideField: "dashboard_currency" },
  { section: "netWorth", test: (p) => p.startsWith("/net-worth"), overrideField: "net_worth_currency" },
  { section: "crypto", test: (p) => p.startsWith("/crypto"), overrideField: "crypto_currency" },
];

function sectionForPath(pathname: string) {
  return SECTIONS.find((entry) => entry.test(pathname)) ?? null;
}

interface DisplayCurrencyContextValue {
  section: Section | null;
  /** override ?? summary_currency ?? primary — the currency the user actually configured for this page. */
  configuredCurrency: string;
  /** The ledger's primary/reporting currency — never changed by this feature. */
  primaryCurrency: string;
  /** configuredCurrency, unless the compact header action has temporarily swapped it for primaryCurrency. */
  effectiveCurrency: string;
  isTemporaryPrimaryView: boolean;
  toggleTemporaryPrimaryView: () => void;
}

const DisplayCurrencyContext = createContext<DisplayCurrencyContextValue | null>(null);

/** Resolves override -> summary_currency -> primary, the shared inheritance
 * rule for all three summary pages (see docs/tasks/display-currency-preferences.md). */
export function resolveConfiguredCurrency(
  settings: AppSettings | undefined, primary: string, section: Section
): string {
  if (!settings) return primary;
  const override = settings[sectionOverrideField(section)] as DisplayCurrency | null;
  return override ?? settings.summary_currency ?? primary;
}

function sectionOverrideField(section: Section): keyof AppSettings {
  return SECTIONS.find((entry) => entry.section === section)!.overrideField;
}

/** Wraps the whole layout (Topbar + routed page) once, in App.tsx — both the
 * page's data hooks and Topbar's compact currency action read the same
 * resolved value through context, keyed off the current route. */
export function DisplayCurrencyProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const { currency: primary } = useTranslation();
  const { data: settings } = useAppSettings();
  const updateSettings = useUpdateAppSettings();
  const entry = sectionForPath(pathname);
  const section = entry?.section ?? null;

  const configuredCurrency = section ? resolveConfiguredCurrency(settings, primary, section) : primary;

  // One-time migration of the old browser-only choice: only when the server
  // has genuinely never been set (summary_currency is null) — once a real
  // choice exists there (from this browser or a different one), the server
  // wins and the legacy value is never consulted again. LEGACY_MIGRATED_KEY
  // is only written once the PATCH actually succeeds (or there's nothing to
  // migrate) — writing it eagerly would silently drop the user's choice
  // forever the moment the very first attempt hit a network error.
  const migrationInFlight = useRef(false);
  useEffect(() => {
    if (migrationInFlight.current || !settings || localStorage.getItem(LEGACY_MIGRATED_KEY)) return;
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (settings.summary_currency !== null || !legacy || !DISPLAY_CURRENCIES.includes(legacy as DisplayCurrency)) {
      // Nothing to migrate — safe to mark done regardless of network state.
      localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
      return;
    }
    migrationInFlight.current = true;
    (async () => {
      const attempts = 3;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          await updateSettings.mutateAsync({ summary_currency: legacy as DisplayCurrency });
          localStorage.setItem(LEGACY_MIGRATED_KEY, "1");
          return;
        } catch {
          if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
      // Every retry failed — LEGACY_MIGRATED_KEY stays unset, so the next
      // full page load (this effect's next mount) tries again from scratch.
    })().finally(() => { migrationInFlight.current = false; });
  }, [settings, updateSettings]);

  const [isTemporaryPrimaryView, setTemporary] = useState(false);
  // Leaving the page (or the settings changing under it) always lands back
  // on the configured currency — a temporary view never survives navigation.
  useEffect(() => setTemporary(false), [section, configuredCurrency]);

  const value = useMemo<DisplayCurrencyContextValue>(() => ({
    section,
    configuredCurrency,
    primaryCurrency: primary,
    effectiveCurrency: isTemporaryPrimaryView ? primary : configuredCurrency,
    isTemporaryPrimaryView,
    toggleTemporaryPrimaryView: () => setTemporary((prev) => !prev),
  }), [section, configuredCurrency, primary, isTemporaryPrimaryView]);

  return <DisplayCurrencyContext.Provider value={value}>{children}</DisplayCurrencyContext.Provider>;
}

function useDisplayCurrencyContext(): DisplayCurrencyContextValue {
  const ctx = useContext(DisplayCurrencyContext);
  const { currency: primary } = useTranslation();
  // Falls back to the primary currency outside DisplayCurrencyProvider —
  // same "just show the primary currency" default a component gets in
  // isolation (e.g. a unit test mounting it directly), rather than forcing
  // every such test to wrap itself in the provider.
  return ctx ?? {
    section: null, configuredCurrency: primary, primaryCurrency: primary, effectiveCurrency: primary,
    isTemporaryPrimaryView: false, toggleTemporaryPrimaryView: () => {},
  };
}

/** For Dashboard/NetWorth/Crypto's data hooks and formatting — the currency
 * to query and render with right now (accounts for the temporary view). */
export function useSectionCurrency(): string {
  return useDisplayCurrencyContext().effectiveCurrency;
}

export function useSectionFormat() {
  const currency = useSectionCurrency();
  return {
    formatCurrency: (amount: number | string, c = currency) => formatCurrency(amount, c),
    formatSignedCurrency: (amount: number | string, c = currency) => formatSignedCurrency(amount, c),
    formatCryptoAmount: (amount: number | string, c = currency) => formatCryptoAmount(amount, c),
  };
}

/** For Topbar's compact header action — null on every page other than the
 * three summary pages, and also null when there's nothing to temporarily
 * view (the configured currency already matches the primary one). */
export function useDisplayCurrencyAction(): {
  isTemporaryPrimaryView: boolean;
  toggle: () => void;
  primaryCurrency: string;
  configuredCurrency: string;
} | null {
  const ctx = useDisplayCurrencyContext();
  if (!ctx.section || ctx.configuredCurrency === ctx.primaryCurrency) return null;
  return {
    isTemporaryPrimaryView: ctx.isTemporaryPrimaryView,
    toggle: ctx.toggleTemporaryPrimaryView,
    primaryCurrency: ctx.primaryCurrency,
    configuredCurrency: ctx.configuredCurrency,
  };
}
