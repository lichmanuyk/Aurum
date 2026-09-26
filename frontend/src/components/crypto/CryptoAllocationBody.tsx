import { useSectionFormat } from "@/lib/displayCurrency";
import { useRef, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { useChartSelection } from "@/lib/chartSelection";
import { sectorMidAngleDeg, useSectorConnectorLine } from "@/lib/sectorConnector";
import { maskAmount } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { CryptoHolding } from "@/types";

interface CryptoAllocationBodyProps {
  holdings: CryptoHolding[];
  isLoading: boolean;
  hidden: boolean;
}

// Fixed categorical order, same 8-slot ramp the rest of the app already
// validated (see net_worth_service.py's _CLASS_META comment) — a coin never
// gets a freshly generated hue. Only the first 7 get their own color; an 8th+
// coin folds into "Other" (--series-other) rather than cycling back through
// the ramp, per the dataviz skill's categorical-color rule.
const SERIES_COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
  "var(--series-6)",
  "var(--series-7)",
];
const OTHER_COLOR = "var(--series-other)";
const MAX_SLICES = SERIES_COLORS.length;

export interface Slice {
  key: string;
  name: string;
  symbol: string | null;
  amount: number;
  color: string;
}

// Exported for direct unit testing (see CryptoAllocationBody.test.ts) —
// the donut/table JSX below isn't worth rendering just to check the math.
export function buildSlices(holdings: CryptoHolding[]): Slice[] {
  const priced = holdings
    .filter((h) => h.value !== null && Number(h.value) > 0)
    .map((h) => ({ key: String(h.asset_id), name: h.name, symbol: h.symbol, amount: Number(h.value) }))
    .sort((a, b) => b.amount - a.amount);

  const top = priced.slice(0, MAX_SLICES).map((item, index) => ({ ...item, color: SERIES_COLORS[index] }));
  const rest = priced.slice(MAX_SLICES);
  if (rest.length === 0) return top;

  const otherTotal = rest.reduce((sum, item) => sum + item.amount, 0);
  return [...top, { key: "other", name: "Other", symbol: null, amount: otherTotal, color: OTHER_COLOR }];
}

function DonutTooltip({
  active,
  payload,
  hidden,
  otherLabel,
}: {
  active?: boolean;
  payload?: Array<{ payload: Slice & { percent: number } }>;
  hidden: boolean;
  otherLabel: string;
}) {
  const { formatCryptoAmount } = useSectionFormat();
  if (!active || !payload?.length) return null;
  const slice = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm shadow-md">
      <p className="font-medium text-text-primary">{slice.key === "other" ? otherLabel : slice.name}</p>
      <p className="text-text-muted">
        {maskAmount(formatCryptoAmount(slice.amount), hidden)} · {slice.percent.toFixed(1)}%
      </p>
    </div>
  );
}

/** The "Allocation" tab's content inside CryptoOverviewCard — a donut
 * (part-to-whole across few categories is exactly the case a donut is fine
 * for) plus a compact table: a color swatch identifying the ticker, its
 * share, and the amount. A real <table>, not a flex row list — table
 * columns size to their own content and align natively, so this can't
 * stretch across whatever space is left next to the donut the way a
 * flex-1 row did. */
