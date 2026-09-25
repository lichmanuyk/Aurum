import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatMoney } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";

interface FxOverviewItem {
  currency: string;
  /** null = no reliable official rate — never a guessed 0 or 1:1. */
  rate: string | null;
  rate_date: string | null;
  source: string | null;
}

interface FxOverviewResponse {
  reporting_currency: string;
  as_of: string;
  items: FxOverviewItem[];
}

/** Compact "what's 1 USD/EUR/BYN/RUB worth right now" card — always these
 * four (see docs/tasks/fx-rate-overview.md), relative to the primary
 * ledger currency regardless of which display currency the rest of the
 * Dashboard happens to be showing. GET /fx-rates/overview only reads
 * already-saved reference rates; opening this card never calls NBP. */
export function FxRateOverviewCard() {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: ["fx-rate-overview"],
    queryFn: () => api.get<FxOverviewResponse>("/fx-rates/overview"),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (query.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("fxOverview.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p role="alert" className="text-sm text-danger">{t("fxOverview.loadError")}</p>
          <Button variant="secondary" disabled={query.isFetching} onClick={() => void query.refetch()}>
            {query.isFetching ? t("quotes.updating") : t("quotes.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const data = query.data;
  if (!data || data.items.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("fxOverview.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {data.items.map((item) => (
            <div key={item.currency} className="rounded-lg border border-border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">1 {item.currency}</p>
              {item.rate !== null ? (
                <>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-text-primary">
                    {formatMoney(item.rate, data.reporting_currency)}
                  </p>
                  <p className="mt-1 text-xs text-text-muted">
                    {item.source} · {t("netWorth.assetsTable.asOf", { date: item.rate_date ?? "" })}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm font-medium text-text-muted">{t("fxOverview.noRate")}</p>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
