"""Aggregation behind a manually-tracked asset's "Expenses" view — see
docs/tasks/property-expense-links.md. Reads EXPENSE Transactions (and their
split lines) that already carry this asset's id in expense_asset_id; never
creates, edits, or infers a link, and never touches the asset's own
valuation/monthly_cash_flow (Asset.monthly_cash_flow stays a separate,
self-reported estimate — see models/asset.py).
"""
from datetime import date as date_
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.asset import Asset
from app.models.enums import TransactionType
from app.models.recurring import RecurringTransaction
from app.models.transaction import Transaction, TransactionSplit
from app.schemas.asset_expense import AssetExpenseItem, AssetExpenseReport
# Reused, not reimplemented: the same (start, end) period rules the
# dashboard already uses (all time / a year / a specific month, end clamped
# to the server's own today) — see docs/tasks/dashboard-periods.md.
from app.services.dashboard_service import _resolve_bounds
from app.services.fx_service import FXConverter
from app.services.recurring_service import _EAGER as _RECURRING_EAGER
from app.services.recurring_service import _to_read as _recurring_to_read

_EAGER = (
    selectinload(Transaction.account),
    selectinload(Transaction.category),
    selectinload(Transaction.splits).selectinload(TransactionSplit.category),
)


def _validate_period_params(year: int | None, month: int | None) -> None:
    """`_resolve_bounds` (dashboard_service.py) silently *ignores* `month`
    whenever `year` is omitted — reused here for the same three period
    shapes (all time / a year / a specific month), but this route (unlike
    the Dashboard's own, which only ever sends a resolved year/month pair —
    see routes/dashboard.py) exposes both as independent, caller-supplied
    query params, so that silent drop would let a caller believe they
    filtered by month while actually getting the unfiltered all-time total.
    A year entirely in the future would resolve to start > end (Jan 1 of
    that year vs. today) — a silently empty report for a period that
    looks like a request-shape error, not a real "no expenses yet" — so
    it's rejected outright too, same as an incompatible combination."""
    if month is not None and year is None:
        raise HTTPException(422, "month requires year")
    if year is not None and year > date_.today().year:
        raise HTTPException(422, "year cannot be in the future")


async def get_asset_expense_report(
    session: AsyncSession, asset_id: int, year: int | None, month: int | None, page: int, page_size: int
) -> AssetExpenseReport:
    _validate_period_params(year, month)
    asset = await session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")

    start, end = _resolve_bounds(year, month)
    # get_reporting_session (api/deps.py) has already applied any `currency`
    # query override to this FXConverter for the whole request — same
    # instance the route's response's reporting_currency comes from, so a
    # switched capital-section currency is never stale here.
    fx = await FXConverter.load(session)

    stmt = (
        select(Transaction)
        .options(*_EAGER)
        .where(
            Transaction.type == TransactionType.EXPENSE,
            Transaction.date <= end,
            or_(
                Transaction.expense_asset_id == asset_id,
                Transaction.splits.any(TransactionSplit.expense_asset_id == asset_id),
            ),
        )
        # Sort by date/id, not insertion order — see
        # docs/tasks/property-expense-links.md's pagination invariant.
        .order_by(Transaction.date.desc(), Transaction.id.desc())
    )
    if start is not None:
        stmt = stmt.where(Transaction.date >= start)
    transactions = (await session.execute(stmt)).scalars().all()

    rows: list[AssetExpenseItem] = []
    for tx in transactions:
        if tx.expense_asset_id == asset_id:
            # A plain (non-split) expense links its whole amount — see
            # expense_asset_link_violation (schemas/transaction.py): a
            # linked transaction's parent and its own splits are mutually
            # exclusive, so this branch and the split branch below never
            # both fire for the same row.
            rows.append(
                AssetExpenseItem(
                    id=tx.id,
                    split_id=None,
                    date=tx.date,
                    description=tx.description,
                    merchant=tx.merchant,
                    account_id=tx.account_id,
                    account_name=tx.account.name,
                    account_currency=tx.account.currency,
                    native_amount=tx.amount,
                    category_id=tx.category_id,
                    category_name=tx.category.name if tx.category else None,
                    is_split=False,
                    note=None,
                    amount=fx.transaction(tx),
                )
            )
        else:
            # A split line's own reporting amount must go through fx.splits
            # (not fx.transaction on the parent) — it allocates the
            # parent's already-rounded total across lines with the same
            # largest-remainder rule every other split-aware report uses
            # (reports_service.py, dashboard_service.py's category rollup),
            # so this asset's own total never drifts from what those
            # reports would say about the exact same lines. zip() relies on
            # fx.splits returning values in tx.splits' own order (see
            # services/fx_service.py).
            for split, (_, converted) in zip(tx.splits, fx.splits(tx)):
                if split.expense_asset_id != asset_id:
                    continue
                rows.append(
                    AssetExpenseItem(
                        id=tx.id,
                        split_id=split.id,
                        date=tx.date,
                        description=tx.description,
                        merchant=tx.merchant,
                        account_id=tx.account_id,
                        account_name=tx.account.name,
                        account_currency=tx.account.currency,
                        native_amount=split.amount,
                        category_id=split.category_id,
                        category_name=split.category.name if split.category else None,
                        is_split=True,
                        note=split.note,
                        amount=converted,
                    )
                )

    # The period total covers every matching row, never just the requested
    # page (docs/tasks/property-expense-links.md's pagination invariant).
    total_amount = sum((row.amount for row in rows), Decimal("0"))
    total = len(rows)
    offset = (page - 1) * page_size
    page_items = rows[offset : offset + page_size]

    templates_result = await session.execute(
        select(RecurringTransaction)
        .options(*_RECURRING_EAGER)
        .where(RecurringTransaction.expense_asset_id == asset_id)
        .order_by(RecurringTransaction.id)
    )
    templates = [_recurring_to_read(row) for row in templates_result.scalars().all()]

    return AssetExpenseReport(
        asset_id=asset_id,
        reporting_currency=fx.currency,
        fx_rates_used=fx.metadata(),
        start_date=start,
        end_date=end,
        total_amount=total_amount,
        transaction_count=total,
        items=page_items,
        total=total,
        page=page,
        page_size=page_size,
        templates=templates,
    )
