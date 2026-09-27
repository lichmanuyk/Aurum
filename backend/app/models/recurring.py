"""A template for a transaction that repeats on a schedule (rent, salary,
subscriptions). Posting is manual, one-click, not a background job — see
services/recurring_service.py for how next_due_date/is_due are computed
from anchor_date + last_posted_date, and how "Post now" creates a real
Transaction row from the template.
"""
from datetime import date as date_

from sqlalchemy import Boolean, Date, Enum, ForeignKey, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.enums import MandatoryPaymentKind, RecurringFrequency, TransactionType
from app.models.mixins import TimestampMixin


class RecurringTransaction(Base, TimestampMixin):
    __tablename__ = "recurring_transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"), nullable=True)
    # Destination account for TRANSFER-type rows only — same shape as Transaction.
    transfer_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )

    type: Mapped[TransactionType] = mapped_column(
        Enum(TransactionType, name="recurring_transaction_type", native_enum=False, length=10), nullable=False
    )
    amount: Mapped[Numeric] = mapped_column(Numeric(14, 2), nullable=False)
    # Same optional asset classification as Transaction.expense_asset_id
    # (see docs/tasks/property-expense-links.md) — only valid on an
    # EXPENSE template. Posting copies it onto the created Transaction in
    # the same atomic post (see services/recurring_service.post_recurring),
    # so a recurring utility bill's payments are found the same way a
    # one-off expense's would be. RESTRICT: deleting an asset with a linked
    # template is blocked until the template's link is explicitly cleared.
    expense_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), nullable=True)
    # Marks this EXPENSE template as always posting one specific mandatory
    # payment (ZUS/PPE/VAT) — see docs/tasks/income-tax-separation.md and
    # Transaction.mandatory_payment_kind's own docstring. Unlike that
    # column's sibling assigned_period, no period is stored here: each
    # month's actual assigned_period is supplied explicitly at "Post now"
    # time (RecurringPost.assigned_period below), never inferred from the
    # template or silently advanced — see services/recurring_service.py.
    # Mutually exclusive with expense_asset_id, same conflict rule as a
    # plain Transaction.
    mandatory_payment_kind: Mapped[MandatoryPaymentKind | None] = mapped_column(
        Enum(MandatoryPaymentKind, name="recurring_mandatory_payment_kind", native_enum=False, length=10),
        nullable=True,
    )
    description: Mapped[str] = mapped_column(String(255), nullable=False)
    merchant: Mapped[str | None] = mapped_column(String(150), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    frequency: Mapped[RecurringFrequency] = mapped_column(
        Enum(RecurringFrequency, name="recurring_frequency", native_enum=False, length=10), nullable=False
    )
    # First due date if never posted; also the day-of-month/weekday/month-day
    # the schedule is anchored to (see services/recurring_service._advance).
    anchor_date: Mapped[date_] = mapped_column(Date, nullable=False)
    last_posted_date: Mapped[date_ | None] = mapped_column(Date, nullable=True)
    # Pausing (e.g. a cancelled subscription you might resume) without
    # losing the template and its posting history.
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    account: Mapped["Account"] = relationship(foreign_keys=[account_id])
    transfer_account: Mapped["Account | None"] = relationship(foreign_keys=[transfer_account_id])
    category: Mapped["Category | None"] = relationship()
