from app.core.config import get_settings
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.settings import AppSettings


async def get_or_create_app_settings(session: AsyncSession) -> AppSettings:
    """Singleton row (id=1) — get-or-create so callers never hit a missing
    row even if app startup's seeding hasn't run yet (e.g. a fresh test DB)."""
    settings = await session.get(AppSettings, 1)
    if settings is None:
        settings = AppSettings(id=1, currency=get_settings().default_currency, idle_cash_threshold_currency=get_settings().default_currency)
        session.add(settings)
        await session.commit()
        await session.refresh(settings)
    return settings
