"""Native ledger legs and common validation for every transaction write path."""
from datetime import date
from decimal import Decimal
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from app.core.money import validate_money, validate_ledger_money, adjustment_rule_violation
from app.models.account import Account
from app.models.transaction import Transaction
from app.models.enums import TransactionType
from app.schemas.transaction import transfer_rule_violation


async def validate_transaction(session, fields, *, template=False):
    account = await session.get(Account, fields["account_id"])
    destination = await session.get(Account, fields["transfer_account_id"]) if fields.get("transfer_account_id") else None
    if account is None or (fields.get("transfer_account_id") and destination is None):
        raise HTTPException(422, "Account not found")
    violation = transfer_rule_violation(type=fields["type"], account_id=account.id,
        transfer_account_id=fields.get("transfer_account_id"), category_id=fields.get("category_id"))
    if violation:
        raise HTTPException(422, violation)
    amount = fields["amount"]
    try:
        violation = adjustment_rule_violation(fields["type"], amount, fields.get("adjustment_reason"), fields.get("category_id"))
        if violation or (template and fields["type"] == TransactionType.ADJUSTMENT):
            raise ValueError(violation or "Adjustments cannot be recurring")
        (validate_money if template else validate_ledger_money)(amount, account.currency)
        if fields["type"] == TransactionType.TRANSFER:
            received = fields.get("destination_amount")
            if account.currency == destination.currency:
                if received is not None and received != amount:
                    raise ValueError("Same-currency transfer amounts must match; record fees separately")
                fields["destination_amount"] = amount
            elif template and received is None:
                return
            elif received is None or received <= 0:
                raise ValueError("destination_amount is required for cross-currency transfers")
            validate_ledger_money(fields["destination_amount"], destination.currency)
        elif fields.get("destination_amount") is not None:
            raise ValueError("destination_amount is only valid for transfers")
        override = [fields.get(k) for k in ("reporting_amount_override", "reporting_currency_override", "reporting_override_source")]
        if any(v is not None for v in override):
            if not all(v is not None for v in override) or fields["type"] not in (TransactionType.INCOME, TransactionType.EXPENSE):
                raise ValueError("Reporting override requires amount, currency and source on income/expense")
            if override[0] <= 0:
                raise ValueError("Reporting override must be positive")
            validate_ledger_money(override[0], override[1])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def native_legs(tx):
    yield tx.account_id, tx.amount if tx.type in (TransactionType.INCOME, TransactionType.ADJUSTMENT) else -tx.amount
    if tx.type == TransactionType.TRANSFER and tx.transfer_account_id is not None:
        if tx.destination_amount is None:
            raise HTTPException(409, detail={"code": "TRANSFER_AMOUNT_UNRESOLVED", "transaction_id": tx.id})
        yield tx.transfer_account_id, tx.destination_amount


async def transactions_for_reporting(session, start=None, end=None, transaction_type=None):
    stmt = select(Transaction).options(selectinload(Transaction.account), selectinload(Transaction.splits)).order_by(Transaction.id)
    if start is not None:
        stmt = stmt.where(Transaction.date >= start)
    if end is not None:
        stmt = stmt.where(Transaction.date <= end)
    if transaction_type is not None:
        stmt = stmt.where(Transaction.type == transaction_type)
    return (await session.scalars(stmt)).all()


async def native_balances(session, as_of=None):
    from collections import defaultdict
    balances = defaultdict(Decimal)
    rows = await session.scalars(select(Transaction).where(Transaction.date <= (as_of or date.today())))
    for tx in rows:
        for account_id, amount in native_legs(tx):
            balances[account_id] += amount
    return balances
