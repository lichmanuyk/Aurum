"""Official NBP reference rates. Network writes are explicit and interval-atomic."""
import asyncio
import json
from datetime import date, timedelta
from decimal import Decimal, localcontext

import httpx
from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert
from app.models.fx import FXRate
from app.models.account import Account
from app.models.asset import Asset, AssetValuation
from app.models.transaction import Transaction
from app.models.crypto import CryptoTransaction
from app.models.budget import Budget
from app.models.goal import Goal
from app.services.settings_service import get_or_create_app_settings
from app.services.fx_service import FXConverter

NBP_URL = 'https://api.nbp.pl/api/exchangerates/tables'
# A is published on business days, B weekly. Codes outside A are requested
# from B and reported as absent if NBP did not publish them in that interval.
TABLE_A = set('THB USD AUD HKD CAD NZD SGD EUR HUF CHF GBP UAH JPY CZK DKK ISK NOK SEK HRK RON BGN TRY ILS CLP PHP MXN ZAR BRL MYR IDR INR KRW CNY XDR'.split())


async def import_plan(session):
    settings = await get_or_create_app_settings(session)
    # Include the summary display choices even without native EUR/USD accounts.
    currencies = {settings.currency, settings.idle_cash_threshold_currency, "EUR", "USD"}
    for model, field in [(Account, Account.currency), (Asset, Asset.currency), (Budget, Budget.currency),
                         (Goal, Goal.currency), (Transaction, Transaction.reporting_currency_override),
                         (CryptoTransaction, CryptoTransaction.quote_currency)]:
        currencies.update(c for c in await session.scalars(select(field).distinct()) if c)
    starts = []
    for field in (Transaction.date, AssetValuation.as_of_date, CryptoTransaction.date):
        first = await session.scalar(select(func.min(field)))
        if first:
            starts.append(first)
    start = min(starts, default=date.today())
    return dict(start_date=max(date(2002,1,2), start-timedelta(days=7)), history_start=start,
                end_date=date.today(), currencies=sorted(currencies-{'PLN'}), provider='NBP', chunk_days=93)


def parse_tables(payload, table, currencies, start, end):
    if not isinstance(payload, list):
        raise ValueError('Expected a list of NBP tables')
    rows, seen = [], set()
    for document in payload:
        if document['table'] != table:
            raise ValueError('Unexpected NBP table type')
        day = date.fromisoformat(document['effectiveDate'])
        if not start <= day <= end:
            raise ValueError('NBP date outside requested range')
        source = f"NBP:{table}:{document['no']}"
        if len(source) > 50:
            raise ValueError('Unexpected NBP table identifier')
        for quote in document['rates']:
            code = quote['code']
            if code not in currencies:
                continue
            # NBP JSON mid is PLN per ONE unit (including IDR and JPY), unlike
            # some NBP display tables that label blocks of 100/10000 units.
            rate = Decimal(str(quote['mid']))
            if not rate.is_finite() or rate <= 0:
                raise ValueError('Invalid NBP quotation')
            base, target = sorted((code, 'PLN'))
            with localcontext() as context:
                context.prec = 80
                normalized = (rate if base == code else 1/rate).quantize(Decimal('1e-18'))
            if normalized <= 0 or normalized >= Decimal('1e20') or (base,target,day) in seen:
                raise ValueError('Invalid or duplicate NBP quotation')
            seen.add((base,target,day))
            rows.append(dict(base_currency=base,quote_currency=target,rate_date=day,rate=normalized,source=source))
    return rows


async def fetch_rates(currencies, start, end):
    async def fetch(client, table, codes):
        if not codes:
            return []
        url = f'{NBP_URL}/{table}/{start}/{end}/?format=json'
        for attempt in range(3):
            try:
                response = await client.get(url)
                if response.status_code == 404:
                    return []  # no publication on weekends/holidays, not a zero rate
                if response.status_code == 429 or response.status_code >= 500:
                    if attempt < 2:
                        await asyncio.sleep(0.5 * (attempt+1))
                        continue
                response.raise_for_status()
                return parse_tables(json.loads(response.text, parse_float=Decimal), table, codes, start, end)
            except httpx.TransportError:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.5 * (attempt+1))
        raise ValueError('NBP retry limit exceeded')
    try:
        async with httpx.AsyncClient(timeout=25, headers={'Accept':'application/json'}) as client:
            a,b = await asyncio.gather(fetch(client,'A',set(currencies)&TABLE_A),
                                       fetch(client,'B',set(currencies)-TABLE_A-{'PLN'}))
        return a+b
    except (httpx.HTTPError, ValueError, KeyError, TypeError, ArithmeticError) as exc:
        raise HTTPException(502, 'NBP rates unavailable or invalid; this interval was not saved. Retry later.') from exc


async def import_rates(session, payload):
    rows = await fetch_rates(payload.currencies, payload.start_date, payload.end_date)
    saved = 0
    for offset in range(0,len(rows),500):
        stmt = insert(FXRate).values(rows[offset:offset+500])
        result = await session.scalars(stmt.on_conflict_do_update(constraint='uq_fx_pair_date',
            set_={'rate':stmt.excluded.rate,'source':stmt.excluded.source,'updated_at':func.now()},
            where=FXRate.source.like('NBP:%')).returning(FXRate.id))
        saved += len(result.all())
    await session.commit()
    session.info.pop('fx_converter',None)
    found = {r['base_currency'] if r['quote_currency']=='PLN' else r['quote_currency'] for r in rows}
    return dict(downloaded=len(rows),saved=saved,protected=len(rows)-saved,
                absent_currencies=sorted(set(payload.currencies)-found-{'PLN'}))


async def coverage(session):
    plan = await import_plan(session)
    fx = await FXConverter.load(session)
    items = []
    for currency in sorted(set(plan['currencies'])|{'PLN'}):
        if currency == fx.currency:
            continue
        missing = []
        day = plan['history_start']
        while day <= plan['end_date']:
            try:
                fx.rate(currency, fx.currency, day)
            except HTTPException as exc:
                if exc.status_code != 409:
                    raise
                if missing and missing[-1]['end_date']+timedelta(days=1)==day:
                    missing[-1]['end_date']=day
                else:
                    missing.append(dict(start_date=day,end_date=day))
            day += timedelta(days=1)
        items.append(dict(currency=currency,missing_ranges=missing,
                          missing_days=sum((m['end_date']-m['start_date']).days+1 for m in missing)))
    return dict(start_date=plan['history_start'],end_date=plan['end_date'],reporting_currency=fx.currency,
                complete=not any(i['missing_days'] for i in items),items=items)
