"""Debt tracking: create/list/edit/delete a Debt, and record/edit/reverse/
delete its repayments — see docs/tasks/debt-tracking.md and models/debt.py.

Every write that moves cash (a new loan's issuance, a repayment, a
reversal) is one atomic commit that inserts/updates exactly one Transaction
row (type debt_in/debt_out) alongside the Debt/DebtRepayment bookkeeping —
same "one atomic operation, no second Transaction, no partial state on
failure" contract as asset_movement_service. Concurrency: creating or
editing a repayment, deleting a debt, and editing a debt's own financial
fields all lock the parent Debt row (`SELECT ... FOR UPDATE`) before
recomputing outstanding/repayment-count, so two requests against the same
debt can never jointly push it negative, and a financial-field edit can
never land after a concurrent first repayment/reversal has already fixed
that debt's currency/amount in place — the second request waits for the
first's commit/rollback and then re-validates against the now-current,
race-free state.
"""
from collections import defaultdict
from datetime import date as date_
from datetime import timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.clock import business_today
from app.core.money import require_ledger_money
from app.models.account import Account
from app.models.debt import Debt, DebtRepayment
from app.models.enums import DebtDirection, DebtRepaymentKind, TransactionType
from app.models.transaction import Transaction
from app.schemas.debt import (
    DebtCreate,
    DebtRead,
    DebtRepaymentCreate,
    DebtRepaymentRead,
    DebtRepaymentReverse,
    DebtRepaymentUpdate,
    DebtUpdate,
    debt_amount_pair_violation,
)

# Fields a debt can only carry while it's still an opening-balance debt
# (issuance_transaction_id is None) with zero repayments — see
# models/debt.py's own docstring and _financial_fields_locked below.
_FINANCIAL_FIELDS = {"direction", "currency", "principal_amount", "start_date"}


def _funding(debt: Debt) -> str:
    return "new_loan" if debt.issuance_transaction_id is not None else "opening_balance"


def _outstanding(debt: Debt, repayments: list[DebtRepayment]) -> Decimal:
    """principal minus every still-active repayment — a reversed
    repayment (one some other row's reverses_repayment_id points at) and
    every `reversal` row itself contribute nothing here: the reversal's
    own effect is exactly "exclude the repayment it undoes", not a second,
    separate addition (see models/debt.py's own docstring on why a
    reversal's amount always mirrors its target instead of being summed
    independently)."""
    reversed_ids = {r.reverses_repayment_id for r in repayments if r.reverses_repayment_id is not None}
    active = sum(
        (r.amount_debt_currency for r in repayments if r.kind == DebtRepaymentKind.REPAYMENT and r.id not in reversed_ids),
        Decimal("0"),
    )
    return debt.principal_amount - active


async def _read_debt(session: AsyncSession, debt: Debt) -> DebtRead:
    repayments = debt.repayments if "repayments" in debt.__dict__ else (
        await session.scalars(select(DebtRepayment).where(DebtRepayment.debt_id == debt.id))
    ).all()
    outstanding = _outstanding(debt, list(repayments))
    account_id = account_name = issuance_amount = issuance_currency = None
    if debt.issuance_transaction_id is not None:
        tx = await session.get(Transaction, debt.issuance_transaction_id, options=[selectinload(Transaction.account)])
        account_id, account_name, issuance_amount, issuance_currency = tx.account_id, tx.account.name, tx.amount, tx.account.currency
    return DebtRead(
        id=debt.id, direction=debt.direction, counterparty=debt.counterparty, currency=debt.currency,
        principal_amount=debt.principal_amount, outstanding_amount=outstanding,
        status="settled" if outstanding <= 0 else "active",
        start_date=debt.start_date, due_date=debt.due_date, note=debt.note, funding=_funding(debt),
        account_id=account_id, account_name=account_name,
        issuance_account_amount=issuance_amount, issuance_account_currency=issuance_currency,
        repayment_count=len(repayments), idempotency_key=debt.idempotency_key,
        created_at=debt.created_at, updated_at=debt.updated_at,
    )


