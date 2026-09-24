"""Savings goals: CRUD for the goal itself, plus a running current_amount —
the sum of all logged GoalContribution rows, computed on read rather than
stored, so it's never out of sync with the log."""

from app.core.money import require_money
from app.services.settings_service import get_or_create_app_settings
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.goal import Goal, GoalContribution
from app.schemas.goal import GoalContributionCreate, GoalCreate, GoalRead, GoalUpdate

_SELECT_WITH_TOTAL = (
    select(
        Goal.id,
        Goal.currency,
        Goal.name,
        Goal.target_amount,
        Goal.target_date,
        func.coalesce(func.sum(GoalContribution.amount), 0).label("current_amount"),
    )
    .outerjoin(GoalContribution, GoalContribution.goal_id == Goal.id)
    .group_by(Goal.id, Goal.currency, Goal.name, Goal.target_amount, Goal.target_date, Goal.created_at)
    .order_by(Goal.created_at)
)


def _to_read(row: Row) -> GoalRead:
    current = row.current_amount
    target = row.target_amount
    percent = float(current / target * 100) if target else 0.0
    return GoalRead(
        id=row.id,
        currency=row.currency,
        name=row.name,
        target_amount=target,
        target_date=row.target_date,
        current_amount=current,
        remaining=target - current,
        percent=percent,
        is_reached=current >= target,
    )


async def _read_one(session: AsyncSession, goal_id: int) -> GoalRead:
    row = (await session.execute(_SELECT_WITH_TOTAL.where(Goal.id == goal_id))).one()
    return _to_read(row)


async def list_goals(session: AsyncSession) -> list[GoalRead]:
    rows = (await session.execute(_SELECT_WITH_TOTAL)).all()
    return [_to_read(row) for row in rows]


async def create_goal(session: AsyncSession, payload: GoalCreate) -> GoalRead:
    goal = Goal(currency=payload.currency or (await get_or_create_app_settings(session)).currency, name=payload.name, target_amount=payload.target_amount, target_date=payload.target_date)
    require_money(goal.target_amount, goal.currency)
    session.add(goal)
    await session.commit()
    return GoalRead(
        id=goal.id,
        currency=goal.currency,
        name=goal.name,
        target_amount=goal.target_amount,
        target_date=goal.target_date,
        current_amount=Decimal("0"),
        remaining=goal.target_amount,
        percent=0.0,
        is_reached=False,
    )


async def update_goal(session: AsyncSession, goal_id: int, payload: GoalUpdate) -> GoalRead:
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    if "currency" in payload.model_fields_set and payload.currency != goal.currency:
        raise HTTPException(409, "Currency is fixed; create a new goal instead")
    if payload.target_amount is not None:
        require_money(payload.target_amount, goal.currency)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(goal, field, value)
    await session.commit()
    return await _read_one(session, goal_id)


async def delete_goal(session: AsyncSession, goal_id: int) -> None:
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    await session.delete(goal)
    await session.commit()


async def add_contribution(session: AsyncSession, goal_id: int, payload: GoalContributionCreate) -> GoalRead:
    goal = await session.get(Goal, goal_id)
    if goal is None:
        raise HTTPException(status_code=404, detail="Goal not found")
    require_money(payload.amount, goal.currency)
    session.add(GoalContribution(goal_id=goal_id, amount=payload.amount, date=payload.date, note=payload.note))
    await session.commit()
    return await _read_one(session, goal_id)
