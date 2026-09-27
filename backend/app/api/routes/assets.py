from app.services.settings_service import get_or_create_app_settings
from app.core.money import require_money
from datetime import date
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_reporting_session, get_session
from app.models.asset import Asset, AssetValuation
from app.models.enums import AssetClass, TransactionType
from app.models.recurring import RecurringTransaction
from app.models.transaction import Transaction, TransactionSplit
from app.schemas.asset import AssetCreate, AssetRead, AssetUpdate, AssetValuationCreate, AssetValuationRead
from app.schemas.asset_expense import AssetExpenseReport
from app.services.asset_expense_service import get_asset_expense_report
from app.services.fx_service import FXConverter

router = APIRouter(prefix="/assets", tags=["assets"])

_EAGER = (selectinload(Asset.valuations),)


async def _expense_link_blocker(session: AsyncSession, asset_id: int) -> str | None:
    """Any of the three optional links onto this asset (see
    docs/tasks/property-expense-links.md) — a plain expense, a split line,
    or a recurring template. Shared by delete_asset (below) and
    update_asset's own class-change guard: both need "does this asset
    still have any link at all", just with a different message for the
    caller to act on. Returns the first violation's message, or None."""
    if await session.scalar(select(Transaction.id).where(Transaction.expense_asset_id == asset_id)):
        return "Unlink expenses from this asset first"
    if await session.scalar(select(TransactionSplit.id).where(TransactionSplit.expense_asset_id == asset_id)):
        return "Unlink split expense lines from this asset first"
    if await session.scalar(select(RecurringTransaction.id).where(RecurringTransaction.expense_asset_id == asset_id)):
        return "Unlink recurring templates from this asset first"
    return None


def _to_read(asset: Asset, fx: FXConverter, today: date) -> AssetRead:
    latest = next((v for v in reversed(asset.valuations) if v.as_of_date <= today), None)
    capital_value: Decimal | None = None
    capital_error: str | None = None
    if latest is None:
        # Never valued as of today (e.g. only a future-dated valuation
        # exists) — no amount to convert, not a real zero.
        capital_error = "no_valuation"
    else:
        try:
            capital_value = fx.convert(latest.value, asset.currency, today)
        except HTTPException:
            # A missing FX rate is this one asset's problem, not the whole
            # list's — every other asset still gets a usable equivalent.
            capital_error = "fx_rate_missing"
    return AssetRead(
        id=asset.id,
        name=asset.name,
        asset_class=asset.asset_class,
        currency=asset.currency,
        notes=asset.notes,
        capital_role=asset.capital_role,
        monthly_cash_flow=asset.monthly_cash_flow,
        risk_level=asset.risk_level,
        current_value=latest.value if latest else 0,
        as_of_date=latest.as_of_date if latest else asset.created_at.date(),
        capital_value=capital_value,
        capital_currency=fx.currency,
        capital_value_error=capital_error,
    )


@router.get("", response_model=list[AssetRead])
async def list_assets(session: AsyncSession = Depends(get_reporting_session)) -> list[AssetRead]:
    result = await session.execute(select(Asset).options(*_EAGER).order_by(Asset.name))
    assets = result.scalars().all()
    fx = await FXConverter.load(session)
    today = date.today()
    return [_to_read(asset, fx, today) for asset in assets]


@router.post("", response_model=AssetRead, status_code=201)
async def create_asset(payload: AssetCreate, session: AsyncSession = Depends(get_session)) -> AssetRead:
    asset = Asset(
        name=payload.name,
        asset_class=payload.asset_class,
        currency=payload.currency if "currency" in payload.model_fields_set else (await get_or_create_app_settings(session)).currency,
        notes=payload.notes,
        capital_role=payload.capital_role,
        monthly_cash_flow=payload.monthly_cash_flow,
        risk_level=payload.risk_level,
    )
    require_money(payload.value, asset.currency)
    require_money(payload.monthly_cash_flow or 0, asset.currency)
    session.add(asset)
    await session.flush()
    session.add(AssetValuation(asset_id=asset.id, value=payload.value, as_of_date=payload.as_of_date))
    await session.commit()

    refreshed = await session.execute(select(Asset).options(*_EAGER).where(Asset.id == asset.id))
    return _to_read(refreshed.scalar_one(), await FXConverter.load(session), date.today())