async def get_debt_or_404(session: AsyncSession, debt_id: int) -> Debt:
    debt = await session.get(Debt, debt_id, options=[selectinload(Debt.repayments)])
    if debt is None:
        raise HTTPException(404, "Debt not found")
    return debt


async def read_debt(session: AsyncSession, debt_id: int) -> DebtRead:
    return await _read_debt(session, await get_debt_or_404(session, debt_id))


async def list_debts(
    session: AsyncSession, direction: DebtDirection | None = None, status: str | None = None
) -> list[DebtRead]:
    stmt = select(Debt).options(selectinload(Debt.repayments)).order_by(Debt.start_date.desc(), Debt.id.desc())
    if direction is not None:
        stmt = stmt.where(Debt.direction == direction)
    debts = (await session.scalars(stmt)).all()
    reads = [await _read_debt(session, debt) for debt in debts]
    if status is not None:
        reads = [r for r in reads if r.status == status]
    return reads


def _validate_common(payload_currency: str, start_date: date_, due_date: date_ | None, principal_amount: Decimal) -> None:
    require_ledger_money(principal_amount, payload_currency)
    if start_date > business_today():
        raise HTTPException(422, "start_date cannot be in the future")
    if due_date is not None and due_date < start_date:
        raise HTTPException(422, "due_date cannot be before start_date")


async def _resolve_cash_account(session: AsyncSession, account_id: int) -> Account:
    account = await session.get(Account, account_id)
    if account is None:
        raise HTTPException(422, "Account not found")
    if account.is_archived:
        raise HTTPException(422, "Choose an active (non-archived) account")
    return account


async def create_debt(session: AsyncSession, payload: DebtCreate) -> DebtRead:
    existing = await session.scalar(select(Debt).where(Debt.idempotency_key == payload.idempotency_key))
    if existing is not None:
        result = await _read_debt(session, existing)
        same = (
            result.direction == payload.direction and result.counterparty == payload.counterparty
            and result.currency == payload.currency and result.principal_amount == payload.principal_amount
            and result.start_date == payload.start_date and result.due_date == payload.due_date
            and result.note == payload.note and result.funding == payload.funding
            and result.account_id == payload.account_id
            and (payload.issuance_account_amount is None or result.issuance_account_amount == payload.issuance_account_amount)
        )
        if not same:
            raise HTTPException(409, "Idempotency key already used for a different debt")
        return result

    _validate_common(payload.currency, payload.start_date, payload.due_date, payload.principal_amount)

    issuance_transaction_id = None
    if payload.funding == "new_loan":
        account = await _resolve_cash_account(session, payload.account_id)
        violation = debt_amount_pair_violation(
            debt_currency=payload.currency, account_currency=account.currency,
            debt_amount=payload.principal_amount, account_amount=payload.issuance_account_amount,
        )
        if violation:
            raise HTTPException(422, violation)
        account_amount = payload.issuance_account_amount or payload.principal_amount
        require_ledger_money(account_amount, account.currency)
        # A receivable *issuance* (owed_to_me) is money the user hands out —
        # cash leaves the account. A liability issuance (owed_by_me) is
        # money borrowed in — cash enters. See TransactionType.DEBT_IN/OUT's
        # own docstring: the type only ever encodes this cash direction.
        tx_type = TransactionType.DEBT_OUT if payload.direction == DebtDirection.OWED_TO_ME else TransactionType.DEBT_IN
        transaction = Transaction(
            account_id=account.id, type=tx_type, amount=account_amount,
            description=f"{'Loan to' if payload.direction == DebtDirection.OWED_TO_ME else 'Loan from'} {payload.counterparty}",
            date=payload.start_date,
        )
        session.add(transaction)
        await session.flush()
        issuance_transaction_id = transaction.id

    debt = Debt(
        direction=payload.direction, counterparty=payload.counterparty, currency=payload.currency,
        principal_amount=payload.principal_amount, start_date=payload.start_date, due_date=payload.due_date,
        note=payload.note, issuance_transaction_id=issuance_transaction_id, idempotency_key=payload.idempotency_key,
        # repayments=[] at construction (not assigned afterwards) keeps the
        # collection "loaded" on the object — reassigning it post-commit
        # would otherwise trigger an implicit lazy-load, which async
        # SQLAlchemy can't do outside an explicit await (MissingGreenlet),
        # the same lesson backup_service.py's own restore_backup already
        # applies to Transaction.tags.
        repayments=[],
    )
    session.add(debt)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "A debt conflicts with an existing record") from exc
    return await _read_debt(session, debt)


