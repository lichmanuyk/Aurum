from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_session
from app.models.category import Category
from app.models.budget import Budget
from app.models.enums import CategoryKind
from app.models.recurring import RecurringTransaction
from app.models.transaction import Transaction, TransactionSplit
from app.schemas.category import CategoryCreate, CategoryRead, CategoryUpdate

router = APIRouter(prefix="/categories", tags=["categories"])


async def _validate_parent(session: AsyncSession, parent_id: int, kind: CategoryKind, category_id: int | None) -> None:
    """Subcategories are one level deep only: a parent must itself be
    top-level, and must share the child's kind (an expense category can't
    nest under an income one, or vice versa)."""
    if parent_id == category_id:
        raise HTTPException(status_code=400, detail="A category cannot be its own parent")
    parent = await session.get(Category, parent_id)
    if parent is None:
        raise HTTPException(status_code=400, detail="Parent category not found")
    if parent.parent_id is not None:
        raise HTTPException(status_code=400, detail="Subcategories can only be one level deep")
    if parent.kind != kind:
        raise HTTPException(status_code=400, detail="A subcategory must have the same kind as its parent")


@router.get("", response_model=list[CategoryRead])
async def list_categories(
    kind: CategoryKind | None = None, session: AsyncSession = Depends(get_session)
) -> list[Category]:
    stmt = select(Category).order_by(Category.sort_order)
    if kind is not None:
        stmt = stmt.where(Category.kind == kind)
    result = await session.execute(stmt)
    return list(result.scalars().all())


@router.post("", response_model=CategoryRead, status_code=201)
async def create_category(payload: CategoryCreate, session: AsyncSession = Depends(get_session)) -> Category:
    if payload.parent_id is not None:
        await _validate_parent(session, payload.parent_id, payload.kind, category_id=None)
    category = Category(**payload.model_dump(), is_default=False)
    session.add(category)
    await session.commit()
    await session.refresh(category)
    return category


@router.patch("/{category_id}", response_model=CategoryRead)
async def update_category(
    category_id: int, payload: CategoryUpdate, session: AsyncSession = Depends(get_session)
) -> Category:
    category = await session.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=404, detail="Category not found")
    updates = payload.model_dump(exclude_unset=True)
    if "parent_id" in updates and updates["parent_id"] is not None:
        await _validate_parent(session, updates["parent_id"], category.kind, category_id=category_id)
        has_children = (
            await session.execute(select(Category.id).where(Category.parent_id == category_id).limit(1))
        ).first()
        if has_children is not None:
            raise HTTPException(status_code=400, detail="A category with subcategories cannot become a subcategory itself")
    for field, value in updates.items():
        setattr(category, field, value)
    await session.commit()
    await session.refresh(category)
    return category


@router.delete("/{category_id}", status_code=204)
async def delete_category(category_id: int, session: AsyncSession = Depends(get_session)) -> None:
    category = await session.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=404, detail="Category not found")
    # Both seeded and custom categories must stay while referenced. A used
    # child also keeps its parent: removing the parent would change how old
    # spending is grouped in reports. The FK's SET NULL would hide both.
    protected_ids = select(Category.id).where((Category.id == category_id) | (Category.parent_id == category_id))
    has_transaction = (
        await session.execute(select(Transaction.id).where(Transaction.category_id.in_(protected_ids)).limit(1))
    ).first()
    has_split = (
        await session.execute(select(TransactionSplit.id).where(TransactionSplit.category_id.in_(protected_ids)).limit(1))
    ).first()
    has_budget = (await session.execute(select(Budget.id).where(Budget.category_id.in_(protected_ids)).limit(1))).first()
    has_recurring = (
        await session.execute(select(RecurringTransaction.id).where(RecurringTransaction.category_id.in_(protected_ids)).limit(1))
    ).first()
    if any((has_transaction, has_split, has_budget, has_recurring)):
        raise HTTPException(status_code=400, detail="Categories in use cannot be deleted")
    await session.delete(category)
    await session.commit()