@router.patch("/{asset_id}", response_model=AssetRead)
async def update_asset(asset_id: int, payload: AssetUpdate, session: AsyncSession = Depends(get_session)) -> AssetRead:
    result = await session.execute(select(Asset).options(*_EAGER).where(Asset.id == asset_id))
    asset = result.scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if "currency" in payload.model_fields_set and payload.currency is None:
        raise HTTPException(422, "Currency cannot be null")
    if payload.currency is not None and payload.currency != asset.currency and asset.valuations:
        raise HTTPException(409, "Asset currency cannot change after valuations exist")
    if payload.monthly_cash_flow is not None:
        require_money(payload.monthly_cash_flow, asset.currency)
    # A crypto-class Asset row is always a CryptoHolding's own shell, never
    # a valid expense-link target (see routes/transactions.py's own
    # _ensure_expense_asset_valid) — reclassifying a *linked* asset to
    # crypto would leave every existing link pointing at a target the
    # backup importer's own validation (backup_service.py) already rejects
    # outright, making the very next export unrestorable. Same "explicit
    # unlink first" rule as deleting a linked asset (delete_asset below).
    if payload.asset_class == AssetClass.CRYPTO and asset.asset_class != AssetClass.CRYPTO:
        blocker = await _expense_link_blocker(session, asset_id)
        if blocker:
            raise HTTPException(409, f"{blocker} before reclassifying it as crypto")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(asset, field, value)
    await session.commit()
    await session.refresh(asset, attribute_names=["valuations"])
    return _to_read(asset, await FXConverter.load(session), date.today())


@router.post("/{asset_id}/valuations", response_model=AssetRead)
async def add_asset_valuation(
    asset_id: int, payload: AssetValuationCreate, session: AsyncSession = Depends(get_session)
) -> AssetRead:
    """Records (or corrects) an asset's value as of a date. Re-submitting the
    same date updates that day's value instead of erroring, so users can fix
    a typo without needing a separate edit flow."""
    asset = await session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")

    require_money(payload.value, asset.currency)
    await session.scalar(select(Asset.id).where(Asset.id == asset_id).with_for_update())
    existing = await session.scalar(select(AssetValuation).where(
        AssetValuation.asset_id == asset_id, AssetValuation.as_of_date == payload.as_of_date
    ).order_by(AssetValuation.id.desc()).limit(1))
    if existing and await session.scalar(select(Transaction.id).where(Transaction.asset_valuation_id == existing.id)):
        raise HTTPException(409, "Edit the linked asset movement to change this valuation")
    if existing:
        existing.value = payload.value
    else:
        session.add(AssetValuation(asset_id=asset_id, value=payload.value, as_of_date=payload.as_of_date))
    await session.commit()

    refreshed = await session.execute(select(Asset).options(*_EAGER).where(Asset.id == asset_id))
    return _to_read(refreshed.scalar_one(), await FXConverter.load(session), date.today())


@router.get("/{asset_id}/valuations", response_model=list[AssetValuationRead])
async def list_asset_valuations(asset_id: int, session: AsyncSession = Depends(get_session)) -> list[AssetValuation]:
    asset = await session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    result = await session.execute(
        select(AssetValuation).where(AssetValuation.asset_id == asset_id).order_by(AssetValuation.as_of_date, AssetValuation.id)
    )
    return list(result.scalars().all())


@router.get("/{asset_id}/expenses", response_model=AssetExpenseReport)
async def get_asset_expenses(
    asset_id: int,
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    session: AsyncSession = Depends(get_reporting_session),
) -> AssetExpenseReport:
    """Actual spending linked to one manually-tracked asset (property,
    vehicle, ...) — see docs/tasks/property-expense-links.md. `currency` is
    accepted the same way /assets already does, via get_reporting_session."""
    return await get_asset_expense_report(session, asset_id, year, month, page, page_size)


@router.delete("/{asset_id}", status_code=204)
async def delete_asset(asset_id: int, session: AsyncSession = Depends(get_session)) -> None:
    asset = await session.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if await session.scalar(select(Transaction.id).where(
        Transaction.asset_id == asset_id,
        Transaction.type.in_((TransactionType.ASSET_BUY, TransactionType.ASSET_SELL)),
    )):
        raise HTTPException(409, "Delete linked asset movements before deleting the asset")
    # An expense/split/template's *link* to this asset (see
    # docs/tasks/property-expense-links.md) is a separate, additive concern
    # from the atomic buy/sell movements checked above — deleting the asset
    # must not silently erase that classification (or, for a split line,
    # trip the ON DELETE RESTRICT FK as an opaque 500). The user has to
    # explicitly unlink each one first (PATCH with expense_asset_id: null),
    # same "explicit action, not a side effect" rule the link's own
    # create/update path already follows.
    blocker = await _expense_link_blocker(session, asset_id)
    if blocker:
        raise HTTPException(409, f"{blocker} before deleting it")
    await session.delete(asset)
    await session.commit()
