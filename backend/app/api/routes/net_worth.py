from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_reporting_session
from app.schemas.net_worth import NetWorthSummary
from app.services.net_worth_service import RANGE_DAYS, get_net_worth_summary

router = APIRouter(prefix="/net-worth", tags=["net-worth"])

_VALID_RANGES = sorted(set(RANGE_DAYS) | {"all"})
_RANGE_PATTERN = f"^({'|'.join(_VALID_RANGES)})$"


@router.get("/summary", response_model=NetWorthSummary)
async def read_net_worth_summary(
    range: str = Query(default="30d", pattern=_RANGE_PATTERN),
    session: AsyncSession = Depends(get_reporting_session),
) -> NetWorthSummary:
    return await get_net_worth_summary(session, range)
