from datetime import date as date_
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.core.text import capitalize_first_letter
from app.models.enums import MandatoryPaymentKind, RecurringFrequency, TransactionType


class RecurringTransactionCreate(BaseModel):
    account_id: int
    category_id: int | None = None
    transfer_account_id: int | None = None
    # Same optional, additive asset link as a plain expense's own
    # expense_asset_id (see docs/tasks/property-expense-links.md) — only
    # valid for an EXPENSE template (see services/recurring_service.py's
    # _ensure_expense_asset_matches_type). Posting the template copies it
    # onto the created Transaction unchanged; it never affects the
    # template's own amount/account or the asset's valuation.
    expense_asset_id: int | None = None
    # Marks this EXPENSE template as always posting one specific mandatory
    # payment — see Transaction.mandatory_payment_kind's docstring and
    # docs/tasks/income-tax-separation.md. No period here: each posting's
    # own assigned_period is supplied explicitly via RecurringPost below,
    # never inferred. None/omitted -> an ordinary template, unchanged.
    mandatory_payment_kind: MandatoryPaymentKind | None = None
    type: TransactionType
    amount: Decimal = Field(gt=0)
    description: str = Field(min_length=1, max_length=255)
    merchant: str | None = None
    notes: str | None = Field(default=None, max_length=2000)
    frequency: RecurringFrequency
    anchor_date: date_

    # Keeps templates consistent with regular transactions — see
    # app/schemas/transaction.py for the same rule.
    @field_validator("description")
    @classmethod
    def _capitalize_description(cls, value: str) -> str:
        return capitalize_first_letter(value)


class RecurringTransactionUpdate(BaseModel):
    account_id: int | None = None
    category_id: int | None = None
    transfer_account_id: int | None = None
    # Omitted -> existing link untouched; explicit null -> cleared; explicit
    # id -> set/replaced (same "explicit user action" contract as
    # Transaction.expense_asset_id's own update field).
    expense_asset_id: int | None = None
    # Same "explicit user action" contract as expense_asset_id above.
    mandatory_payment_kind: MandatoryPaymentKind | None = None
    type: TransactionType | None = None
    amount: Decimal | None = Field(default=None, gt=0)
    description: str | None = Field(default=None, min_length=1, max_length=255)
    merchant: str | None = None
    notes: str | None = Field(default=None, max_length=2000)
    frequency: RecurringFrequency | None = None
    anchor_date: date_ | None = None
    is_active: bool | None = None

    @field_validator("description")
    @classmethod
    def _capitalize_description(cls, value: str | None) -> str | None:
        return capitalize_first_letter(value) if value is not None else None


class RecurringTransactionRead(BaseModel):
    currency: str
    destination_currency: str | None
    id: int
    account_id: int
    account_name: str
    category_id: int | None
    category_name: str | None
    category_color: str | None
    category_icon: str | None
    expense_asset_id: int | None
    mandatory_payment_kind: MandatoryPaymentKind | None
    transfer_account_id: int | None
    transfer_account_name: str | None
    type: TransactionType
    amount: Decimal
    description: str
    merchant: str | None
    notes: str | None
    frequency: RecurringFrequency
    anchor_date: date_
    last_posted_date: date_ | None
    is_active: bool
    # Computed, not stored — see services/recurring_service.py.
    next_due_date: date_
    is_due: bool
    days_until_due: int


class RecurringPost(BaseModel):
    """`amount`/`account_id` are the *actual* payment for an expense
    template only (see docs/tasks/recurring-variable-payments.md) — the
    template's own stored amount/account never change. Both stay optional
    so an old bare POST (no body) keeps posting the template's own values
    unchanged; an explicit `null` for either is rejected by the service
    (via `model_fields_set`), not silently treated as "unset", so a caller
    can never accidentally clear a required field."""

    destination_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    account_id: int | None = None
    # Required exactly when the template being posted has its own
    # mandatory_payment_kind set (a ZUS/PPE/VAT template) — the month this
    # posting's payment is *for*, independent of `date` (always today —
    # see services/recurring_service.py). Rejected outright, never
    # silently ignored or defaulted, when sent for any other template: see
    # docs/tasks/income-tax-separation.md.
    assigned_period: date_ | None = None
