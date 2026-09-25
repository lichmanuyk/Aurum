from fastapi import HTTPException
from app.core.money import require_money
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.models.settings import AppSettings
from app.schemas.settings import AppSettingsRead, AppSettingsUpdate
from app.services.settings_service import get_or_create_app_settings

router = APIRouter(prefix="/settings", tags=["settings"])

# The only fields where an explicit null in a PATCH is a real, meaningful
# value ("no choice yet" / "inherit summary_currency") rather than a mistake
# — every other field stays rejected below.
NULLABLE_DISPLAY_CURRENCY_FIELDS = {
    "summary_currency", "dashboard_currency", "net_worth_currency", "crypto_currency",
}


# Both routes still return the ORM row as-is: AppSettingsRead.app_version
# isn't a stored column, it defaults to APP_VERSION when FastAPI validates
# the response (see schemas/settings.py).
@router.get("", response_model=AppSettingsRead)
async def read_settings(session: AsyncSession = Depends(get_session)) -> AppSettings:
    return await get_or_create_app_settings(session)


@router.patch("", response_model=AppSettingsRead)
async def update_settings(payload: AppSettingsUpdate, session: AsyncSession = Depends(get_session)) -> AppSettings:
    settings = await get_or_create_app_settings(session)
    updates = payload.model_dump(exclude_unset=True)
    if any(value is None and field not in NULLABLE_DISPLAY_CURRENCY_FIELDS for field, value in updates.items()):
        raise HTTPException(422, "Settings cannot be null")
    require_money(updates.get("idle_cash_threshold_amount", settings.idle_cash_threshold_amount), updates.get("idle_cash_threshold_currency", settings.idle_cash_threshold_currency))
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(settings, field, value)
    await session.commit()
    await session.refresh(settings)
    return settings
