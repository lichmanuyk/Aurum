import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Label, Select } from "@/components/ui/Input";
import { useTranslation } from "@/lib/i18n";
import { useAppSettings, useUpdateAppSettings } from "@/hooks/useSettings";
import type { AppSettings, DisplayCurrency } from "@/types";

const CHOICES: DisplayCurrency[] = ["PLN", "USD", "EUR"];

export function DisplayCurrencyCard() {
  const { t } = useTranslation();
  const { data: settings, isLoading } = useAppSettings();
  const updateSettings = useUpdateAppSettings();
  const primary = settings?.currency;
  const disabled = isLoading || updateSettings.isPending;

  // The general control always shows a real choice (no "inherit" option of
  // its own) — before the user picks anything, it reads whichever of
  // PLN/USD/EUR currently matches the primary currency, falling back to PLN
  // (see lib/displayCurrency.tsx's resolveConfiguredCurrency).
  const generalValue = settings?.summary_currency
    ?? (primary && CHOICES.includes(primary as DisplayCurrency) ? (primary as DisplayCurrency) : "PLN");

  function overrideField(field: "dashboard_currency" | "net_worth_currency" | "crypto_currency", label: string, id: string) {
    const value = settings?.[field] ?? "";
    return (
      <div>
        <Label htmlFor={id}>{label}</Label>
        <Select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => updateSettings.mutate({ [field]: event.target.value || null } as Partial<AppSettings>)}
        >
          <option value="">{t("settings.displayCurrencyInherit")}</option>
          {CHOICES.map((code) => <option key={code} value={code}>{code}</option>)}
        </Select>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.displayCurrency")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Label htmlFor="summary-currency">{t("settings.displayCurrencyGeneralLabel")}</Label>
            <Select
              id="summary-currency"
              value={generalValue}
              disabled={disabled}
              onChange={(event) => updateSettings.mutate({ summary_currency: event.target.value as DisplayCurrency })}
            >
              {CHOICES.map((code) => <option key={code} value={code}>{code}</option>)}
            </Select>
          </div>
          {overrideField("dashboard_currency", t("settings.dashboardCurrencyLabel"), "dashboard-currency")}
          {overrideField("net_worth_currency", t("settings.netWorthCurrencyLabel"), "net-worth-currency")}
          {overrideField("crypto_currency", t("settings.cryptoCurrencyLabel"), "crypto-currency")}
        </div>
        <p className="text-xs text-text-muted">{t("settings.displayCurrencyHint")}</p>
      </CardContent>
    </Card>
  );
}
