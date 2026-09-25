from decimal import Decimal, localcontext
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, func
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.deps import get_session
from app.models.fx import FXRate
from app.schemas.fx import FXRateBatch, FXRateRead, NBPImport

router = APIRouter(prefix="/fx-rates", tags=["fx"])


@router.get("", response_model=list[FXRateRead])
async def list_rates(session: AsyncSession = Depends(get_session)):
    return (await session.scalars(select(FXRate).order_by(FXRate.rate_date.desc(), FXRate.base_currency))).all()


@router.post("/bulk", response_model=list[FXRateRead])
async def save_rates(payload: FXRateBatch, session: AsyncSession = Depends(get_session)):
    rows, keys = [], set()
    for item in payload.items:
        values = item.model_dump()
        if item.base_currency > item.quote_currency:
            values.update(base_currency=item.quote_currency, quote_currency=item.base_currency)
            with localcontext() as ctx:
                ctx.prec = 80
                values["rate"] = (Decimal(1) / item.rate).quantize(Decimal("1e-18"))
        key = (values["base_currency"], values["quote_currency"], item.rate_date)
        if key in keys or values["rate"] <= 0 or values["rate"] >= Decimal("1e20"):
            raise HTTPException(422, "Duplicate pair/date or rate outside supported precision")
        keys.add(key)
        rows.append(values)
    for row in rows:
        stmt = insert(FXRate).values(**row)
        await session.execute(stmt.on_conflict_do_update(
            constraint="uq_fx_pair_date", set_={"rate": stmt.excluded.rate, "source": stmt.excluded.source, "updated_at": func.now()}))
    await session.commit()
    return await list_rates(session)


@router.get("/preflight")
async def money_preflight(session: AsyncSession = Depends(get_session)):
    from app.models.transaction import Transaction
    from app.models.crypto import CryptoTransaction
    from app.models.enums import TransactionType
    transfers = (await session.scalars(select(Transaction.id).where(
        Transaction.type == TransactionType.TRANSFER, Transaction.destination_amount.is_(None)))).all()
    quotes = (await session.scalars(select(CryptoTransaction.id).where(CryptoTransaction.quote_currency.is_(None)))).all()
    return {"unresolved_transfer_ids": list(transfers), "unresolved_crypto_trade_ids": list(quotes)}


@router.get('/nbp/plan')
async def nbp_plan(session: AsyncSession = Depends(get_session)):
    from app.services.nbp_service import import_plan
    return await import_plan(session)


@router.post('/nbp')
async def load_nbp_rates(payload: NBPImport, session: AsyncSession = Depends(get_session)):
    from app.services.nbp_service import import_rates
    return await import_rates(session, payload)


@router.get('/coverage')
async def fx_coverage(session: AsyncSession = Depends(get_session)):
    from app.services.nbp_service import coverage
    return await coverage(session)


@router.get('/status')
async def read_quote_status(session: AsyncSession = Depends(get_session)):
    from app.services.quote_status_service import quote_status
    return await quote_status(session)


@router.get('/overview')
async def read_fx_rate_overview(session: AsyncSession = Depends(get_session)):
    from app.services.quote_status_service import fx_rate_overview
    return await fx_rate_overview(session)


@router.post('/nbp/latest')
async def refresh_latest_nbp_rates(session: AsyncSession = Depends(get_session)):
    from datetime import timedelta
    from app.services.nbp_service import import_plan, import_rates
    plan = await import_plan(session)
    if not plan['currencies']:
        return {'saved': 0, 'absent_currencies': []}
    return await import_rates(session, NBPImport(
        start_date=plan['end_date'] - timedelta(days=14),
        end_date=plan['end_date'], currencies=plan['currencies']))
