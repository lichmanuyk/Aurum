import { useState } from "react";
import { Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { DebtFormModal } from "@/components/debts/DebtFormModal";
import { DebtRepaymentsModal } from "@/components/debts/DebtRepaymentsModal";
import { DebtsSummary } from "@/components/debts/DebtsSummary";
import { DebtsTable } from "@/components/debts/DebtsTable";
import { useBusinessDate } from "@/hooks/useBusinessDate";
import { useDebts, useDeleteDebt } from "@/hooks/useDebts";
import { useTranslation } from "@/lib/i18n";
import type { Debt, DebtDirection, DebtStatus } from "@/types";

/** See docs/tasks/debt-tracking.md — who owes whom, in each debt's own
 * native currency. An "opening" debt (existing debt, no cash movement) or
 * a "new loan" (actual cash through a chosen account) is entered here;
 * partial/full repayment, reopening a settled debt via a reversal, and the
 * full repayment history all live in DebtRepaymentsModal below. Never
 * ordinary income/expense — see TransactionType.DEBT_IN/OUT's own
 * docstring and this page's own intro line. */
export function DebtsPage() {
  const { t } = useTranslation();
  const { businessDate } = useBusinessDate();
  const [direction, setDirection] = useState<DebtDirection | "">("");
  const [status, setStatus] = useState<DebtStatus | "">("active");
  const { data: debts, isLoading } = useDebts(direction, status);
  // Summary totals always reflect every debt regardless of the filters
  // above — a separate, unfiltered fetch so switching to "settled only"
  // never makes the receivable/liability totals look like they dropped to
  // zero.
  const { data: allDebts, isLoading: isSummaryLoading } = useDebts();
  const deleteDebt = useDeleteDebt();

  const [formOpen, setFormOpen] = useState(false);
  const [editingDebt, setEditingDebt] = useState<Debt | null>(null);
  // Tracked by id, not the row object itself — DebtRepaymentsModal stays
  // open across several add-repayment/reverse actions in a row, and each
  // one changes this same debt's own outstanding/status. Re-deriving from
  // `allDebts` (unfiltered by direction/status, unlike `debts` above) on
  // every render means the modal's own header/full-repayment default
  // always reflects the latest state instead of the stale snapshot from
  // whenever the row was first clicked — and never disappears out from
  // under the open modal just because a repayment moved it from "active"
  // to "settled" while the page's own status filter is "active".
  const [repaymentsDebtId, setRepaymentsDebtId] = useState<number | null>(null);
  const repaymentsDebt = allDebts?.find((item) => item.id === repaymentsDebtId) ?? null;

  function openCreate() {
    setEditingDebt(null);
    setFormOpen(true);
  }

  function openEdit(debt: Debt) {
    setEditingDebt(debt);
    setFormOpen(true);
  }

  function handleDelete(debt: Debt) {
    if (!window.confirm(t("debts.confirmDelete", { name: debt.counterparty }))) return;
    deleteDebt.mutate(debt.id, {
      onError: () => window.alert(t("debts.deleteError")),
    });
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-text-muted">{t("debts.pageIntro")}</p>

      <DebtsSummary debts={allDebts ?? []} isLoading={isSummaryLoading} />

      <Card>
        <CardHeader className="flex-wrap gap-3">
          <CardTitle className="normal-case tracking-normal text-base font-semibold text-text-primary">
            {t("nav.debts")}
          </CardTitle>
          <Button onClick={openCreate}>
            <Plus size={16} />
            {t("debts.addButton")}
          </Button>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <Select value={direction} onChange={(event) => setDirection(event.target.value as DebtDirection | "")} className="sm:w-52">
              <option value="">{t("debts.filterDirectionAll")}</option>
              <option value="owed_to_me">{t("debts.filterDirectionOwedToMe")}</option>
              <option value="owed_by_me">{t("debts.filterDirectionOwedByMe")}</option>
            </Select>
            <Select value={status} onChange={(event) => setStatus(event.target.value as DebtStatus | "")} className="sm:w-52">
              <option value="active">{t("debts.filterStatusActive")}</option>
              <option value="settled">{t("debts.filterStatusSettled")}</option>
              <option value="">{t("debts.filterStatusAll")}</option>
            </Select>
          </div>
          {isLoading ? (
            <p className="py-10 text-center text-sm text-text-muted">{t("common.loading")}</p>
          ) : (
            <DebtsTable
              items={debts ?? []}
              today={businessDate}
              onEdit={openEdit}
              onDelete={handleDelete}
              onRepayments={(debt) => setRepaymentsDebtId(debt.id)}
            />
          )}
        </CardContent>
      </Card>

      <DebtFormModal open={formOpen} onClose={() => setFormOpen(false)} debt={editingDebt} />
      <DebtRepaymentsModal open={repaymentsDebtId !== null} onClose={() => setRepaymentsDebtId(null)} debt={repaymentsDebt} />
    </div>
  );
}
