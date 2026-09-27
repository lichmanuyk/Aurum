"""Aggregation behind the "Income & Taxes" report — see
docs/tasks/income-tax-separation.md. Reads INCOME/EXPENSE Transactions (and
their split lines) that already carry assigned_period; never creates,
edits, or infers a classification, and never touches account balances,
ordinary reports or FX resolution — those keep using the row's own real
`date`, exactly as before this existed.
"""
from collections import defaultdict
from datetime import date as date_
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.clock import business_today
from app.models.transaction import Transaction, TransactionSplit
from app.schemas.income_tax import IncomeTaxEntry, IncomeTaxPeriod, IncomeTaxReport
from app.services.fx_service import FXConverter

_EAGER = (selectinload(Transaction.account), selectinload(Transaction.splits))


def _validate_period_params(year: int | None, month: int | None) -> None:
    """Same three period shapes (all time / a year / a specific month) as
    asset_expense_service._validate_period_params, applied to
    assigned_period instead of the real transaction date — see
    docs/tasks/income-tax-separation.md."""
    if month is not None and year is None:
        raise HTTPException(422, "month requires year")
    if year is not None and year > business_today().year:
        raise HTTPException(422, "year cannot be in the future")


def _split_can_match_period(split: TransactionSplit, year: int | None, month: int | None) -> bool:
    """Whether this one split line's own assigned_period could possibly
    survive the request's year/month filter — used to decide, *before*
    touching FX at all, whether a split-bearing transaction needs resolving
    in this request. Mirrors the inline year/month checks the per-line loop
    below (and the plain-row elif branch further down) already apply, just
    reusable as a cheap predicate."""
    if split.assigned_period is None:
        return False
    if year is not None and split.assigned_period.year != year:
        return False
    if month is not None and split.assigned_period.month != month:
        return False
    return True


async def get_income_tax_report(
    session: AsyncSession, year: int | None, month: int | None, page: int, page_size: int
) -> IncomeTaxReport:
    _validate_period_params(year, month)
    fx = await FXConverter.load(session)

    # Every INCOME/EXPENSE row that *might* carry a classification, either
    # on itself or on one of its split lines — narrowed further below once
    # each line's own real assigned_period is known (a plain SQL filter on
    # the split relationship can't also express "this specific line", only
    # "some line of this transaction").
    stmt = select(Transaction).options(*_EAGER).where(
        (Transaction.assigned_period.isnot(None))
        | (Transaction.splits.any(TransactionSplit.assigned_period.isnot(None)))
    )
    rows = (await session.execute(stmt)).scalars().all()

    entries_by_period: dict[date_, list[IncomeTaxEntry]] = defaultdict(list)
    for tx in rows:
        if tx.splits:
            # A split-bearing transaction whose classified line(s) all fall
            # outside the requested year/month must never reach
            # fx.splits(tx) below — unlike fx.transaction() on the
            # plain-row branch further down, fx.splits() resolves FX for
            # the transaction's *whole* amount (needed to keep its
            # largest-remainder rounding correct — see
            # FXConverter.splits), so calling it unconditionally here let a
            # transaction from a completely unrelated assigned_period fail
            # this request with 409 FX_RATE_MISSING for a currency/date
            # this filtered response never needed, or silently add it to
            # fx_rates_used backing nothing actually shown. Checked per
            # transaction (any one matching line is enough to justify
            # resolving the rest, since fx.splits() always needs the whole
            # row anyway) — see also the elif branch's own year/month check
            # just before its fx.transaction(tx) call.
            if not any(_split_can_match_period(split, year, month) for split in tx.splits):
                continue
            for split, (_, amount) in zip(tx.splits, fx.splits(tx)):
                if not _split_can_match_period(split, year, month):
                    continue
                entries_by_period[split.assigned_period].append(
                    IncomeTaxEntry(
                        id=tx.id, split_id=split.id, date=tx.date, kind=split.mandatory_payment_kind,
                        description=tx.description, account_id=tx.account_id, account_name=tx.account.name,
                        account_currency=tx.account.currency, native_amount=split.amount, amount=amount,
                    )
                )
        elif tx.assigned_period is not None:
            if year is not None and tx.assigned_period.year != year:
                continue
            if month is not None and tx.assigned_period.month != month:
                continue
            entries_by_period[tx.assigned_period].append(
                IncomeTaxEntry(
                    id=tx.id, split_id=None, date=tx.date, kind=tx.mandatory_payment_kind,
                    description=tx.description, account_id=tx.account_id, account_name=tx.account.name,
                    account_currency=tx.account.currency, native_amount=tx.amount, amount=fx.transaction(tx),
                )
            )

    periods: list[IncomeTaxPeriod] = []
    for period in sorted(entries_by_period, reverse=True):
        items = sorted(entries_by_period[period], key=lambda e: (e.date, e.id), reverse=True)
        gross_income = sum((e.amount for e in items if e.kind is None), Decimal("0"))
        tax_by_kind: dict[str, Decimal] = defaultdict(Decimal)
        for e in items:
            if e.kind is not None:
                tax_by_kind[e.kind.value] += e.amount
        tax_paid_total = sum(tax_by_kind.values(), Decimal("0"))
        periods.append(
            IncomeTaxPeriod(
                period=period,
                gross_income=gross_income,
                tax_paid_by_kind=dict(tax_by_kind),
                tax_paid_total=tax_paid_total,
                net_after_paid_taxes=gross_income - tax_paid_total,
                income_received=gross_income > 0,
                entries=items,
            )
        )

    total = len(periods)
    offset = (page - 1) * page_size
    page_items = periods[offset : offset + page_size]

    return IncomeTaxReport(
        fx_rates_used=fx.metadata(),
        reporting_currency=fx.currency,
        year=year,
        month=month,
        periods=page_items,
        total=total,
        page=page,
        page_size=page_size,
    )
