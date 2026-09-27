import { useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { useSectionFormat } from "@/lib/displayCurrency";
import { getIntlLocale } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CashFlowResponse } from "@/types";

interface CashFlowChartProps {
  cashFlow: CashFlowResponse | undefined;
  isLoading: boolean;
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function formatMonthLabel(key: string): string {
  return new Intl.DateTimeFormat(getIntlLocale(), { month: "short", year: "numeric" }).format(
    new Date(`${key}T00:00:00`)
  );
}

/** Same landmark idea as the Net Worth and category-spending charts: year
 * ticks only when the bars span more than one calendar year. */
function computeYearTicks(keys: string[]): string[] {
  if (keys.length < 2) return [];
  const startYear = Number(keys[0].slice(0, 4));
  const endYear = Number(keys[keys.length - 1].slice(0, 4));
  if (startYear === endYear) return [];
  const ticks: string[] = [];
  for (let year = startYear + 1; year <= endYear; year++) {
    const jan = `${year}-01-01`;
    if (keys.includes(jan)) ticks.push(jan);
  }
  return ticks;
}

interface ChartPoint {
  key: string;
  income: number;
  // The month's ORDINARY (non-tax) cash outflow only — the API's `expense`
  // field is inclusive of `tax_expense` (mandatory ZUS/PPE/VAT payments;
  // see CashFlowPoint's own docstring in types/index.ts for that contract),
  // but the UI now shows the two as separate rows/bars/toggles rather than
  // one lumped total, so this is `expense - tax_expense`. See splitExpense
  // below for the shared arithmetic and its own unit test.
  expenseOrdinary: number;
  // This month's mandatory ZUS/PPE/VAT payments — a real cash outflow in
  // its own right (already excluded from `expenseOrdinary` above), shown as
  // its own row/bar/toggle, never subtracted a second time.
  tax_expense: number;
  net: number;
}

/** Pure split of the API's tax-inclusive `expense` into the ordinary
 * (non-tax) portion the UI now renders separately from `tax_expense` —
 * factored out so CashFlowChart.split.test.ts can exercise the arithmetic
 * without mounting the component. Never touches `net`, which always comes
 * straight from the server and is never recomputed client-side. */
export function splitExpense(expense: number | string, taxExpense: number | string): {
  ordinary: number;
  tax: number;
} {
  const tax = Number(taxExpense);
  return { ordinary: Number(expense) - tax, tax };
}

function ChartTooltip({
  active,
  payload,
  incomeLabel,
  expenseLabel,
  taxLabel,
  netLabel,
  formatCurrency,
  formatSignedCurrency,
  showIncome,
  showExpense,
  showTax,
  hasTax,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartPoint }>;
  incomeLabel: string;
  expenseLabel: string;
  taxLabel: string;
  netLabel: string;
  formatCurrency: (amount: number | string) => string;
  formatSignedCurrency: (amount: number | string) => string;
  showIncome: boolean;
  showExpense: boolean;
  showTax: boolean;
  hasTax: boolean;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm shadow-md">
      <p className="text-text-muted">{formatMonthLabel(point.key)}</p>
      {showIncome && (
        <p className="text-success">
          {incomeLabel}: {formatCurrency(point.income)}
        </p>
      )}
      {showExpense && (
        <p className="text-danger">
          {expenseLabel}: {formatCurrency(point.expenseOrdinary)}
        </p>
      )}
      {hasTax && showTax && point.tax_expense > 0 && (
        <p style={{ color: "var(--series-4)" }}>
          {taxLabel}: {formatCurrency(point.tax_expense)}
        </p>
      )}
      <p className="font-medium text-text-primary">
        {netLabel}: {formatSignedCurrency(point.net)}
      </p>
    </div>
  );
}

/** Independently toggles one bar series on/off — a real <button> so it's
 * reachable and operable by keyboard/screen reader/touch out of the box,
 * not recharts' own built-in Legend click handling (which toggles via
 * opaque internal state we can't drive or query from the empty-state check
 * below). `aria-pressed` reflects visibility, not selection. */
function SeriesToggle({ label, color, visible, onToggle }: {
  label: string; color: string; visible: boolean; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={visible}
      onClick={onToggle}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        visible ? "border-transparent text-text-primary" : "border-border text-text-muted"
      )}
      style={visible ? { backgroundColor: `${color}26` } : undefined}
    >
      <span className={cn("h-2 w-2 rounded-full", !visible && "opacity-40")} style={{ backgroundColor: color }} />
      {label}
    </button>
  );
}

