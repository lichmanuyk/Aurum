"""Aggregation logic behind the Overview dashboard."""

from app.services.fx_service import FXConverter
from app.services.money_service import mandatory_tax_amount, ordinary_lines, transactions_for_reporting
import calendar
from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import business_today
from app.models.enums import TransactionType
from app.models.transaction import Transaction
from app.schemas.dashboard import CategoryBreakdownChildItem, CategoryBreakdownItem, DashboardSummary
from app.services.category_rollup import rollup_spending_by_top_level_category

# Categorical slots are capped at 8 (dataviz skill: a 9th series folds into "Other",
# never a generated hue) — this is also the exact size of the default category set.
MAX_CHART_SLICES = 8
OTHER_SLICE_COLOR = "#898781"  # muted ink, reserved for the non-categorical rollup


def _resolve_bounds(year: int | None, month: int | None) -> tuple[date | None, date]:
    """Turns the dashboard's period selection into a (start, end) range —
    `start=None` means "all time" (no lower bound; whatever the earliest
    activity is). `end` is always clamped to today: a past month/year's own
    calendar end is already <= today, so this only changes anything for the
    *current* month/year (or all-time itself), which is exactly where a
    stray future-dated transaction must not leak into a period that's
    supposed to end today (see docs/tasks/dashboard-periods.md)."""
    today = business_today()
    if year is None:
        return None, today
    if month is None:
        return date(year, 1, 1), min(date(year, 12, 31), today)
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, 1), min(date(year, month, last_day), today)


async def get_dashboard_summary(session: AsyncSession, year: int | None, month: int | None) -> DashboardSummary:
    start, end = _resolve_bounds(year, month)

    fx = await FXConverter.load(session)
    real_income = Decimal("0")
    # "Ordinary" only — a mandatory tax payment (ZUS/PPE/VAT) is real cash
    # that really left an account, but it gets its own separate, explicit
    # total below instead of hiding inside this one — see
    # docs/tasks/income-tax-separation.md. `net` further down still
    # subtracts both, so it stays the same real cash figure as before this
    # split existed; only the breakdown feeding the donut/percentages
    # changes.
    spent = Decimal("0")
    mandatory_payments_paid = Decimal("0")
    transferred_out = Decimal("0")
    for tx in await transactions_for_reporting(session, start, end):
        if tx.type == TransactionType.INCOME:
            real_income += fx.transaction(tx)
        elif tx.type == TransactionType.EXPENSE:
            spent += sum((amount for _, amount in ordinary_lines(tx, fx)), Decimal("0"))
            mandatory_payments_paid += mandatory_tax_amount(tx, fx)
        elif tx.type == TransactionType.TRANSFER:
            transferred_out += fx.transaction(tx)

    # A subcategory's spending rolls up into its parent's slice, and a split
    # transaction's category_id=NULL means its category lives on its split
    # lines instead — rollup_spending_by_top_level_category handles both
    # the same way a plain transaction's category already was.
    rows = await rollup_spending_by_top_level_category(
        session, transaction_type=TransactionType.EXPENSE, start_date=start, end_date=end
    )

    top_rows, rest_rows = rows[:MAX_CHART_SLICES], rows[MAX_CHART_SLICES:]

    def _percent(amount: Decimal) -> float:
        return float(amount / spent * 100) if spent else 0.0

    spending_by_category = [
        CategoryBreakdownItem(
            category_id=row.category_id, name=row.name, color=row.color, icon=row.icon,
            amount=row.amount, percent=_percent(row.amount),
            children=[
                CategoryBreakdownChildItem(
                    category_id=child.category_id, name=child.name, color=child.color, icon=child.icon,
                    amount=child.amount,
                )
                for child in row.children
            ],
        )
        for row in top_rows
    ]

    if rest_rows:
        other_amount = sum((row.amount for row in rest_rows), Decimal("0"))
        spending_by_category.append(
            CategoryBreakdownItem(
                category_id=None, name="Other", color=OTHER_SLICE_COLOR, icon="more-horizontal",
                amount=other_amount, percent=_percent(other_amount),
            )
        )

    return DashboardSummary(
        fx_rates_used=fx.metadata(),
        reporting_currency=fx.currency,
        year=year,
        month=month,
        start_date=start,
        end_date=end,
        real_income=real_income,
        spent=spent,
        mandatory_payments_paid=mandatory_payments_paid,
        net=real_income - spent - mandatory_payments_paid,
        transferred_out=transferred_out,
        spending_by_category=spending_by_category,
    )
