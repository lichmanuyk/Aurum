from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends
from app.core.money import Currency

from app.db.session import get_db

DbSession = AsyncSession


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async for session in get_db():
        yield session


async def get_reporting_session(
    currency: Currency | None = None,
    session: AsyncSession = Depends(get_session),
) -> AsyncSession:
    """Override valuation currency for this request only, never stored settings."""
    from app.services.fx_service import FXConverter
    if currency is not None:
        fx = await FXConverter.load(session)
        fx.currency = currency
    return session