def _financial_fields_locked(debt: Debt, repayments: list[DebtRepayment]) -> bool:
    """True once a debt has been "used" — a new loan (cash already moved)
    or any repayment recorded — see models/debt.py's own docstring and
    update_debt/delete_debt below, the two places this actually gates.
    Takes the repayment list explicitly (rather than reading
    `debt.repayments`) so callers are forced to supply a snapshot taken
    under the same row lock the decision is made from — see update_debt."""
    return debt.issuance_transaction_id is not None or len(repayments) > 0


async def update_debt(session: AsyncSession, debt_id: int, payload: DebtUpdate) -> DebtRead:
    # Locked for the same reason create_repayment/delete_debt already are:
    # without this, a concurrent first repayment (or reversal, or delete)
    # could commit between an unlocked read here and this function's own
    # UPDATE, so a currency/principal_amount edit that looked safe (zero
    # repayments at read time) could land *after* a repayment now exists in
    # the old currency/amount — silently breaking "immutable once used"
    # (docs/tasks/debt-tracking.md invariant 6) with a cross-currency
    # `_outstanding` subtraction as the visible symptom. Locking here also
    # means a concurrent delete_debt that wins the race simply makes this
    # function see "no such row" (a clean 404) instead of updating 0 rows
    # and then failing the post-commit `session.refresh` with an
    # unhandled ORM error.
    debt, repayments = await _lock_debt_and_repayments(session, debt_id)
    updates = payload.model_dump(exclude_unset=True)
    if _FINANCIAL_FIELDS & updates.keys() and _financial_fields_locked(debt, repayments):
        if debt.issuance_transaction_id is not None:
            raise HTTPException(409, "A new loan's terms are fixed at creation; delete and recreate it instead")
        raise HTTPException(409, "Delete every repayment first, or delete and recreate this debt")
    effective_currency = updates.get("currency", debt.currency)
    effective_principal = updates.get("principal_amount", debt.principal_amount)
    effective_start = updates.get("start_date", debt.start_date)
    effective_due = updates.get("due_date", debt.due_date)
    _validate_common(effective_currency, effective_start, effective_due, effective_principal)
    for field, value in updates.items():
        setattr(debt, field, value)
    await session.commit()
    # updated_at has onupdate=func.now() (TimestampMixin) — its post-UPDATE
    # server-computed value isn't automatically re-fetched onto the object
    # the way an INSERT's server_default is, so reading it below (via
    # DebtRead) outside an explicit refresh would otherwise lazy-load
    # outside this coroutine's greenlet context (MissingGreenlet) — same
    # "refresh after commit" step account_service.update_account already
    # takes for the same TimestampMixin reason.
    await session.refresh(debt)
    return await _read_debt(session, debt)