export function CryptoAllocationBody({ holdings, isLoading, hidden }: CryptoAllocationBodyProps) {
  const { formatCryptoAmount } = useSectionFormat();
  const { t } = useTranslation();
  const otherLabel = t("crypto.allocation.other");

  // Plain computation, not hooks — safe to run before the hook calls below
  // regardless of isLoading/empty, since buildSlices([]) is a safe empty
  // array either way.
  const slices = buildSlices(holdings);
  const total = slices.reduce((sum, slice) => sum + slice.amount, 0);
  const donutData = slices.map((slice) => ({ ...slice, percent: total ? (slice.amount / total) * 100 : 0 }));
  const validIds = new Set(donutData.map((slice) => slice.key));

  // All hooks run unconditionally, before the isLoading/empty early
  // returns below.
  const selection = useChartSelection<string>(validIds);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const [activeRowEl, setActiveRowEl] = useState<HTMLTableRowElement | null>(null);

  const { activeId, pinnedId } = selection;
  const activeIndex = activeId !== null ? donutData.findIndex((slice) => slice.key === activeId) : -1;
  // Also the `paddingAngle` passed to <Pie> below — kept as one value so the
  // connector line's own angle math can never drift out of sync with what
  // Recharts actually rendered.
  const paddingAngle = donutData.length > 1 ? 2 : 0;
  const midAngleDeg = activeIndex >= 0 ? sectorMidAngleDeg(donutData.map((slice) => slice.amount), activeIndex, paddingAngle) : null;
  const connectorLine = useSectorConnectorLine(containerRef, chartAreaRef, activeRowEl, midAngleDeg);

  if (isLoading) {
    return <p className="py-10 text-center text-sm text-text-muted">{t("common.loading")}</p>;
  }
  if (slices.length === 0) {
    return <p className="py-10 text-center text-sm text-text-muted">{t("crypto.empty")}</p>;
  }

  return (
    <div ref={containerRef} className="relative flex flex-col items-center justify-center gap-6 sm:flex-row">
      {connectorLine && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          <line
            x1={connectorLine.x1} y1={connectorLine.y1} x2={connectorLine.x2} y2={connectorLine.y2}
            stroke="var(--text-muted)" strokeWidth={1}
          />
        </svg>
      )}
      <div ref={chartAreaRef} className="h-48 w-48 shrink-0 sm:h-56 sm:w-56">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={donutData}
              dataKey="amount"
              nameKey="name"
              innerRadius="68%"
              outerRadius="100%"
              paddingAngle={paddingAngle}
              stroke="var(--surface-1)"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {donutData.map((slice) => {
                const isActive = activeId === slice.key;
                const dimmed = activeId !== null && !isActive;
                const label = slice.key === "other" ? otherLabel : `${slice.name} (${slice.symbol})`;
                return (
                  <Cell
                    key={slice.key}
                    fill={slice.color}
                    fillOpacity={dimmed ? 0.35 : 1}
                    stroke={isActive ? "var(--text-primary)" : "var(--surface-1)"}
                    strokeWidth={isActive ? 3 : 2}
                    tabIndex={0}
                    role="button"
                    aria-label={`${label}, ${maskAmount(formatCryptoAmount(slice.amount), hidden)}, ${slice.percent.toFixed(0)}%`}
                    aria-pressed={pinnedId === slice.key}
                    onMouseEnter={() => selection.enter(slice.key)}
                    onMouseLeave={selection.leave}
                    onFocus={() => selection.enter(slice.key)}
                    onBlur={selection.leave}
                    onClick={() => selection.togglePin(slice.key)}
                    onKeyDown={(event) => selection.onKeyDown(event, slice.key)}
                  />
                );
              })}
            </Pie>
            <Tooltip content={<DonutTooltip hidden={hidden} otherLabel={otherLabel} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <table className="text-sm">
        <tbody>
          {donutData.map((slice) => {
            const isActive = activeId === slice.key;
            const dimmed = activeId !== null && !isActive;
            const label = slice.key === "other" ? t("crypto.allocation.other") : `${slice.name} (${slice.symbol})`;
            return (
              // The row itself stays a plain <tr> (native "row" role) —
              // aria-pressed only makes sense on an actual toggle button, not
              // on a table row, so the real control (and its own accessible
              // name/aria-pressed/keyboard handling) lives on the <button>
              // inside the first cell below. Mouse hover still previews from
              // anywhere in the row for a comfortably large hit area; that's
              // presentational, not an accessibility concern.
              <tr
                key={slice.key}
                title={slice.key === "other" ? undefined : slice.name}
                ref={isActive ? setActiveRowEl : undefined}
                onMouseEnter={() => selection.enter(slice.key)}
                onMouseLeave={selection.leave}
                className={cn("transition-opacity", dimmed && "opacity-40", isActive && "bg-surface-2")}
              >
                <td className="py-1.5 pr-3">
                  <button
                    type="button"
                    aria-pressed={pinnedId === slice.key}
                    aria-label={`${label}, ${maskAmount(formatCryptoAmount(slice.amount), hidden)}, ${slice.percent.toFixed(0)}%`}
                    onFocus={() => selection.enter(slice.key)}
                    onBlur={selection.leave}
                    onClick={() => selection.togglePin(slice.key)}
                    onKeyDown={(event) => selection.onKeyDown(event, slice.key)}
                    className="-m-1 flex items-center gap-2 rounded-md p-1"
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
                    <span className="font-medium text-text-primary">
                      {slice.key === "other" ? t("crypto.allocation.other") : slice.symbol}
                    </span>
                  </button>
                </td>
                <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-text-primary">
                  {slice.percent.toFixed(1)}%
                </td>
                <td className="py-1.5 text-right tabular-nums text-text-muted">{maskAmount(formatCryptoAmount(slice.amount), hidden)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
