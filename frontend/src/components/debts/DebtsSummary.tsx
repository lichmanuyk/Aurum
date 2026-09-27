import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { formatMoney } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import type { Debt } from "@/types";

/** Per-currency outstanding totals for one direction — deliberately never
 * summed across currencies (that would silently invent an FX rate; see
 * docs/tasks/debt-tracking.md's "never inferred from FX" rule). Settled
 * debts contribute 0 (their own outstanding_amount), so summing every debt
 * regardless of the page's own active/settled filter is always correct —
 * this always reflects every debt that currently exists, not just the
 * filtered view below it. */
function outstandingByCurrency(debts: Debt[]): [string, number][] {
  const totals = new Map<string, number>();
  for (const debt of debts) {
    const amount = Number(debt.outstanding_amount);
    if (!amount) continue;
    totals.set(debt.currency, (totals.get(debt.currency) ?? 0) + amount);
  }
  return [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

interface DebtsSummaryProps {
  debts: Debt[];
  isLoading: boolean;
}

export function DebtsSummary({ debts, isLoading }: DebtsSummaryProps) {
  const { t } = useTranslation();
  const receivables = outstandingByCurrency(debts.filter((debt) => debt.direction === "owed_to_me"));
  const liabilities = outstandingByCurrency(debts.filter((debt) => debt.direction === "owed_by_me"));

  function renderTotals(totals: [string, number][]) {
    if (isLoading) return <p className="text-sm text-text-muted">{t("common.loading")}</p>;
    if (totals.length === 0) return <p className="text-sm text-text-muted">{t("debts.summary.none")}</p>;
    return (
      <ul className="flex flex-wrap gap-3">
        {totals.map(([currency, amount]) => (
          <li key={currency} className="text-lg font-semibold tabular-nums text-text-primary">
            {formatMoney(amount, currency)}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("debts.summary.receivablesTitle")}</CardTitle>
        </CardHeader>
        <CardContent>{renderTotals(receivables)}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          {/* Styled as a liability, not a second asset total — red, same
              status color the Net Worth page's own liabilities callout
              uses (see AssetAllocationCard's totalLiabilities prop),
              never presented as if it were more money owned. */}
          <CardTitle className="text-danger">{t("debts.summary.liabilitiesTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="[&_li]:text-danger">{renderTotals(liabilities)}</CardContent>
      </Card>
    </div>
  );
}