async def delete_debt(session: AsyncSession, debt_id: int) -> None:
    # Locked (SELECT ... FOR UPDATE) for the same reason every repayment
    # write is: a repayment created concurrently, between the read below
    # and the actual DELETE, must be serialized into a clean 409 instead of
    # racing into an unhandled IntegrityError (the FK RESTRICT still blocks
    # it either way — this only changes which error the caller sees).
    debt, repayments = await _lock_debt_and_repayments(session, debt_id)
    if repayments:
        raise HTTPException(409, "Delete every repayment first")
    issuance_transaction_id = debt.issuance_transaction_id
    try:
        await session.delete(debt)
        await session.flush()
        if issuance_transaction_id is not None:
            transaction = await session.get(Transaction, issuance_transaction_id)
            if transaction is not None:
                await session.delete(transaction)
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "Delete every repayment first") from exc


# ---------------------------------------------------------------------------
# Repayments
# ---------------------------------------------------------------------------


async def _read_repayment(session: AsyncSession, repayment: DebtRepayment) -> DebtRepaymentRead:
    tx = await session.get(Transaction, repayment.transaction_id, options=[selectinload(Transaction.account)])
    is_reversed = bool(await session.scalar(
        select(DebtRepayment.id).where(DebtRepayment.reverses_repayment_id == repayment.id).limit(1)
    ))
    return DebtRepaymentRead(
        id=repayment.id, debt_id=repayment.debt_id, kind=repayment.kind,
        reverses_repayment_id=repayment.reverses_repayment_id, amount_debt_currency=repayment.amount_debt_currency,
        account_id=tx.account_id, account_name=tx.account.name, account_currency=tx.account.currency,
        account_amount=tx.amount, date=tx.date, note=repayment.note, idempotency_key=repayment.idempotency_key,
        is_reversed=is_reversed,
    )


async def list_repayments(session: AsyncSession, debt_id: int) -> list[DebtRepaymentRead]:
    await get_debt_or_404(session, debt_id)
    rows = (await session.scalars(
        select(DebtRepayment).where(DebtRepayment.debt_id == debt_id).order_by(DebtRepayment.id)
    )).all()
    reads = [await _read_repayment(session, row) for row in rows]
    # Newest first for display, sorted by the real cash date (not id — a
    # metadata edit never changes id order but can change the date).
    reads.sort(key=lambda r: (r.date, r.id), reverse=True)
    return reads


async def _lock_debt_and_repayments(session: AsyncSession, debt_id: int) -> tuple[Debt, list[DebtRepayment]]:
    """Locks the Debt row for the duration of this transaction — every
    concurrent repayment create/edit/delete and debt update/delete against
    the same debt serializes here, so two requests can never both read the
    same "outstanding"/"repayment_count" figure and jointly overpay or
    defeat the "immutable once used" invariant (see this module's own
    docstring)."""
    debt = await session.scalar(select(Debt).where(Debt.id == debt_id).with_for_update())
    if debt is None:
        raise HTTPException(404, "Debt not found")
    repayments = (await session.scalars(select(DebtRepayment).where(DebtRepayment.debt_id == debt_id))).all()
    return debt, list(repayments)


def _resolve_account_amount(debt_currency: str, account_currency: str, debt_amount: Decimal, account_amount: Decimal | None) -> Decimal:
    violation = debt_amount_pair_violation(
        debt_currency=debt_currency, account_currency=account_currency, debt_amount=debt_amount, account_amount=account_amount,
    )
    if violation:
        raise HTTPException(422, violation)
    return account_amount if account_amount is not None else debt_amount


def _debt_cash_type(direction: DebtDirection, kind: DebtRepaymentKind) -> TransactionType:
    """A `repayment` on a receivable (owed_to_me) is money coming back —
    cash enters the account. A `repayment` on a liability (owed_by_me) is
    money going out. A `reversal` always flips that — see
    DebtRepaymentKind's own docstring: undoing a repayment moves cash the
    opposite way the original repayment did."""
    receivable_repayment_is_inflow = direction == DebtDirection.OWED_TO_ME
    is_inflow = receivable_repayment_is_inflow if kind == DebtRepaymentKind.REPAYMENT else not receivable_repayment_is_inflow
    return TransactionType.DEBT_IN if is_inflow else TransactionType.DEBT_OUT


