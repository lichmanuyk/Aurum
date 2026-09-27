import { ArrowDownLeft, ArrowUpRight, HandCoins, Pencil, Trash2 } from "lucide-react";
import { formatMoney, formatTransactionDate } from "@/lib/format";
import { useTranslation } from "@/lib/i18n";
import type { Debt } from "@/types";

interface DebtsTableProps {
  items: Debt[];
  today: string | undefined;
  onEdit: (debt: Debt) => void;
  onDelete: (debt: Debt) => void;
  onRepayments: (debt: Debt) => void;
}

export function DebtsTable({ items, today, onEdit, onDelete, onRepayments }: DebtsTableProps) {
  const { t } = useTranslation();

  if (items.length === 0) {
    return <p className="py-10 text-center text-sm text-text-muted">{t("debts.empty")}</p>;
  }

  return (
    <ul className="divide-y divide-gridline">
      {items.map((debt) => {
        // owed_to_me: someone else's cash eventually flows back to me — an
        // inbound arrow, same "receivable" shape as income. owed_by_me is
        // the mirror. Never inferred from any amount's sign (see
        // models/enums.py's DebtDirection docstring) — this is purely a
        // display choice off the explicit `direction` field.
        const Icon = debt.direction === "owed_to_me" ? ArrowDownLeft : ArrowUpRight;
        const iconColor = debt.direction === "owed_to_me" ? "var(--success)" : "var(--danger)";
        const overdue = debt.status === "active" && debt.due_date !== null && today !== undefined && debt.due_date < today;
        const deleteLocked = debt.repayment_count > 0;

        return (
          <li key={debt.id} className="flex flex-wrap items-center gap-3 py-3">
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: `${iconColor}26` }}
            >
              <Icon size={16} style={{ color: iconColor }} />
            </span>

            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-text-primary">
                {debt.counterparty}
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    debt.status === "active" ? "bg-surface-2 text-text-secondary" : "bg-surface-2 text-text-muted"
                  }`}
                >
                  {t(debt.status === "active" ? "debts.status.active" : "debts.status.settled")}
                </span>
                {overdue && (
                  <span className="ml-1 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-medium text-danger">
                    {t("debts.table.overdue")}
                  </span>
                )}
              </span>
              <span className="block truncate text-xs text-text-muted">
                {t(`debts.funding.${debt.funding}`)}
                {debt.funding === "new_loan" && debt.account_name ? ` · ${debt.account_name}` : ""}
                {" · "}
                {t("debts.table.startDate", { date: formatTransactionDate(debt.start_date, true) })}
                {debt.due_date ? ` · ${t("debts.table.due", { date: formatTransactionDate(debt.due_date, true) })}` : ""}
                {debt.repayment_count > 0 ? ` · ${t("debts.table.repaymentsCount", { count: debt.repayment_count })}` : ""}
              </span>
            </span>

            <span className="shrink-0 text-right text-sm font-medium tabular-nums text-text-primary">
              {formatMoney(debt.outstanding_amount, debt.currency)}
              <span className="block text-xs font-normal text-text-muted">
                / {formatMoney(debt.principal_amount, debt.currency)}
              </span>
            </span>

            <span className="flex shrink-0 gap-1">
              <button
                type="button"
                aria-label={`${debt.counterparty}: ${t("debts.table.repayButton")}`}
                onClick={() => onRepayments(debt)}
                className="rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"
              >
                <HandCoins size={15} />
              </button>
              <button
                type="button"
                aria-label={`${debt.counterparty}: ${t("common.edit")}`}
                onClick={() => onEdit(debt)}
                className="rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-text-primary"
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                aria-label={`${debt.counterparty}: ${t("common.delete")}`}
                title={deleteLocked ? t("debts.table.deleteLockedTitle") : undefined}
                disabled={deleteLocked}
                onClick={() => onDelete(debt)}
                className="rounded-md p-1.5 text-text-muted hover:bg-surface-2 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-text-muted"
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
