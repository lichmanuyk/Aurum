from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.schemas.asset_movement import AssetMovementInput, AssetMovementRead
from app.services.asset_movement_service import create_movement, delete_movement, list_movements, update_movement

router = APIRouter(prefix="/asset-movements", tags=["asset movements"])


@router.get("", response_model=list[AssetMovementRead])
async def list_route(asset_id: int | None = None, session: AsyncSession = Depends(get_session)):
    return await list_movements(session, asset_id)


@router.post("", response_model=AssetMovementRead, status_code=201)
async def create_route(payload: AssetMovementInput, session: AsyncSession = Depends(get_session)):
    return await create_movement(session, payload)


@router.put("/{movement_id}", response_model=AssetMovementRead)
async def update_route(movement_id: int, payload: AssetMovementInput, session: AsyncSession = Depends(get_session)):
    return await update_movement(session, movement_id, payload)


@router.delete("/{movement_id}", status_code=204)
async def delete_route(movement_id: int, session: AsyncSession = Depends(get_session)):
    await delete_movement(session, movement_id)