async def create_repayment(session: AsyncSession, debt_id: int, payload: DebtRepaymentCreate) -> DebtRepaymentRead:
    existing = await session.scalar(select(DebtRepayment).where(DebtRepayment.idempotency_key == payload.idempotency_key))
    if existing is not None:
        result = await _read_repayment(session, existing)
        same = (
            existing.debt_id == debt_id and result.amount_debt_currency == payload.amount_debt_currency
            and result.account_id == payload.account_id and result.date == payload.date and result.note == payload.note
            and (payload.account_amount is None or result.account_amount == payload.account_amount)
        )
        if not same:
            raise HTTPException(409, "Idempotency key already used for a different repayment")
        return result

    debt, repayments = await _lock_debt_and_repayments(session, debt_id)
    account = await _resolve_cash_account(session, payload.account_id)
    account_amount = _resolve_account_amount(debt.currency, account.currency, payload.amount_debt_currency, payload.account_amount)
    require_ledger_money(account_amount, account.currency)
    if payload.date < debt.start_date:
        raise HTTPException(422, "A repayment cannot be dated before the debt started")
    if payload.date > business_today():
        raise HTTPException(422, "A repayment cannot be dated in the future")
    outstanding = _outstanding(debt, repayments)
    if payload.amount_debt_currency > outstanding:
        raise HTTPException(422, f"Repayment ({payload.amount_debt_currency}) exceeds outstanding balance ({outstanding})")

    tx_type = _debt_cash_type(debt.direction, DebtRepaymentKind.REPAYMENT)
    transaction = Transaction(
        account_id=account.id, type=tx_type, amount=account_amount,
        description=f"Repayment: {debt.counterparty}", date=payload.date, notes=payload.note,
    )
    session.add(transaction)
    await session.flush()
    repayment = DebtRepayment(
        debt_id=debt.id, transaction_id=transaction.id, kind=DebtRepaymentKind.REPAYMENT,
        amount_debt_currency=payload.amount_debt_currency, note=payload.note, idempotency_key=payload.idempotency_key,
    )
    session.add(repayment)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "A repayment conflicts with an existing record") from exc
    return await _read_repayment(session, repayment)


async def _get_repayment_or_404(session: AsyncSession, debt_id: int, repayment_id: int) -> DebtRepayment:
    repayment = await session.get(DebtRepayment, repayment_id)
    if repayment is None or repayment.debt_id != debt_id:
        raise HTTPException(404, "Repayment not found")
    return repayment


async def update_repayment(
    session: AsyncSession, debt_id: int, repayment_id: int, payload: DebtRepaymentUpdate
) -> DebtRepaymentRead:
    """Only `note` is ever editable here — a repayment/reversal's own
    financial facts (account/date/amount) are immutable once recorded, for
    both kinds, regardless of reversed state. This is deliberately simpler
    than a partial "recompute outstanding excluding this row" edit path:
    that shape reads correctly for an active REPAYMENT row but is
    meaningless for a REVERSAL (removing a reversal from the outstanding
    calculation "revives" the repayment it undoes, which has nothing to do
    with a note-only edit — see docs/tasks/debt-tracking.md's own account
    of this exact bug). The supported correction path for a genuine
    mistake is explicit and auditable instead: delete this row (if nothing
    reverses it) and record a fresh one, or reverse it (see
    reverse_repayment) and record the corrected repayment separately.
    """
    updates = payload.model_dump(exclude_unset=True)
    if {"account_id", "date", "amount_debt_currency", "account_amount"} & updates.keys():
        raise HTTPException(
            409,
            "A repayment/reversal's amount, account and date are immutable; "
            "delete it (if nothing reverses it) or reverse it, then record a new one",
        )

    repayment = await _get_repayment_or_404(session, debt_id, repayment_id)
    if "note" in updates:
        # Eager-loads .account — the identity map returns this exact same
        # object (not a fresh query) to _read_repayment's own session.get()
        # below, so an option supplied only there would arrive too late:
        # the object would already be cached without it, and reading
        # tx.account.name/.currency would lazy-load outside this
        # coroutine's greenlet context (MissingGreenlet).
        transaction = await session.get(
            Transaction, repayment.transaction_id, options=[selectinload(Transaction.account)]
        )
        repayment.note = updates["note"]
        transaction.notes = updates["note"]
        await session.commit()
    return await _read_repayment(session, repayment)


