"""Atomic transfers between a cash account and a tracked asset."""
from datetime import date
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.money import require_ledger_money, require_money
from app.models.account import Account
from app.models.asset import Asset, AssetValuation
from app.models.crypto import CryptoTransaction
from app.models.enums import AssetClass, CryptoTransactionType, TransactionType
from app.models.transaction import Transaction
from app.schemas.asset_movement import AssetMovementInput, AssetMovementRead
from app.services import crypto_service
from app.services.net_worth_service import CASH_ACCOUNT_TYPES


def _kind(transaction: Transaction) -> str:
    return "buy" if transaction.type == TransactionType.ASSET_BUY else "sell"


async def _read(session: AsyncSession, transaction: Transaction) -> AssetMovementRead:
    asset = await session.get(Asset, transaction.asset_id)
    account = await session.get(Account, transaction.account_id)
    crypto = await session.get(CryptoTransaction, transaction.crypto_transaction_id) if transaction.crypto_transaction_id else None
    valuation = await session.get(AssetValuation, transaction.asset_valuation_id) if transaction.asset_valuation_id else None
    return AssetMovementRead(
        id=transaction.id, asset_id=asset.id, asset_name=asset.name,
        account_id=account.id, account_name=account.name, account_currency=account.currency,
        asset_currency=asset.currency, type=_kind(transaction), gross_amount=transaction.gross_amount,
        fee_amount=transaction.fee_amount, cash_amount=transaction.amount,
        asset_value_after=valuation.value if valuation else None,
        quantity=crypto.quantity if crypto else None, price_per_unit=crypto.price_per_unit if crypto else None,
        date=transaction.date, note=transaction.notes, idempotency_key=transaction.idempotency_key,
    )


async def list_movements(session: AsyncSession, asset_id: int | None = None) -> list[AssetMovementRead]:
    stmt = select(Transaction).where(Transaction.type.in_((TransactionType.ASSET_BUY, TransactionType.ASSET_SELL)))
    if asset_id is not None:
        stmt = stmt.where(Transaction.asset_id == asset_id)
    rows = (await session.scalars(stmt.order_by(Transaction.date.desc(), Transaction.id.desc()))).all()
    return [await _read(session, row) for row in rows]


async def _validate(session: AsyncSession, payload: AssetMovementInput):
    account = await session.get(Account, payload.account_id)
    asset = await session.get(Asset, payload.asset_id)
    if account is None or asset is None:
        raise HTTPException(422, "Account or asset not found")
    if account.type not in CASH_ACCOUNT_TYPES:
        raise HTTPException(422, "Choose a cash account counted in net worth")
    require_ledger_money(payload.gross_amount, account.currency)
    require_ledger_money(payload.fee_amount, account.currency)
    cash_amount = payload.gross_amount + payload.fee_amount if payload.type == "buy" else payload.gross_amount - payload.fee_amount
    require_ledger_money(cash_amount, account.currency)
    if asset.asset_class == AssetClass.CRYPTO:
        if payload.asset_value_after is not None or payload.quantity is None or payload.price_per_unit is None:
            raise HTTPException(422, "Crypto trades require quantity and unit price, not a manual valuation")
        if payload.date != date.today():
            raise HTTPException(422, "Cash-linked crypto trades currently require today's date")
    elif payload.asset_value_after is None or payload.quantity is not None or payload.price_per_unit is not None:
        raise HTTPException(422, "Manual assets require a value after the trade, without crypto quantity")
    else:
        require_money(payload.asset_value_after, asset.currency)
    return account, asset, cash_amount


async def _manual_valuation(session: AsyncSession, asset: Asset, payload: AssetMovementInput, transaction: Transaction):
    await session.scalar(select(Asset.id).where(Asset.id == asset.id).with_for_update())
    valuation = await session.scalar(select(AssetValuation).where(
        AssetValuation.asset_id == asset.id, AssetValuation.as_of_date == payload.date
    ).order_by(AssetValuation.id.desc()).limit(1))
    if valuation:
        linked = await session.scalar(select(Transaction.id).where(Transaction.asset_valuation_id == valuation.id))
        if linked and linked != transaction.id:
            valuation = None
        else:
            transaction.prior_asset_value = valuation.value
            valuation.value = payload.asset_value_after
    if valuation is None:
        transaction.prior_asset_value = None
        valuation = AssetValuation(asset_id=asset.id, value=payload.asset_value_after, as_of_date=payload.date)
        session.add(valuation)
        await session.flush()
    transaction.asset_valuation_id = valuation.id


async def _crypto_trade(session: AsyncSession, asset: Asset, payload: AssetMovementInput, transaction: Transaction):
    holding = await crypto_service._get_holding_or_404(session, asset.id)
    if holding.last_price is None:
        raise HTTPException(409, "Refresh the coin price before recording a cash-linked trade")
    trade = CryptoTransaction(
        asset_id=asset.id, type=CryptoTransactionType.BUY if payload.type == "buy" else CryptoTransactionType.SELL,
        quantity=payload.quantity, quote_currency=asset.currency, price_per_unit=payload.price_per_unit,
        date=payload.date, note=payload.note,
    )
    holding.transactions.append(trade)
    await session.flush()
    crypto_service._validate_trade_history(holding.transactions)
    transaction.crypto_transaction_id = trade.id
    quantity, _ = crypto_service._compute_position(holding.transactions)
    await crypto_service._upsert_valuation(session, asset.id, quantity * holding.last_price, date.today())


