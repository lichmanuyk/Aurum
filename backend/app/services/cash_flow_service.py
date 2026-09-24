"""Month-by-month income vs. expense — the multi-month view neither the
Dashboard (locked to one month) nor Reports (one category at a time, or a
category ranking) answers on its own. Transfers between the user's own
accounts are excluded from both totals, same as the Dashboard breakdown.
"""

from app.services.fx_service import FXConverter
from app.services.money_service import transactions_for_reporting
from collections import defaultdict
from datetime import date as date_
from decimal import Decimal

from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import TransactionType
from app.models.transaction import Transaction
from app.schemas.cash_flow import CashFlowPoint, CashFlowResponse


def _next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


async def get_cash_flow(
    session: AsyncSession, start_date: date_ | None, end_date: date_ | None
) -> CashFlowResponse:
    fx = await FXConverter.load(session)
    bounds_stmt = select(func.min(Transaction.date), func.max(Transaction.date)).where(
        Transaction.type.in_([TransactionType.INCOME, TransactionType.EXPENSE])
    )
    if start_date:
        bounds_stmt = bounds_stmt.where(Transaction.date >= start_date)
    if end_date:
        bounds_stmt = bounds_stmt.where(Transaction.date <= end_date)
    min_date, max_date = (await session.execute(bounds_stmt)).one()

    effective_start = start_date or min_date
    effective_end = end_date or max_date

    empty = CashFlowResponse(
        fx_rates_used=fx.metadata(),
        reporting_currency=fx.currency,
        start_date=effective_start,
        end_date=effective_end,
        points=[],
        total_income=Decimal("0"),
        total_expense=Decimal("0"),
        total_net=Decimal("0"),
    )
    if effective_start is None or effective_end is None:
        return empty

    by_month = defaultdict(lambda: defaultdict(Decimal))
    for tx in await transactions_for_reporting(session, effective_start, effective_end):
        if tx.type in (TransactionType.INCOME, TransactionType.EXPENSE):
            by_month[(tx.date.year, tx.date.month)][tx.type] += fx.transaction(tx)

    points: list[CashFlowPoint] = []
    year, month = effective_start.year, effective_start.month
    while (year, month) <= (effective_end.year, effective_end.month):
        totals = by_month.get((year, month), {})
        income = totals.get(TransactionType.INCOME, Decimal("0"))
        expense = totals.get(TransactionType.EXPENSE, Decimal("0"))
        points.append(CashFlowPoint(year=year, month=month, income=income, expense=expense, net=income - expense))
        year, month = _next_month(year, month)

    total_income = sum((p.income for p in points), Decimal("0"))
    total_expense = sum((p.expense for p in points), Decimal("0"))

    return CashFlowResponse(
        fx_rates_used=fx.metadata(),
        reporting_currency=fx.currency,
        start_date=effective_start,
        end_date=effective_end,
        points=points,
        total_income=total_income,
        total_expense=total_expense,
        total_net=total_income - total_expense,
    )