async def delete_repayment(session: AsyncSession, debt_id: int, repayment_id: int) -> None:
    # Locked the same way every other repayment write is — a REVERSAL row's
    # deletion "revives" the repayment it undid (see _outstanding's own
    # reversed_ids exclusion), which can only be safely validated against a
    # current, race-free snapshot of every other repayment on this debt.
    debt, repayments = await _lock_debt_and_repayments(session, debt_id)
    repayment = await _get_repayment_or_404(session, debt_id, repayment_id)
    if repayment.kind == DebtRepaymentKind.REVERSAL:
        # Outstanding as it would be with this reversal gone — i.e. with
        # the repayment it undid counted as active again (see
        # _outstanding's own reversed_ids logic, which only ever excludes a
        # repayment while a still-*existing* reversal points at it). If
        # other repayments were created while this reversal was in effect
        # (using the very room it opened up), reviving the original here
        # would drive the debt negative — reject instead of silently
        # overpaying it.
        outstanding_without_this = _outstanding(debt, [r for r in repayments if r.id != repayment.id])
        if outstanding_without_this < 0:
            raise HTTPException(
                422,
                "Deleting this reversal would overpay the debt — delete the newer repayment(s) it enabled first",
            )
    transaction_id = repayment.transaction_id
    try:
        await session.delete(repayment)
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "Delete the reversal that points at this repayment first") from exc
    transaction = await session.get(Transaction, transaction_id)
    if transaction is not None:
        await session.delete(transaction)
    await session.commit()


async def reverse_repayment(
    session: AsyncSession, debt_id: int, repayment_id: int, payload: DebtRepaymentReverse
) -> DebtRepaymentRead:
    existing = await session.scalar(select(DebtRepayment).where(DebtRepayment.idempotency_key == payload.idempotency_key))
    if existing is not None:
        result = await _read_repayment(session, existing)
        same = (
            existing.debt_id == debt_id and existing.reverses_repayment_id == repayment_id
            and result.account_id == payload.account_id and result.date == payload.date and result.note == payload.note
            and (payload.account_amount is None or result.account_amount == payload.account_amount)
        )
        if not same:
            raise HTTPException(409, "Idempotency key already used for a different reversal")
        return result

    debt, repayments = await _lock_debt_and_repayments(session, debt_id)
    original = await _get_repayment_or_404(session, debt_id, repayment_id)
    if original.kind != DebtRepaymentKind.REPAYMENT:
        raise HTTPException(422, "Only a repayment can be reversed, not another reversal")
    if await session.scalar(select(DebtRepayment.id).where(DebtRepayment.reverses_repayment_id == original.id).limit(1)):
        raise HTTPException(409, "This repayment already has a reversal")
    original_tx = await session.get(Transaction, original.transaction_id)
    if payload.date < original_tx.date:
        raise HTTPException(422, "A reversal cannot be dated before the repayment it undoes")
    if payload.date > business_today():
        raise HTTPException(422, "A reversal cannot be dated in the future")

    account = await _resolve_cash_account(session, payload.account_id)
    account_amount = _resolve_account_amount(debt.currency, account.currency, original.amount_debt_currency, payload.account_amount)
    require_ledger_money(account_amount, account.currency)

    tx_type = _debt_cash_type(debt.direction, DebtRepaymentKind.REVERSAL)
    transaction = Transaction(
        account_id=account.id, type=tx_type, amount=account_amount,
        description=f"Reversal of repayment: {debt.counterparty}", date=payload.date, notes=payload.note,
    )
    session.add(transaction)
    await session.flush()
    reversal = DebtRepayment(
        debt_id=debt.id, transaction_id=transaction.id, kind=DebtRepaymentKind.REVERSAL,
        reverses_repayment_id=original.id, amount_debt_currency=original.amount_debt_currency,
        note=payload.note, idempotency_key=payload.idempotency_key,
    )
    session.add(reversal)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "A reversal conflicts with an existing record") from exc
    return await _read_repayment(session, reversal)


