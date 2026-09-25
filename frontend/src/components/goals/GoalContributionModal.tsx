import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { useAccounts } from "@/hooks/useAccounts";
import { useAddGoalContribution } from "@/hooks/useGoals";
import { useTranslation } from "@/lib/i18n";
import { formatMoney } from "@/lib/format";
import type { Goal } from "@/types";

interface GoalContributionModalProps {
  open: boolean;
  onClose: () => void;
  goal: Goal | null;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function GoalContributionModal({ open, onClose, goal }: GoalContributionModalProps) {
  const { t } = useTranslation();
  const addContribution = useAddGoalContribution();
  const { data: accounts } = useAccounts();
  const eligible = accounts?.filter(account => account.currency === goal?.currency &&
    ["checking", "debit_card", "savings", "cash", "investment"].includes(account.type)) ?? [];

  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(0);
  const [date, setDate] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAmount("");
    setAccountId(0);
    setDate(todayIso());
    setError(null);
  }, [open, goal]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!goal || !accountId) return;
    setError(null);

    try {
      await addContribution.mutateAsync({ id: goal.id, input: { amount, date, account_id: accountId } });
      onClose();
    } catch {
      setError(t("goal.contribution.saveError"));
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={goal ? t("goal.contribution.title", { name: goal.name }) : ""}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <Label htmlFor="contribution-account">{t("goal.contribution.accountLabel")}</Label>
          <Select id="contribution-account" required value={accountId || ""} onChange={event => setAccountId(Number(event.target.value))}>
            <option value="" disabled>{t("goal.contribution.chooseAccount")}</option>
            {eligible.map(account => <option key={account.id} value={account.id}>{account.name} · {formatMoney(account.available_balance, account.currency)} {t("goal.contribution.available")}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="contribution-amount">{t("goal.contribution.amountLabel")} ({goal?.currency})</Label>
            <Input
              id="contribution-amount"
              type="number"
              step="0.01"
              required
              placeholder={t("goal.contribution.amountPlaceholder")}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="contribution-date">{t("goal.contribution.dateLabel")}</Label>
            <Input
              id="contribution-date"
              type="date"
              required
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-text-muted">{t("goal.contribution.hint")}</p>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={addContribution.isPending || !accountId}>
            {addContribution.isPending ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
