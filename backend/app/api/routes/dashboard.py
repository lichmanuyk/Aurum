from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_reporting_session
from app.schemas.dashboard import DashboardSummary
from app.services.dashboard_service import get_dashboard_summary

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=DashboardSummary)
async def read_dashboard_summary(
    # Omitting both now means "all time" (see docs/tasks/dashboard-periods.md)
    # — a deliberate, documented change from the old "defaults to today"
    # shape: the only real caller is this app's own Dashboard, which now
    # opens on "all time" instead of the current month. A caller that still
    # wants the old single-month behavior passes both explicitly, exactly
    # as before — that shape is unchanged.
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    session: AsyncSession = Depends(get_reporting_session),
) -> DashboardSummary:
    if month is not None and year is None:
        raise HTTPException(status_code=422, detail="month requires year")
    return await get_dashboard_summary(session, year, month)