# ---------------------------------------------------------------------------
# Net worth integration — see services/net_worth_service.py
# ---------------------------------------------------------------------------


async def net_worth_contribution(session: AsyncSession, fx, start: date_, end: date_):
    """Day-by-day receivable/liability totals (already FX-converted into
    `fx.currency`) for [start, end] inclusive, forward-filled from each
    Debt's own start_date/principal and its repayment/reversal history —
    the same "point events, forward-filled, converted per day" shape
    valuation_service.stock_series uses for assets, kept as its own
    function so this never has to widen that one's asset/crypto-focused
    contract (see net_worth_service.py's own docstring on Cash/assets each
    staying a single source of truth). Returns
    (points, today_receivable, today_liability) where points is a list of
    (date, receivable_value, liability_value) tuples, one per day.
    A missing historical FX rate raises the same explicit 409
    (FX_RATE_MISSING) fx.convert always raises — never a fabricated 0/1:1.
    """
    debts = (await session.scalars(select(Debt))).all()
    if not debts:
        points = []
        day = start
        while day <= end:
            points.append((day, Decimal(0), Decimal(0)))
            day += timedelta(days=1)
        return points, Decimal(0), Decimal(0)

    repayments = (await session.scalars(
        select(DebtRepayment).options(selectinload(DebtRepayment.transaction))
    )).all()
    by_debt: dict[int, list[DebtRepayment]] = defaultdict(list)
    for r in repayments:
        by_debt[r.debt_id].append(r)

    series_by_debt: dict[int, list[tuple[date_, Decimal]]] = {}
    for debt in debts:
        rows = sorted(by_debt.get(debt.id, []), key=lambda r: (r.transaction.date, r.id))
        outstanding = debt.principal_amount
        series: list[tuple[date_, Decimal]] = [(debt.start_date, outstanding)]
        for r in rows:
            outstanding = outstanding - r.amount_debt_currency if r.kind == DebtRepaymentKind.REPAYMENT else outstanding + r.amount_debt_currency
            series.append((r.transaction.date, outstanding))
        series_by_debt[debt.id] = series

    idx = {debt.id: 0 for debt in debts}
    current_native = {debt.id: Decimal(0) for debt in debts}
    points = []
    day = start
    while day <= end:
        for debt in debts:
            series = series_by_debt[debt.id]
            i = idx[debt.id]
            while i < len(series) and series[i][0] <= day:
                current_native[debt.id] = series[i][1]
                i += 1
            idx[debt.id] = i
        receivable = sum(
            (fx.convert(current_native[d.id], d.currency, day) for d in debts if d.direction == DebtDirection.OWED_TO_ME),
            Decimal(0),
        )
        liability = sum(
            (fx.convert(current_native[d.id], d.currency, day) for d in debts if d.direction == DebtDirection.OWED_BY_ME),
            Decimal(0),
        )
        points.append((day, receivable, liability))
        day += timedelta(days=1)
    today_receivable, today_liability = points[-1][1], points[-1][2]
    return points, today_receivable, today_liability


async def earliest_debt_start_date(session: AsyncSession) -> date_ | None:
    """Cheap column-only lookup — see net_worth_service.get_net_worth_summary's
    own "all time" window, which must reach back to a debt's own start_date
    even when no cash/asset activity does."""
    return await session.scalar(select(Debt.start_date).order_by(Debt.start_date).limit(1))
