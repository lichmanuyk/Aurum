from datetime import date as date_

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_reporting_session
from app.schemas.cash_flow import CashFlowResponse
from app.services.cash_flow_service import get_cash_flow

router = APIRouter(prefix="/cash-flow", tags=["cash-flow"])


@router.get("", response_model=CashFlowResponse)
async def read_cash_flow(
    start_date: date_ | None = Query(default=None),
    end_date: date_ | None = Query(default=None),
    # get_reporting_session declares the optional `currency` query param that
    # applies here — see docs/tasks/cash-flow-reports-display-currency.md.
    session: AsyncSession = Depends(get_reporting_session),
) -> CashFlowResponse:
    return await get_cash_flow(session, start_date, end_date)
