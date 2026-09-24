"""Account CRUD, plus each account's live balance — summed from its
Transaction rows (income adds, expense subtracts, a transfer moves the
amount from the source account to the destination account) rather than
stored, the same "derive it, don't duplicate it" approach
net_worth_service.py uses for Cash.
"""

from app.services.settings_service import get_or_create_app_settings
from sqlalchemy import or_
from app.models.recurring import RecurringTransaction
from app.services.money_service import native_balances
from collections import defaultdict
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.enums import TransactionType
from app.models.transaction import Transaction
from app.schemas.account import AccountCreate, AccountUpdate, AccountWithBalance


async def _account_balances(session: AsyncSession) -> dict[int, Decimal]:
    return await native_balances(session)


def _to_read(account: Account, balance: Decimal) -> AccountWithBalance:
    return AccountWithBalance(
        id=account.id,
        name=account.name,
        type=account.type,
        currency=account.currency,
        color=account.color,
        is_archived=account.is_archived,
        balance=balance,
    )


async def list_accounts(session: AsyncSession, include_archived: bool) -> list[AccountWithBalance]:
    stmt = select(Account).order_by(Account.name)
    if not include_archived:
        stmt = stmt.where(Account.is_archived.is_(False))
    accounts = (await session.execute(stmt)).scalars().all()
    balances = await _account_balances(session)
    return [_to_read(account, balances.get(account.id, Decimal("0"))) for account in accounts]


async def create_account(session: AsyncSession, payload: AccountCreate) -> AccountWithBalance:
    fields = payload.model_dump()
    if "currency" not in payload.model_fields_set:
        fields["currency"] = (await get_or_create_app_settings(session)).currency
    account = Account(**fields)
    session.add(account)
    await session.commit()
    await session.refresh(account)
    # A brand-new account has no transactions yet — no need to query.
    return _to_read(account, Decimal("0"))


async def update_account(session: AsyncSession, account_id: int, payload: AccountUpdate) -> AccountWithBalance:
    account = await session.get(Account, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Account not found")
    if "currency" in payload.model_fields_set and payload.currency is None:
        raise HTTPException(422, "Currency cannot be null")
    if payload.currency is not None and payload.currency != account.currency:
        if await _has_history(session, account_id):
            raise HTTPException(409, "Currency cannot change after money or recurring templates exist")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(account, field, value)
    await session.commit()
    await session.refresh(account)
    balances = await _account_balances(session)
    return _to_read(account, balances.get(account.id, Decimal("0")))


async def delete_account(session: AsyncSession, account_id: int) -> None:
    account = await session.get(Account, account_id)
    if account is None:
        raise HTTPException(status_code=404, detail="Account not found")
    if await _has_history(session, account_id):
        raise HTTPException(409, "Archive accounts with history instead of deleting them")
    await session.delete(account)
    await session.commit()


async def _has_history(session, account_id):
    for model in (Transaction, RecurringTransaction):
        if await session.scalar(select(model.id).where(or_(model.account_id == account_id, model.transfer_account_id == account_id)).limit(1)):
            return True
    return False
