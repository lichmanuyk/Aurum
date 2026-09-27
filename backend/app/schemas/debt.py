"""Shapes for Debt/DebtRepayment — see docs/tasks/debt-tracking.md and
models/debt.py for the full design rationale."""
from datetime import date as date_
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.core.money import Currency
from app.models.enums import DebtDirection, DebtRepaymentKind

Funding = Literal["opening_balance", "new_loan"]


def debt_amount_pair_violation(
    *, debt_currency: str, account_currency: str, debt_amount: Decimal, account_amount: Decimal | None
) -> str | None:
    """Same "same-currency amounts must match; a different currency needs
    BOTH facts explicit, never inferred from FX" rule as a cross-currency
    Transfer's own destination_amount (see
    money_service.validate_transaction) — reused here for a Debt's own
    principal/issuance-amount pair and a DebtRepayment's own
    amount_debt_currency/account-amount pair. Returns the problem as text,
    or None if the combination is valid; the caller resolves the actual
    account-currency amount to use (account_amount, or debt_amount when
    omitted and currencies match) — this only validates the pair."""
    if debt_currency == account_currency:
        if account_amount is not None and account_amount != debt_amount:
            return "Same-currency amounts must match; record fees as a separate transaction"
        return None
    if account_amount is None or account_amount <= 0:
        return "A different account currency needs an explicit actual account amount, never inferred from FX"
    return None


class DebtCreate(BaseModel):
    direction: DebtDirection
    counterparty: str = Field(min_length=1, max_length=150)
    currency: Currency
    principal_amount: Decimal = Field(gt=0, max_digits=18, decimal_places=6)
    start_date: date_
    due_date: date_ | None = None
    note: str | None = Field(default=None, max_length=2000)
    # "opening_balance" — an already-existing debt, no cash movement at
    # all (account_id/issuance_account_amount must be omitted).
    # "new_loan" — the actual cash leg of the loan happening now, on the
    # chosen account_id (issuance_account_amount only when its currency
    # differs from `currency` — see debt_amount_pair_violation above).
    funding: Funding
    account_id: int | None = None
    issuance_account_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    idempotency_key: str = Field(min_length=1, max_length=64)

    @model_validator(mode="after")
    def _validate(self) -> "DebtCreate":
        if self.due_date is not None and self.due_date < self.start_date:
            raise ValueError("due_date cannot be before start_date")
        if self.funding == "opening_balance":
            if self.account_id is not None or self.issuance_account_amount is not None:
                raise ValueError("An opening-balance debt has no account or cash amount — it never moves money")
        elif self.account_id is None:
            raise ValueError("A new loan needs a cash account")
        return self


class DebtUpdate(BaseModel):
    """Metadata (counterparty/note/due_date) is always editable. The
    financial fields below are only accepted while the debt is still an
    opening-balance one with zero repayments (see services/debt_service.py's
    _financial_fields_locked) — a new loan's terms (and account/amount) are
    fixed at creation; delete (while it still has zero repayments) and
    recreate it instead, the same "delete and recreate" contract
    asset_movement_service.update_movement already uses for its own
    immutable fields."""

    direction: DebtDirection | None = None
    counterparty: str | None = Field(default=None, min_length=1, max_length=150)
    currency: Currency | None = None
    principal_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    start_date: date_ | None = None
    # Omitted -> untouched; explicit null -> cleared; a date -> set. Same
    # "sent vs omitted" contract as every other optional field in this app
    # (see TransactionUpdate.expense_asset_id).
    due_date: date_ | None = None
    note: str | None = None


class DebtRead(BaseModel):
    id: int
    direction: DebtDirection
    counterparty: str
    currency: str
    principal_amount: Decimal
    outstanding_amount: Decimal
    status: Literal["active", "settled"]
    start_date: date_
    due_date: date_ | None
    note: str | None
    funding: Funding
    account_id: int | None
    account_name: str | None
    issuance_account_amount: Decimal | None
    issuance_account_currency: str | None
    repayment_count: int
    idempotency_key: str | None
    created_at: datetime
    updated_at: datetime


class DebtRepaymentCreate(BaseModel):
    account_id: int
    date: date_
    # The debt's own native-currency amount this repayment reduces
    # outstanding by — always explicit, never derived from account_amount
    # via FX (see debt_amount_pair_violation).
    amount_debt_currency: Decimal = Field(gt=0, max_digits=18, decimal_places=6)
    # Only required when the account's currency differs from the debt's
    # own; when they match, omitted defaults to amount_debt_currency.
    account_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    note: str | None = Field(default=None, max_length=2000)
    idempotency_key: str = Field(min_length=1, max_length=64)


class DebtRepaymentUpdate(BaseModel):
    """`note` is the only field this ever actually changes — see
    services/debt_service.py's update_repayment. The financial fields
    below are kept on the schema (rather than dropped outright) only so a
    request that tries to change one gets an explicit, honest 409 back
    instead of Pydantic silently discarding an unknown field: a
    repayment/reversal's own account/date/amount are immutable once
    recorded, for both kinds, regardless of reversed state — the supported
    correction path is deleting it (if nothing reverses it) or reversing
    it, then recording a fresh, correct one. This is deliberately simpler
    than a partial in-place edit: recomputing "outstanding excluding this
    row" reads correctly for an active `repayment` but is meaningless for
    a `reversal` (excluding it "revives" the repayment it undoes, wrongly
    tying an unrelated note edit to an overpay check)."""

    account_id: int | None = None
    date: date_ | None = None
    amount_debt_currency: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    account_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    note: str | None = None


class DebtRepaymentReverse(BaseModel):
    """Reverses one specific earlier `repayment` row — see
    DebtRepayment.reverses_repayment_id. The debt-currency amount undone
    always mirrors the original row exactly (not user-editable here); only
    the actual compensating cash leg (account/date/account_amount) is
    supplied, since the money might come back through a different account
    than it left through."""

    account_id: int
    date: date_
    account_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    note: str | None = Field(default=None, max_length=2000)
    idempotency_key: str = Field(min_length=1, max_length=64)


class DebtRepaymentRead(BaseModel):
    id: int
    debt_id: int
    kind: DebtRepaymentKind
    reverses_repayment_id: int | None
    amount_debt_currency: Decimal
    account_id: int
    account_name: str
    account_currency: str
    account_amount: Decimal
    date: date_
    note: str | None
    idempotency_key: str | None
    # True when some other repayment row's reverses_repayment_id points at
    # this one — a reversed `repayment` row's own financial fields are
    # locked (see services/debt_service.py); always False for a `reversal`
    # row itself (reversals can't be re-reversed).
    is_reversed: bool
