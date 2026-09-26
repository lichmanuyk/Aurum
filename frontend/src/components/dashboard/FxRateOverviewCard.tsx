import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Sparkline } from "@/components/dashboard/Sparkline";
import { getIntlLocale } from "@/lib/format";
import { computeTrend } from "@/lib/fxTrend";
import { useTranslation } from "@/lib/i18n";
import { type FxPeriodPair, useFxRatePeriodOverview } from "@/hooks/useFxRatePeriodOverview";

interface FxRateOverviewCardProps {
  year: number | null;
  month: number | null;
}

const OVERVIEW_CURRENCIES = ["USD", "EUR", "BYN", "RUB"];
const NBP_EPOCH = "2002-01-02";

function moveDay(day: string, offset: number): string {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

/** Fills the gap the card just reported via sequential, ≤93-day
 * POST /fx-rates/nbp calls (the existing NBPImport limit) — same chunking
 * shape as components/settings/NbpImport.tsx. Covers `seriesStart` minus 7
 * days (for the first available publication before the window starts) up
 * to `seriesEnd`; never earlier than NBP's own history floor. Sequential,
 * not parallel, so a transient error only ever loses the one interval
 * still in flight. */
async function loadPeriodRates(seriesStart: string, seriesEnd: string): Promise<void> {
  const start = [NBP_EPOCH, moveDay(seriesStart, -7)].sort().at(-1)!;
  for (let end = seriesEnd; end >= start; ) {
    const from = [start, moveDay(end, -92)].sort().at(-1)!;
    await api.post("/fx-rates/nbp", { start_date: from, end_date: end, currencies: OVERVIEW_CURRENCIES });
    end = moveDay(from, -1);
  }
}

function formatRate(value: string): string {
  return Number(value).toLocaleString(getIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** Compact "1 USD/EUR = X PLN, 1 USD = X BYN/RUB" card — always these four
 * fixed pairs (see docs/tasks/dashboard-fx-periods-sparklines.md,
 * continuing PR #36), reacting to the same year/month period as the rest
 * of the Dashboard. GET /fx-rates/overview/period only reads already-saved
 * reference rates; opening/switching this card never calls NBP itself —
 * loading more history is the one explicit action below. */
export function FxRateOverviewCard({ year, month }: FxRateOverviewCardProps) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const query = useFxRatePeriodOverview(year, month);
  const data = query.data;

  const load = useMutation({
    mutationFn: () => loadPeriodRates(data!.series_start, data!.series_end),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["fx-rate-period-overview"] }),
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

  if (!data || data.items.length === 0) return null;

  const subtitle = (item: FxPeriodPair): string => {
    if (item.value === null) return "";
    if (data.label === "average") return t("fxOverview.periodAverage");
    if (data.label === "ytd") return t("fxOverview.ytdAverage");
    // latest — legs carry each currency's own actual publication date/
    // source; a cross pair (USD/BYN, USD/RUB) shows both independently,
    // since they can genuinely differ (see the schema's own docstring).
    return item.legs.map((leg) => `${leg.source.split(":")[0]} ${leg.rate_date}`).join(" · ");
  };

  const hasGap = data.items.some((item) => item.value === null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("fxOverview.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {data.items.map((item) => {
            const key = `${item.base_currency}-${item.quote_currency}`;
            const trend = computeTrend(item.series);
            return (
              <div key={key} className="flex items-center justify-between gap-2 rounded-lg border border-border p-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    1 {item.base_currency} = {item.quote_currency}
                  </p>
                  {item.value !== null ? (
                    <>
                      <p className="mt-1 text-lg font-semibold tabular-nums text-text-primary">
                        {formatRate(item.value)}
                      </p>
                      <p className="mt-1 truncate text-xs text-text-muted">{subtitle(item)}</p>
                    </>
                  ) : (
                    <p className="mt-1 text-sm font-medium text-text-muted">{t("fxOverview.insufficientHistory")}</p>
                  )}
                </div>
                <Sparkline series={item.series} trend={trend} />
              </div>
            );
          })}
        </div>
        {hasGap && (
          <div className="space-y-1">
            <Button variant="secondary" disabled={load.isPending} onClick={() => load.mutate()}>
              {load.isPending ? t("fxOverview.loadingPeriodRates") : t("fxOverview.loadPeriodRates")}
            </Button>
            {load.isError && <p role="alert" className="text-sm text-danger">{t("fxOverview.loadRatesError")}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
