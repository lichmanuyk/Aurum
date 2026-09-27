"""Shape of a manually-tracked asset's actual expenses — see
docs/tasks/property-expense-links.md. Read-only: this never creates or
edits a Transaction/RecurringTransaction, it only reports the ones already
linked via expense_asset_id (see routes/transactions.py, services/
recurring_service.py). The asset's own valuation/monthly_cash_flow are
untouched by anything here.
"""
from datetime import date as date_
from decimal import Decimal

from pydantic import BaseModel, Field

from app.schemas.recurring import RecurringTransactionRead


class AssetExpenseItem(BaseModel):
    """One linked expense — either a plain (non-split) Transaction's own
    amount, or one split line of a larger receipt. `id` is always the
    Transaction's id (so the frontend can open/edit the right row);
    `split_id` is set only for a split line, so two split lines of the same
    purchase linked to the same asset don't collide as one row."""

    id: int
    split_id: int | None = None
    date: date_
    description: str
    merchant: str | None
    account_id: int
    account_name: str
    account_currency: str
    # The linked slice's own amount, in the account's native ledger currency
    # (the whole transaction's amount for a plain expense, or just this
    # split line's share) — never the converted `amount` below, so the
    # native fact stays visible next to its equivalent.
    native_amount: Decimal
    category_id: int | None
    category_name: str | None
    is_split: bool
    note: str | None
    # Converted to `reporting_currency` on the parent report (see
    # services/asset_expense_service.py) using the exact same historical-FX/
    # reporting-override/split rules as every other report (dashboard,
    # category ranking, ...) — never a fabricated 0 or a silent 1:1.
    amount: Decimal


class AssetExpenseReport(BaseModel):
    """Everything the asset's "Expenses" view needs in one call: the period
    total (over every matching row, not just the current page — see
    services/asset_expense_service.py), the paginated recent-payments list,
    and the recurring templates already linked to this asset (so "Pay" can
    reuse the existing recurring-payment flow from
    docs/tasks/recurring-variable-payments.md without a second endpoint)."""

    asset_id: int
    reporting_currency: str
    fx_rates_used: list[dict[str, str]] = Field(default_factory=list)
    # None start = "all time" for this asset's linked expenses; end is
    # always clamped to the server's own today (same _resolve_bounds as
    # the dashboard — see services/dashboard_service.py).
    start_date: date_ | None
    end_date: date_
    total_amount: Decimal
    # Linked rows over the *whole* period, not just this page — same count
    # as len(items) would be with page_size large enough to fit everything.
    # A transaction split across two lines that both link this asset counts
    # as two rows here (each is its own payment line), same as `items` below.
    transaction_count: int
    items: list[AssetExpenseItem]
    total: int
    page: int
    page_size: int
    templates: list[RecurringTransactionRead]
