from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_reporting_session
from app.schemas.income_tax import IncomeTaxReport
from app.services.income_tax_service import get_income_tax_report

router = APIRouter(prefix="/income-tax", tags=["income-tax"])


@router.get("", response_model=IncomeTaxReport)
async def read_income_tax_report(
    year: int | None = Query(default=None, ge=2000, le=2100),
    month: int | None = Query(default=None, ge=1, le=12),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=12, ge=1, le=60),
    # get_reporting_session declares the optional `currency` query param that
    # overrides this request's FXConverter — same reporting-currency
    # mechanism every other report already uses (see reports.py/dashboard.py).
    session: AsyncSession = Depends(get_reporting_session),
) -> IncomeTaxReport:
    return await get_income_tax_report(session, year, month, page, page_size)
