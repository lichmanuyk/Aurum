"""Long-range spending reports — the analysis the month-scoped Dashboard
breakdown can't answer on its own: "how much did I spend on X this month,
and how much in total over N years" (single-category detail), and "which
categories cost the most over this whole period" (ranking, across all
categories of one kind at once, not just the current month).
"""

from app.services.fx_service import FXConverter
from app.services.money_service import transactions_for_reporting
from collections import defaultdict
from datetime import date as date_
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.category import Category
from app.models.enums import CategoryKind, TransactionType
from app.models.transaction import Transaction, TransactionSplit
from app.schemas.reports import (
    CategoryRankingChildItem,
    CategoryRankingItem,
    CategoryRankingReport,
    CategorySpendingPoint,
    CategorySpendingReport,
)
from app.services.category_rollup import rollup_spending_by_top_level_category


def _next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


async def get_category_spending_report(
    session: AsyncSession, category_id: int, start_date: date_ | None, end_date: date_ | None
) -> CategorySpendingReport:
    category = await session.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=404, detail="Category not found")

    # A top-level category's own report folds in its subcategories' spending
    # too (same rollup as the Dashboard breakdown); a subcategory picked
    # directly shows just its own transactions — there's nothing beneath it.
    category_ids: list[int] = [category_id]
    if category.parent_id is None:
        child_ids = (
            await session.execute(select(Category.id).where(Category.parent_id == category_id))
        ).scalars().all()
        category_ids.extend(child_ids)

    # Plain transactions filed directly under one of these categories, plus
    # split lines that assign part of a transaction to one of them — same
    # two sources category_rollup.py unions for the Dashboard/ranking report.
    fx = await FXConverter.load(session)
    contributions = []
    for tx in await transactions_for_reporting(session, start_date, end_date):
        if tx.type not in (TransactionType.INCOME, TransactionType.EXPENSE):
            continue
        if tx.category_id not in category_ids and not any(line.category_id in category_ids for line in tx.splits):
            continue
        lines = fx.splits(tx) if tx.splits else [(tx.category_id, fx.transaction(tx))]
        contributions.extend((tx.id, tx.date, amount) for cat_id, amount in lines if cat_id in category_ids)

    empty = CategorySpendingReport(
        fx_rates_used=fx.metadata(),
        reporting_currency=fx.currency,
        category_id=category.id,
        category_name=category.name,
        category_color=category.color,
        category_icon=category.icon,
        start_date=start_date,
        end_date=end_date,
        total_amount=Decimal("0"),
        transaction_count=0,
        average_per_month=Decimal("0"),
        series=[],
    )
    if not contributions:
        return empty

    dates = [txn_date for _, txn_date, _ in contributions]
    effective_start = start_date or min(dates)
    effective_end = end_date or max(dates)

    by_month: dict[tuple[int, int], Decimal] = defaultdict(Decimal)
    for _, txn_date, amount in contributions:
        by_month[(txn_date.year, txn_date.month)] += amount

    total_amount = sum((amount for _, _, amount in contributions), Decimal("0"))
    # Distinct transactions, not rows — a transaction split across two of
    # these categories (e.g. parent + one of its children) must count once,
    # the same as a plain transaction filed under just one of them.
    total_count = len({transaction_id for transaction_id, _, _ in contributions})

    series: list[CategorySpendingPoint] = []
    year, month = effective_start.year, effective_start.month
    while (year, month) <= (effective_end.year, effective_end.month):
        series.append(CategorySpendingPoint(year=year, month=month, amount=by_month.get((year, month), Decimal("0"))))
        year, month = _next_month(year, month)

    months_count = len(series)
    average_per_month = (total_amount / months_count).quantize(Decimal("0.01")) if months_count else Decimal("0")

    return CategorySpendingReport(
        fx_rates_used=fx.metadata(),
        reporting_currency=fx.currency,
        category_id=category.id,
        category_name=category.name,
        category_color=category.color,
        category_icon=category.icon,
        start_date=effective_start,
        end_date=effective_end,
        total_amount=total_amount,
        transaction_count=total_count,
        average_per_month=average_per_month,
        series=series,
    )


_KIND_TO_TRANSACTION_TYPE = {
    CategoryKind.EXPENSE: TransactionType.EXPENSE,
    CategoryKind.INCOME: TransactionType.INCOME,
}


async def get_category_ranking_report(
    session: AsyncSession, kind: CategoryKind, start_date: date_ | None, end_date: date_ | None
) -> CategoryRankingReport:
    """All categories of one kind, ranked by total spent/earned over an
    arbitrary period — "which category costs the most" across the whole
    range, unlike the month-scoped Dashboard breakdown or the
    single-category detail above."""
    # A transaction's type already restricts it to categories of the
    # matching kind (enforced at write time by _ensure_category_matches_type
    # in routes/transactions.py), so filtering by transaction_type below is
    # enough — no separate kind filter needed, and the shared rollup already
    # unions plain transactions with split lines the same way the Dashboard
    # breakdown does.
    rows = await rollup_spending_by_top_level_category(
        session, transaction_type=_KIND_TO_TRANSACTION_TYPE[kind], start_date=start_date, end_date=end_date
    )
    total_amount = sum((row.amount for row in rows), Decimal("0"))

    def _percent(amount: Decimal) -> float:
        return float(amount / total_amount * 100) if total_amount else 0.0

    items = [
        CategoryRankingItem(
            category_id=row.category_id,
            name=row.name,
            color=row.color,
            icon=row.icon,
            amount=row.amount,
            percent=_percent(row.amount),
            transaction_count=row.transaction_count,
            children=[
                CategoryRankingChildItem(
                    category_id=child.category_id, name=child.name, color=child.color, icon=child.icon,
                    amount=child.amount,
                )
                for child in row.children
            ],
        )
        for row in rows
    ]

    return CategoryRankingReport(reporting_currency=(await FXConverter.load(session)).currency, start_date=start_date, end_date=end_date, total_amount=total_amount, items=items)
