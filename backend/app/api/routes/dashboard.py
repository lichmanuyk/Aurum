from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_reporting_session
from app.schemas.dashboard import DashboardSummary
from app.services.dashboard_service import get_dashboard_summary

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary", response_model=DashboardSummary)
async def read_dashboard_summary(
    # "month" (the default) is the ORIGINAL contract, unchanged: a bare
    # request with no params at all still resolves to the current
    # year/month, and `month` alone still resolves against the current
    # year — exactly as before docs/tasks/dashboard-periods.md. The two new
    # modes ("every month of a year", "all time") are opt-in via this
    # explicit param — never implied by omitting year/month, so an old
    # caller's request shape and result are both untouched.
    period: Literal["month", "year", "all"] = Query(default="month"),
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    session: AsyncSession = Depends(get_reporting_session),
) -> DashboardSummary:
    today = date.today()
    if period == "all":
        if year is not None or month is not None:
            raise HTTPException(status_code=422, detail="year/month are not allowed with period=all")
        resolved_year, resolved_month = None, None
    elif period == "year":
        if month is not None:
            raise HTTPException(status_code=422, detail="month is not allowed with period=year")
        resolved_year, resolved_month = (year if year is not None else today.year), None
    else:
        resolved_year = year if year is not None else today.year
        resolved_month = month if month is not None else today.month
    return await get_dashboard_summary(session, resolved_year, resolved_month)
