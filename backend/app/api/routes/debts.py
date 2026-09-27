"""Debt tracking routes — see docs/tasks/debt-tracking.md and
services/debt_service.py."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.models.enums import DebtDirection
from app.schemas.debt import (
    DebtCreate,
    DebtRead,
    DebtRepaymentCreate,
    DebtRepaymentRead,
    DebtRepaymentReverse,
    DebtRepaymentUpdate,
    DebtUpdate,
)
from app.services import debt_service

router = APIRouter(prefix="/debts", tags=["debts"])


@router.get("", response_model=list[DebtRead])
async def list_debts(
    direction: DebtDirection | None = None,
    status: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[DebtRead]:
    return await debt_service.list_debts(session, direction, status)


@router.post("", response_model=DebtRead, status_code=201)
async def create_debt(payload: DebtCreate, session: AsyncSession = Depends(get_session)) -> DebtRead:
    return await debt_service.create_debt(session, payload)


@router.get("/{debt_id}", response_model=DebtRead)
async def read_debt(debt_id: int, session: AsyncSession = Depends(get_session)) -> DebtRead:
    return await debt_service.read_debt(session, debt_id)


@router.patch("/{debt_id}", response_model=DebtRead)
async def update_debt(debt_id: int, payload: DebtUpdate, session: AsyncSession = Depends(get_session)) -> DebtRead:
    return await debt_service.update_debt(session, debt_id, payload)


@router.delete("/{debt_id}", status_code=204)
async def delete_debt(debt_id: int, session: AsyncSession = Depends(get_session)) -> None:
    await debt_service.delete_debt(session, debt_id)


@router.get("/{debt_id}/repayments", response_model=list[DebtRepaymentRead])
async def list_repayments(debt_id: int, session: AsyncSession = Depends(get_session)) -> list[DebtRepaymentRead]:
    return await debt_service.list_repayments(session, debt_id)


@router.post("/{debt_id}/repayments", response_model=DebtRepaymentRead, status_code=201)
async def create_repayment(
    debt_id: int, payload: DebtRepaymentCreate, session: AsyncSession = Depends(get_session)
) -> DebtRepaymentRead:
    return await debt_service.create_repayment(session, debt_id, payload)


@router.patch("/{debt_id}/repayments/{repayment_id}", response_model=DebtRepaymentRead)
async def update_repayment(
    debt_id: int, repayment_id: int, payload: DebtRepaymentUpdate, session: AsyncSession = Depends(get_session)
) -> DebtRepaymentRead:
    return await debt_service.update_repayment(session, debt_id, repayment_id, payload)


@router.delete("/{debt_id}/repayments/{repayment_id}", status_code=204)
async def delete_repayment(debt_id: int, repayment_id: int, session: AsyncSession = Depends(get_session)) -> None:
    await debt_service.delete_repayment(session, debt_id, repayment_id)


@router.post("/{debt_id}/repayments/{repayment_id}/reverse", response_model=DebtRepaymentRead, status_code=201)
async def reverse_repayment(
    debt_id: int, repayment_id: int, payload: DebtRepaymentReverse, session: AsyncSession = Depends(get_session)
) -> DebtRepaymentRead:
    return await debt_service.reverse_repayment(session, debt_id, repayment_id, payload)
