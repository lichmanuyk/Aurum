from app.schemas.recurring import RecurringPost
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.schemas.recurring import RecurringTransactionCreate, RecurringTransactionRead, RecurringTransactionUpdate
from app.services.recurring_service import (
    create_recurring,
    delete_recurring,
    list_recurring,
    post_recurring,
    update_recurring,
)

router = APIRouter(prefix="/recurring", tags=["recurring"])


@router.get("", response_model=list[RecurringTransactionRead])
async def read_recurring(session: AsyncSession = Depends(get_session)) -> list[RecurringTransactionRead]:
    return await list_recurring(session)


@router.post("", response_model=RecurringTransactionRead, status_code=201)
async def create_recurring_route(
    payload: RecurringTransactionCreate, session: AsyncSession = Depends(get_session)
) -> RecurringTransactionRead:
    return await create_recurring(session, payload)


@router.patch("/{recurring_id}", response_model=RecurringTransactionRead)
async def update_recurring_route(
    recurring_id: int, payload: RecurringTransactionUpdate, session: AsyncSession = Depends(get_session)
) -> RecurringTransactionRead:
    return await update_recurring(session, recurring_id, payload)


@router.delete("/{recurring_id}", status_code=204)
async def delete_recurring_route(recurring_id: int, session: AsyncSession = Depends(get_session)) -> None:
    await delete_recurring(session, recurring_id)


@router.post("/{recurring_id}/post", response_model=RecurringTransactionRead, status_code=201)
async def post_recurring_route(
    recurring_id: int, payload: RecurringPost | None = None, session: AsyncSession = Depends(get_session)
) -> RecurringTransactionRead:
    return await post_recurring(session, recurring_id, payload.destination_amount if payload else None)