export function CashFlowChart({ cashFlow, isLoading }: CashFlowChartProps) {
  const { t } = useTranslation();
  const { formatCurrency, formatSignedCurrency } = useSectionFormat();
  const incomeLabel = t("cashFlow.income");
  const expenseLabel = t("cashFlow.expense");
  const taxLabel = t("cashFlow.taxes");
  const netLabel = t("cashFlow.net");
  // Visual-only — hides/shows bars, never affects what's fetched, summed or
  // shown as the total above (see cashFlow.totalHint below). Independent of
  // each other: hiding taxes doesn't touch the ordinary expense row/bar or
  // vice versa, and none of the three change `total_net`, which always
  // comes straight from the server (income − every real cash outflow,
  // taxes included) rather than being recomputed from visible rows.
  const [showIncome, setShowIncome] = useState(true);
  const [showExpense, setShowExpense] = useState(true);
  const [showTax, setShowTax] = useState(true);

  // Period-level, not per-month: a period with no tax payments at all gets
  // no taxes row/bar/toggle rather than an always-zero one.
  const hasTax = Number(cashFlow?.total_tax_expense ?? 0) > 0;

  const chartData: ChartPoint[] =
    cashFlow?.points.map((point) => {
      const { ordinary, tax } = splitExpense(point.expense, point.tax_expense);
      return {
        key: monthKey(point.year, point.month),
        income: Number(point.income),
        expenseOrdinary: ordinary,
        tax_expense: tax,
        net: Number(point.net),
      };
    }) ?? [];
  const yearTicks = computeYearTicks(chartData.map((point) => point.key));
  // Same empty state either way, just worded for however many rows this
  // period actually has: income+expense only when there's no tax row at
  // all (`!hasTax` short-circuits `!showTax` below so its toggle state,
  // never rendered, can't gate anything), or all three once it does.
  const allRowsHidden = !showIncome && !showExpense && (!hasTax || !showTax);

  return (
    <Card>
      <CardHeader className="flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>{t("nav.cashFlow")}</CardTitle>
          <p className="mt-1.5 text-2xl font-semibold tabular-nums text-text-primary sm:text-[28px]">
            {isLoading || !cashFlow ? "…" : formatSignedCurrency(cashFlow.total_net)}
          </p>
          {cashFlow && (
            <>
              <p className="mt-1 text-sm">
                <span className="font-medium text-success">
                  {incomeLabel} {formatCurrency(cashFlow.total_income)}
                </span>
                <span className="text-text-muted"> · </span>
                {/* ORDINARY (non-tax) expense only — `total_expense` from the
                    API is inclusive of `total_tax_expense`, but this header
                    now breaks the two out into their own lines rather than
                    lumping tax payments silently into "Expense", so this is
                    `total_expense - total_tax_expense`. Taxes below are a
                    separate real outflow, not "included in" this figure. */}
                <span className="font-medium text-danger">
                  {expenseLabel} {formatCurrency(splitExpense(cashFlow.total_expense, cashFlow.total_tax_expense).ordinary)}
                </span>
                {hasTax && (
                  <>
                    <span className="text-text-muted"> · </span>
                    <span className="font-medium" style={{ color: "var(--series-4)" }}>
                      {taxLabel} {formatCurrency(cashFlow.total_tax_expense)}
                    </span>
                  </>
                )}
              </p>
              <p className="mt-0.5 text-xs text-text-muted">{t("cashFlow.totalHint")}</p>
            </>
          )}
        </div>
        <div className="flex gap-2">
          <SeriesToggle label={incomeLabel} color="var(--success)" visible={showIncome} onToggle={() => setShowIncome((v) => !v)} />
          <SeriesToggle label={expenseLabel} color="var(--danger)" visible={showExpense} onToggle={() => setShowExpense((v) => !v)} />
          {hasTax && (
            <SeriesToggle label={taxLabel} color="var(--series-4)" visible={showTax} onToggle={() => setShowTax((v) => !v)} />
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-56 w-full sm:h-64">
          {isLoading || !cashFlow || chartData.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-muted">
              {isLoading ? t("common.loading") : t("cashFlow.noData")}
            </div>
          ) : allRowsHidden ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-muted">
              {t(hasTax ? "cashFlow.allRowsHidden" : "cashFlow.bothRowsHidden")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                {yearTicks.length > 0 && (
                  <XAxis
                    dataKey="key"
                    type="category"
                    ticks={yearTicks}
                    tickFormatter={(value: string) => value.slice(0, 4)}
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "var(--text-muted)", fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                )}
                <Tooltip
                  content={<ChartTooltip
                    incomeLabel={incomeLabel} expenseLabel={expenseLabel} taxLabel={taxLabel} netLabel={netLabel}
                    formatCurrency={formatCurrency} formatSignedCurrency={formatSignedCurrency}
                    showIncome={showIncome} showExpense={showExpense} showTax={showTax} hasTax={hasTax}
                  />}
                  cursor={{ fill: "var(--surface-2)" }}
                />
                {showIncome && <Bar dataKey="income" fill="var(--success)" radius={[2, 2, 0, 0]} isAnimationActive={false} />}
                {showExpense && <Bar dataKey="expenseOrdinary" fill="var(--danger)" radius={[2, 2, 0, 0]} isAnimationActive={false} />}
                {hasTax && showTax && <Bar dataKey="tax_expense" fill="var(--series-4)" radius={[2, 2, 0, 0]} isAnimationActive={false} />}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        {chartData.length > 1 && (
          <div className="mt-2 flex justify-between text-xs text-text-muted">
            <span>{formatMonthLabel(chartData[0].key)}</span>
            <span>{formatMonthLabel(chartData[chartData.length - 1].key)}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
