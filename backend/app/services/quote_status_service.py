"""Read-only freshness information; never fetch quotes or revalue money."""
from datetime import date, datetime, timezone, timedelta

from fastapi import HTTPException
from sqlalchemy import select

from app.models.crypto import CryptoHolding, CryptoSyncState
from app.models.fx import FXRate
from app.services.fx_service import FXConverter
from app.models.account import Account
from app.models.asset import Asset
from app.services.settings_service import get_or_create_app_settings


async def quote_status(session):
    today = date.today()
    settings = await get_or_create_app_settings(session)
    currencies = set(await session.scalars(select(Account.currency).where(Account.is_archived.is_(False))))
    currencies.update(await session.scalars(select(Asset.currency)))
    rates = (await session.scalars(select(FXRate))).all()
    lookup = {(r.base_currency, r.quote_currency, r.rate_date): r for r in rates}
    items = []
    for currency in sorted(currencies):
        if currency == settings.currency:
            continue
        fx = FXConverter(rates, settings.currency)
        try:
            fx.rate(currency, settings.currency, today)
        except HTTPException:
            items.append(dict(currency=currency, status='missing', rate_date=None, saved_at=None, sources=[]))
            continue
        used = [lookup[(*sorted((a, b)), day)] for a, b, day in fx.used]
        day = min(r.rate_date for r in used)
        items.append(dict(currency=currency, status='current' if day == today else 'previous',
                          rate_date=day, saved_at=max(r.updated_at for r in used),
                          sources=sorted({r.source for r in used})))
    holdings = (await session.scalars(select(CryptoHolding))).all()
    state = await session.get(CryptoSyncState, 1)
    last = state.last_synced_at if state else None
    missing = sum(h.last_price is None for h in holdings)
    crypto_status = ('empty' if not holdings else 'missing' if missing or last is None else
                     'stale' if datetime.now(timezone.utc) - last >= timedelta(hours=1) else 'current')
    return dict(as_of=today, reporting_currency=settings.currency, fx=items,
                crypto=dict(status=crypto_status, last_synced_at=last, missing_prices=missing))
