"""Recurring transaction templates: CRUD, plus "post now" — a one-click
action that creates a real Transaction from the template. Deliberately not a
background job (see also insights_service.py's docstring on scope): the
schedule only advances when the user actually clicks Post, so a missed
week never silently back-fills a pile of transactions.
"""

from app.services.money_service import validate_transaction
import calendar
from datetime import date as date_
from datetime import timedelta

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.account import Account
from app.models.category import Category
from app.models.enums import CategoryKind, RecurringFrequency, TransactionType
from app.models.recurring import RecurringTransaction
from app.models.transaction import Transaction
from app.schemas.recurring import RecurringPost, RecurringTransactionCreate, RecurringTransactionRead, RecurringTransactionUpdate

_EAGER = (
    selectinload(RecurringTransaction.account),
    selectinload(RecurringTransaction.category),
    selectinload(RecurringTransaction.transfer_account),
)

_TYPE_TO_CATEGORY_KIND = {
    TransactionType.INCOME: CategoryKind.INCOME,
    TransactionType.EXPENSE: CategoryKind.EXPENSE,
}


async def _ensure_category_matches_type(
    session: AsyncSession, category_id: int | None, transaction_type: TransactionType
) -> None:
    if category_id is None:
        return
    expected_kind = _TYPE_TO_CATEGORY_KIND.get(transaction_type)
    category = await session.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=400, detail="Category not found")
    if expected_kind is not None and category.kind != expected_kind:
        raise HTTPException(
            status_code=400,
            detail=f"Category '{category.name}' is a {category.kind.value} category and cannot be used for a {transaction_type.value} recurring transaction",
        )