async def create_movement(session: AsyncSession, payload: AssetMovementInput) -> AssetMovementRead:
    existing = await session.scalar(select(Transaction).where(Transaction.idempotency_key == payload.idempotency_key))
    if existing:
        result = await _read(session, existing)
        if result.asset_id != payload.asset_id or result.account_id != payload.account_id or result.type != payload.type or \
           result.gross_amount != payload.gross_amount or result.fee_amount != payload.fee_amount or \
           result.date != payload.date or result.note != payload.note or result.quantity != payload.quantity or \
           result.price_per_unit != payload.price_per_unit or result.asset_value_after != payload.asset_value_after:
            raise HTTPException(409, "Idempotency key already used for a different movement")
        return result
    _, asset, cash_amount = await _validate(session, payload)
    transaction = Transaction(
        account_id=payload.account_id, asset_id=asset.id,
        type=TransactionType.ASSET_BUY if payload.type == "buy" else TransactionType.ASSET_SELL,
        amount=cash_amount, gross_amount=payload.gross_amount, fee_amount=payload.fee_amount,
        description=f"{'Purchase' if payload.type == 'buy' else 'Sale'}: {asset.name}",
        notes=payload.note, date=payload.date, idempotency_key=payload.idempotency_key,
    )
    session.add(transaction)
    try:
        await session.flush()
        if asset.asset_class == AssetClass.CRYPTO:
            await _crypto_trade(session, asset, payload, transaction)
        else:
            await _manual_valuation(session, asset, payload, transaction)
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(409, "An asset movement conflicts with an existing record") from exc
    return await _read(session, transaction)


async def update_movement(session: AsyncSession, movement_id: int, payload: AssetMovementInput) -> AssetMovementRead:
    transaction = await session.get(Transaction, movement_id)
    if transaction is None or transaction.type not in (TransactionType.ASSET_BUY, TransactionType.ASSET_SELL):
        raise HTTPException(404, "Asset movement not found")
    if (payload.asset_id, payload.type, payload.date, payload.idempotency_key) != (
        transaction.asset_id, _kind(transaction), transaction.date, transaction.idempotency_key
    ):
        raise HTTPException(409, "Asset, direction, date and idempotency key cannot change; delete and recreate")
    _, asset, cash_amount = await _validate(session, payload)
    transaction.account_id = payload.account_id
    transaction.amount = cash_amount
    transaction.gross_amount = payload.gross_amount
    transaction.fee_amount = payload.fee_amount
    transaction.notes = payload.note
    if transaction.crypto_transaction_id is not None:
        holding = await crypto_service._get_holding_or_404(session, asset.id)
        trade = await session.get(CryptoTransaction, transaction.crypto_transaction_id)
        trade.quantity = payload.quantity
        trade.price_per_unit = payload.price_per_unit
        trade.note = payload.note
        crypto_service._validate_trade_history(holding.transactions)
        await session.flush()
        quantity, _ = crypto_service._compute_position(holding.transactions)
        await crypto_service._upsert_valuation(session, asset.id, quantity * holding.last_price, date.today())
    else:
        valuation = await session.get(AssetValuation, transaction.asset_valuation_id)
        valuation.value = payload.asset_value_after
    await session.commit()
    return await _read(session, transaction)


async def delete_movement(session: AsyncSession, movement_id: int) -> None:
    transaction = await session.get(Transaction, movement_id)
    if transaction is None or transaction.type not in (TransactionType.ASSET_BUY, TransactionType.ASSET_SELL):
        raise HTTPException(404, "Asset movement not found")
    crypto_id, valuation_id = transaction.crypto_transaction_id, transaction.asset_valuation_id
    asset_id = transaction.asset_id
    prior = transaction.prior_asset_value
    if valuation_id is not None and await session.scalar(select(AssetValuation.id).where(
        AssetValuation.asset_id == asset_id,
        or_(AssetValuation.as_of_date > transaction.date,
            (AssetValuation.as_of_date == transaction.date) & (AssetValuation.id > valuation_id)),
    ).limit(1)):
        raise HTTPException(409, "Remove later valuations before deleting this movement")
    await session.delete(transaction)
    await session.flush()
    if crypto_id is not None:
        holding = await crypto_service._get_holding_or_404(session, asset_id)
        remaining = [trade for trade in holding.transactions if trade.id != crypto_id]
        crypto_service._validate_trade_history(remaining)
        trade = await session.get(CryptoTransaction, crypto_id)
        await session.delete(trade)
        await session.flush()
        quantity, _ = crypto_service._compute_position(remaining)
        if holding.last_price is not None:
            await crypto_service._upsert_valuation(session, asset_id, quantity * holding.last_price, date.today())
    elif valuation_id is not None:
        valuation = await session.get(AssetValuation, valuation_id)
        if prior is None:
            await session.delete(valuation)
        else:
            valuation.value = prior
    await session.commit()
