"""Monthly category budgets: CRUD for the limits themselves, plus
get_budget_status(), which compares each limit against actual spend for a
given month — the data behind the Budget page's progress bars and the
budget_exceeded proactive alert (services/insights_service.py)."""

from app.core.money import require_money
from app.services.fx_service import FXConverter
from app.services.money_service import transactions_for_reporting
from app.services.settings_service import get_or_create_app_settings
import calendar
from collections import defaultdict
from datetime import date
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.budget import Budget
from app.models.category import Category
from app.models.enums import CategoryKind, TransactionType
from app.models.transaction import Transaction, TransactionSplit
from app.schemas.budget import BudgetCreate, BudgetStatus, BudgetStatusResponse, BudgetUpdate

_EAGER = (selectinload(Budget.category),)


def _month_bounds(year: int, month: int) -> tuple[date, date]:
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last_day)


async def list_budgets(session: AsyncSession) -> list[Budget]:
    result = await session.execute(select(Budget).options(*_EAGER).join(Category).order_by(Category.sort_order))
    return list(result.scalars().all())


async def create_budget(session: AsyncSession, payload: BudgetCreate) -> Budget:
    category = await session.get(Category, payload.category_id)
    if category is None:
        raise HTTPException(status_code=400, detail="Category not found")
    if category.kind != CategoryKind.EXPENSE:
        raise HTTPException(status_code=400, detail="Budgets can only be set on expense categories")

    existing = await session.execute(select(Budget).where(Budget.category_id == payload.category_id))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=400, detail=f"'{category.name}' already has a budget")

    budget = Budget(currency=payload.currency or (await get_or_create_app_settings(session)).currency, category_id=payload.category_id, monthly_limit=payload.monthly_limit)
    require_money(budget.monthly_limit, budget.currency)
    session.add(budget)
    await session.commit()
    refreshed = await session.execute(select(Budget).options(*_EAGER).where(Budget.id == budget.id))
    return refreshed.scalar_one()


async def update_budget(session: AsyncSession, budget_id: int, payload: BudgetUpdate) -> Budget:
    budget = await session.get(Budget, budget_id)
    if budget is None:
        raise HTTPException(status_code=404, detail="Budget not found")
    if "currency" in payload.model_fields_set and payload.currency != budget.currency:
        raise HTTPException(409, "Currency is fixed; create a new budget instead")
    require_money(payload.monthly_limit, budget.currency)
    budget.monthly_limit = payload.monthly_limit
    await session.commit()
    refreshed = await session.execute(select(Budget).options(*_EAGER).where(Budget.id == budget_id))
    return refreshed.scalar_one()


async def delete_budget(session: AsyncSession, budget_id: int) -> None:
    budget = await session.get(Budget, budget_id)
    if budget is None:
        raise HTTPException(status_code=404, detail="Budget not found")
    await session.delete(budget)
    await session.commit()


async def get_budget_status(session: AsyncSession, year: int, month: int) -> BudgetStatusResponse:
    start, end = _month_bounds(year, month)

    budgets = await list_budgets(session)
    if not budgets:
        return BudgetStatusResponse(year=year, month=month, items=[])

    # A budget on a top-level category covers its subcategories too — the
    # same rollup the Dashboard breakdown and the category report already do
    # (coalesce(parent_id, id) in dashboard_service/reports_service).
    # Counting only exact category_id matches meant a month could read as 900
    # spent on the Dashboard and 0 against its own budget. A subcategory that
    # has a budget of its own still tracks its own spending: both bars move,
    # each against its own limit.
    budget_category_ids = [b.category_id for b in budgets]
    children_by_parent: dict[int, list[int]] = defaultdict(list)
    child_rows = await session.execute(
        select(Category.id, Category.parent_id).where(Category.parent_id.in_(budget_category_ids))
    )
    for child_id, parent_id in child_rows.all():
        children_by_parent[parent_id].append(child_id)

    counted_ids = set(budget_category_ids).union(
        child_id for children in children_by_parent.values() for child_id in children
    )
    # A split transaction has category_id=NULL on its own row — its spend
    # lives on its split lines instead (see category_rollup.py), so a plain
    # sum on Transaction.category_id alone would silently under-count a
    # budget funded partly by split purchases.
    fx = await FXConverter.load(session)
    rows = await transactions_for_reporting(session, start, end, TransactionType.EXPENSE)
    spent_by_currency = {}
    for currency in {b.currency for b in budgets}:
        currency_ids = {b.category_id for b in budgets if b.currency == currency}
        counted_ids = currency_ids.union(child for parent in currency_ids for child in children_by_parent[parent])
        totals = defaultdict(Decimal)
        for tx in rows:
            if tx.category_id not in counted_ids and not any(line.category_id in counted_ids for line in tx.splits):
                continue
            lines = fx.splits(tx, currency) if tx.splits else [(tx.category_id, fx.transaction(tx, currency))]
            for category_id, amount in lines:
                totals[category_id] += amount
        spent_by_currency[currency] = totals

    items = []
    for budget in budgets:
        spent_by_category = spent_by_currency[budget.currency]
        spent = spent_by_category.get(budget.category_id, Decimal("0")) + sum(
            (spent_by_category.get(child_id, Decimal("0")) for child_id in children_by_parent[budget.category_id]),
            Decimal("0"),
        )
        percent = float(spent / budget.monthly_limit * 100) if budget.monthly_limit else 0.0
        items.append(
            BudgetStatus(
                budget_id=budget.id,
                currency=budget.currency,
                category_id=budget.category_id,
                category_name=budget.category.name,
                category_color=budget.category.color,
                category_icon=budget.category.icon,
                monthly_limit=budget.monthly_limit,
                spent=spent,
                remaining=budget.monthly_limit - spent,
                percent=percent,
                is_over_budget=spent > budget.monthly_limit,
            )
        )

    return BudgetStatusResponse(year=year, month=month, items=items)
