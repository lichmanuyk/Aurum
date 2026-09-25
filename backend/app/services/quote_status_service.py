"""Read-only freshness information; never fetch quotes or revalue money."""
from datetime import date, datetime, timezone, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select

from app.models.crypto import CryptoHolding, CryptoSyncState
from app.models.fx import FXRate
from app.services.fx_service import FXConverter
from app.models.account import Account
from app.models.asset import Asset
from app.services.settings_service import get_or_create_app_settings

# The Dashboard's compact rate overview always covers exactly these four —
# see docs/tasks/fx-rate-overview.md. NBP publishes USD/EUR daily (table A)
# and BYN/RUB weekly (table B); both are already fetched by the existing
# auto-refresh (see import_plan() in nbp_service.py), so this only reads
# what's already saved.
FX_OVERVIEW_CURRENCIES = ("USD", "EUR", "BYN", "RUB")


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


async def fx_rate_overview(session):
    """'1 USD/EUR/BYN/RUB = ... <primary>' for the Dashboard's compact rate
    card. Only ever reports an NBP-sourced reference rate: a manually
    entered rate for the same pair/date is real for transaction conversion
    (see fx_service.py), but showing it here would present a user-typed
    number as an official quote, which the source explicitly must not do.
    Reads only what's already saved — never calls NBP itself."""
    today = date.today()
    settings = await get_or_create_app_settings(session)
    rates = [r for r in (await session.scalars(select(FXRate))).all() if r.source.startswith("NBP:")]
    lookup = {(r.base_currency, r.quote_currency, r.rate_date): r for r in rates}
    items = []
    for currency in FX_OVERVIEW_CURRENCIES:
        if currency == settings.currency:
            continue
        fx = FXConverter(rates, settings.currency)
        try:
            rate = fx.rate(currency, settings.currency, today)
        except HTTPException:
            items.append(dict(currency=currency, rate=None, rate_date=None, source=None))
            continue
        used = [lookup[(*sorted((a, b)), day)] for a, b, day in fx.used]
        items.append(dict(
            currency=currency,
            rate=str(rate.quantize(Decimal("0.0001"))),
            rate_date=min(r.rate_date for r in used),
            # Every row here is NBP-sourced by construction (filtered above);
            # this only reduces e.g. "NBP:A:187/A/NBP/2026" to "NBP" for display.
            source=" + ".join(sorted({r.source.split(":", 1)[0] for r in used})),
        ))
    return dict(reporting_currency=settings.currency, as_of=today, items=items)
