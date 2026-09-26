from datetime import date as date_
from decimal import Decimal

from pydantic import BaseModel, Field


class CategoryBreakdownChildItem(BaseModel):
    """One subcategory's (or the parent's own direct, un-subcategorized)
    share of a CategoryBreakdownItem's total — see
    services/category_rollup.py's CategoryRollupChildItem."""

    category_id: int
    name: str
    color: str
    icon: str | None
    amount: Decimal


class CategoryBreakdownItem(BaseModel):
    category_id: int | None
    name: str
    color: str
    icon: str | None
    amount: Decimal
    percent: float
    # Populated only when this slice's spend came from more than one
    # distinct category (subcategories, or a mix of the parent itself and
    # its children) — e.g. a receipt split across "Groceries" subcategories.
    children: list[CategoryBreakdownChildItem] = Field(default_factory=list)


class DashboardSummary(BaseModel):
    fx_rates_used: list[dict[str, str]] = Field(default_factory=list)
    reporting_currency: str
    # None means "all time" (year) / "every month of `year`" (month) — see
    # docs/tasks/dashboard-periods.md and dashboard_service._resolve_bounds.
    year: int | None
    month: int | None
    # The actual (start, end) range these totals were computed over —
    # `end_date` is what "today" resolved to on THIS server, not whatever
    # date the browser's own clock/timezone thinks it is. The frontend
    # must reuse these verbatim (Recent Transactions, the "all transactions"
    # link) instead of recomputing its own "today" — see
    # docs/tasks/dashboard-periods.md's review notes on the client/server
    # timezone mismatch this replaces.
    start_date: date_ | None
    end_date: date_
    real_income: Decimal
    spent: Decimal
    net: Decimal
    transferred_out: Decimal
    spending_by_category: list[CategoryBreakdownItem]
