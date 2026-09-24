"""Value native positions on each reporting date, including FX-only changes."""
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal
from sqlalchemy import select
from app.models.account import Account
from app.models.asset import Asset, AssetValuation
from app.models.transaction import Transaction
from app.services.money_service import native_legs
from app.services.fx_service import FXConverter


async def stock_series(session, start, end, *, account_types=None, asset_ids=None):
    fx = await FXConverter.load(session)
    accounts = {a.id: a for a in (await session.scalars(select(Account))).all() if account_types and a.type in account_types}
    assets = {a.id: a for a in (await session.scalars(select(Asset))).all() if asset_ids is None or a.id in asset_ids}
    events = []
    if accounts:
        for tx in (await session.scalars(select(Transaction).where(Transaction.date <= end))).all():
            if tx.account_id in accounts or tx.transfer_account_id in accounts:
                for account_id, amount in native_legs(tx):
                    if account_id in accounts:
                        events.append((tx.date, "cash", account_id, amount))
    for v in (await session.scalars(select(AssetValuation).where(AssetValuation.as_of_date <= end))).all():
        if v.asset_id in assets:
            events.append((v.as_of_date, "asset", v.asset_id, v.value))
    events.sort(key=lambda row: row[0])
    start = start or (events[0][0] if events else end)
    balances, values, points = defaultdict(Decimal), {}, []
    index, day = 0, start
    converted_assets, cash = {}, Decimal(0)
    while day <= end:
        while index < len(events) and events[index][0] <= day:
            _, kind, key, value = events[index]
            if kind == "cash":
                balances[key] += value
            else:
                values[key] = value
            index += 1
        cash = sum((fx.convert(value, accounts[key].currency, day) for key, value in balances.items()), Decimal(0))
        converted_assets = {key: fx.convert(value, assets[key].currency, day) for key, value in values.items()}
        points.append((day, cash + sum(converted_assets.values(), Decimal(0))))
        day += timedelta(days=1)
    return points, cash, converted_assets, assets, fx