def _advance(day: date_, frequency: RecurringFrequency) -> date_:
    if frequency == RecurringFrequency.WEEKLY:
        return day + timedelta(days=7)
    if frequency == RecurringFrequency.MONTHLY:
        year = day.year + (day.month // 12)
        month = day.month % 12 + 1
        clamped_day = min(day.day, calendar.monthrange(year, month)[1])
        return date_(year, month, clamped_day)
    # YEARLY — Feb 29 anchors fall back to Feb 28 in non-leap years.
    try:
        return day.replace(year=day.year + 1)
    except ValueError:
        return day.replace(year=day.year + 1, day=28)


def _next_due_date(recurring: RecurringTransaction) -> date_:
    if recurring.last_posted_date is None:
        return recurring.anchor_date
    return _advance(recurring.last_posted_date, recurring.frequency)


def _to_read(recurring: RecurringTransaction) -> RecurringTransactionRead:
    next_due = _next_due_date(recurring)
    today = date_.today()
    return RecurringTransactionRead(
        currency=recurring.account.currency,
        destination_currency=recurring.transfer_account.currency if recurring.transfer_account else None,
        id=recurring.id,
        account_id=recurring.account_id,
        account_name=recurring.account.name,
        category_id=recurring.category_id,
        category_name=recurring.category.name if recurring.category else None,
        category_color=recurring.category.color if recurring.category else None,
        category_icon=recurring.category.icon if recurring.category else None,
        transfer_account_id=recurring.transfer_account_id,
        transfer_account_name=recurring.transfer_account.name if recurring.transfer_account else None,
        type=recurring.type,
        amount=recurring.amount,
        description=recurring.description,
        merchant=recurring.merchant,
        notes=recurring.notes,
        frequency=recurring.frequency,
        anchor_date=recurring.anchor_date,
        last_posted_date=recurring.last_posted_date,
        is_active=recurring.is_active,
        next_due_date=next_due,
        is_due=recurring.is_active and next_due <= today,
        days_until_due=(next_due - today).days,
    )


async def _get_or_404(session: AsyncSession, recurring_id: int, *, lock: bool = False) -> RecurringTransaction:
    statement = select(RecurringTransaction).options(*_EAGER).where(RecurringTransaction.id == recurring_id)
    if lock:
        statement = statement.with_for_update()
    result = await session.execute(statement)
    recurring = result.scalar_one_or_none()
    if recurring is None:
        raise HTTPException(status_code=404, detail="Recurring transaction not found")
    return recurring


async def list_recurring(session: AsyncSession) -> list[RecurringTransactionRead]:
    result = await session.execute(
        select(RecurringTransaction).options(*_EAGER).order_by(RecurringTransaction.id)
    )
    return [_to_read(row) for row in result.scalars().all()]


async def create_recurring(session: AsyncSession, payload: RecurringTransactionCreate) -> RecurringTransactionRead:
    await _ensure_category_matches_type(session, payload.category_id, payload.type)
    await validate_transaction(session, payload.model_dump(), template=True)
    recurring = RecurringTransaction(**payload.model_dump())
    session.add(recurring)
    await session.commit()
    return _to_read(await _get_or_404(session, recurring.id))


async def update_recurring(
    session: AsyncSession, recurring_id: int, payload: RecurringTransactionUpdate
) -> RecurringTransactionRead:
    recurring = await _get_or_404(session, recurring_id)
    updates = payload.model_dump(exclude_unset=True)
    required = ("account_id", "type", "amount", "description", "frequency", "anchor_date", "is_active")
    if any(key in updates and updates[key] is None for key in required):
        raise HTTPException(422, "Required recurring fields cannot be null")
    effective_type = updates.get("type", recurring.type)
    effective_category_id = updates.get("category_id", recurring.category_id)
    await _ensure_category_matches_type(session, effective_category_id, effective_type)
    fields = {column.name: getattr(recurring, column.name) for column in RecurringTransaction.__table__.columns}
    fields.update(updates)
    await validate_transaction(session, fields, template=True)
    for field, value in updates.items():
        setattr(recurring, field, value)
    await session.commit()
    return _to_read(await _get_or_404(session, recurring_id))


async def delete_recurring(session: AsyncSession, recurring_id: int) -> None:
    recurring = await session.get(RecurringTransaction, recurring_id)
    if recurring is None:
        raise HTTPException(status_code=404, detail="Recurring transaction not found")
    await session.delete(recurring)
    await session.commit()


async def post_recurring(session: AsyncSession, recurring_id: int, payload: RecurringPost | None = None) -> RecurringTransactionRead:
    """Creates a real Transaction from the template, dated today, and moves
    last_posted_date forward — the only thing that advances the schedule.

    `payload.amount`/`account_id` are the *actual* payment for an expense
    template only (see docs/tasks/recurring-variable-payments.md) — they
    never change the template's own stored amount/account. `model_fields_set`
    (not a plain `is None` check) distinguishes "field omitted" (keep the
    template's value — the old bare-POST contract) from "field explicitly
    null" (a malformed request, rejected outright)."""
    # Serialize competing clicks before checking the committed posting date.
    recurring = await _get_or_404(session, recurring_id, lock=True)
    today = date_.today()
    # Three different reasons a POST can't proceed right now, each its own
    # code (see docs/tasks/recurring-variable-payments.md). Checked in this
    # order deliberately: once `last_posted_date == today`, `_next_due_date`
    # is *always* already past today too (it advances from that same
    # date), so ALREADY_POSTED must be checked before TEMPLATE_NOT_DUE or
    # it would never be reached — exactly the "lost the response to an
    # actually-successful post, retried" case the client most needs to
    # tell apart, since only this one means something new actually
    # happened server-side for it to reconcile.
    if recurring.last_posted_date == today:
        raise HTTPException(409, detail={"code": "ALREADY_POSTED"})
    if not recurring.is_active:
        raise HTTPException(409, detail={"code": "TEMPLATE_INACTIVE"})
    if _next_due_date(recurring) > today:
        raise HTTPException(409, detail={"code": "TEMPLATE_NOT_DUE"})

    fields_set = payload.model_fields_set if payload else set()
    destination_amount = payload.destination_amount if payload else None
    amount_override = payload.amount if payload else None
    account_override = payload.account_id if payload else None

    if recurring.type != TransactionType.EXPENSE:
        # Income/transfer keep today's exact prior behavior — an override
        # sent for either is a rejected request, never a silently dropped one.
        if "amount" in fields_set or "account_id" in fields_set:
            raise HTTPException(422, "amount/account_id overrides are only valid for expense templates")
    else:
        if "amount" in fields_set and amount_override is None:
            raise HTTPException(422, "amount cannot be null")
        if "account_id" in fields_set and account_override is None:
            raise HTTPException(422, "account_id cannot be null")

    fields = {key: getattr(recurring, key) for key in ("account_id", "category_id", "transfer_account_id", "type", "amount", "description", "merchant", "notes")}
    fields.update(date=today, destination_amount=destination_amount)

    if recurring.type == TransactionType.EXPENSE and account_override is not None:
        account = await session.get(Account, account_override)
        if account is None or account.is_archived:
            raise HTTPException(422, "Account not found or unavailable")
        # The actual amount is in whatever account is actually picked — a
        # currency change with no explicit amount would otherwise silently
        # relabel the template's old number under a different currency.
        if account.currency != recurring.account.currency and amount_override is None:
            raise HTTPException(422, "amount is required when posting to a different-currency account")
        fields["account_id"] = account_override
    if recurring.type == TransactionType.EXPENSE and amount_override is not None:
        fields["amount"] = amount_override

    await validate_transaction(session, fields)
    session.add(Transaction(**fields))
    recurring.last_posted_date = today
    await session.commit()
    return _to_read(await _get_or_404(session, recurring_id))
