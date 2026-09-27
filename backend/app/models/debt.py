"""Debt tracking: who owes whom, in their own native currency — a receivable
(owed_to_me) or a liability (owed_by_me). See docs/tasks/debt-tracking.md.
Never ordinary income/expense/taxes/category spending/budgets/advice or
earned-income; interest and debt write-offs are out of scope (documented
there), only actual principal issuance/repayment.

Two shapes of "how a debt started" (see Debt.issuance_transaction_id):
  - An *opening* debt (issuance_transaction_id is NULL) — an already-
    existing real-world debt entered as a starting fact, the same
    "starting capital, no invented cash movement" idea as an account's own
    opening_balance adjustment (Transaction.adjustment_reason). No
    Transaction is ever created for this.
  - A *new loan* (issuance_transaction_id set) — real cash left/entered a
    chosen account at the moment the loan happened, recorded as one atomic
    Transaction (type debt_in/debt_out — see money_service.native_legs).

Either way, principal_amount is this debt's own native amount, in
`currency` — never converted from/inferred via FX; a linked issuance's own
account-currency amount lives on the Transaction itself (`amount`),
explicit and independent whenever the two currencies differ (see
schemas/debt.py's debt_amount_pair_violation), the same shape a
cross-currency Transfer's own destination_amount already uses.

Immutability: once a debt has been "used" — a new loan (cash already
moved) or any repayment/reversal recorded — every field below except
counterparty/note/due_date is locked (see services/debt_service.py).
A same-currency opening debt with zero repayments can still be corrected
in place (nothing to reconcile); a new loan's own terms are fixed the
moment it's created — delete (allowed while it still has zero repayments)
and recreate it instead, the same "delete and recreate" escape hatch
asset_movement_service.update_movement already uses for its own
immutable asset/type/date.
"""
from datetime import date as date_

from sqlalchemy import Date, Enum, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.enums import DebtDirection, DebtRepaymentKind
from app.models.mixins import TimestampMixin


class Debt(Base, TimestampMixin):
    __tablename__ = "debts"
    __table_args__ = (
        UniqueConstraint("issuance_transaction_id", name="uq_debt_issuance_transaction"),
        UniqueConstraint("idempotency_key", name="uq_debt_idempotency_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    direction: Mapped[DebtDirection] = mapped_column(
        Enum(DebtDirection, name="debt_direction", native_enum=False, length=20), nullable=False
    )
    counterparty: Mapped[str] = mapped_column(String(150), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    principal_amount: Mapped[Numeric] = mapped_column(Numeric(18, 6), nullable=False)
    start_date: Mapped[date_] = mapped_column(Date, nullable=False)
    due_date: Mapped[date_ | None] = mapped_column(Date, nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Set only for a "new loan" debt — the one Transaction (debt_in/
    # debt_out) that actually moved cash when the loan happened. RESTRICT
    # (not SET NULL/CASCADE): the generic transaction routes already refuse
    # to touch this row (routes/transactions.py's guard, same shape as
    # ASSET_BUY/ASSET_SELL's own); deleting it out from under a live Debt
    # would silently turn a real cash-moving loan into an opening-balance
    # one with no trace of the cash that actually moved.
    issuance_transaction_id: Mapped[int | None] = mapped_column(
        ForeignKey("transactions.id", ondelete="RESTRICT"), nullable=True
    )
    # Per-user-intent idempotency for debt *creation* — same "resend the
    # same key -> same result, a different payload under a reused key is a
    # 409" contract as asset_movement_service.create_movement.
    idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True)

    repayments: Mapped[list["DebtRepayment"]] = relationship(
        back_populates="debt", order_by=lambda: (DebtRepayment.id,)
    )
    # One-directional, no back_populates needed (Transaction never needs to
    # navigate "which Debt does this belong to") — its only real purpose is
    # giving the ORM's own flush an explicit dependency edge for INSERT
    # ordering during backup restore (services/backup_service.py), the same
    # one-directional pattern models/budget.py's own `category` relationship
    # already uses for the same reason. A plain FK column with no
    # relationship() on either side is NOT enough for SQLAlchemy's unit of
    # work to order two different tables' inserts within one flush — that
    # gap is what caused a real FK violation here before this was added
    # (restore_backup's own explicit `await session.flush()` calls are kept
    # anyway as an unambiguous belt-and-suspenders fix, independent of this).
    issuance_transaction: Mapped["Transaction | None"] = relationship(foreign_keys=[issuance_transaction_id])


class DebtRepayment(Base, TimestampMixin):
    """One actual cash event against a Debt — either a `repayment`
    (decreases outstanding) or a `reversal` of one specific earlier
    repayment (increases it back by that same amount, dated whenever the
    correction actually happened). Always exactly one real Transaction
    (transaction_id, never NULL) — unlike Debt's own issuance, a repayment
    is never a bare "opening" fact with no money movement. See
    services/debt_service.py."""

    __tablename__ = "debt_repayments"
    __table_args__ = (
        UniqueConstraint("transaction_id", name="uq_debt_repayment_transaction"),
        UniqueConstraint("reverses_repayment_id", name="uq_debt_repayment_reverses"),
        UniqueConstraint("idempotency_key", name="uq_debt_repayment_idempotency_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    # RESTRICT (not CASCADE): a debt with any repayment must have every one
    # of them explicitly deleted or reversed first — see
    # services/debt_service.py's delete_debt — so a debt is never silently
    # left with a smaller repayment history than the account/net-worth
    # history it already produced still shows.
    debt_id: Mapped[int] = mapped_column(ForeignKey("debts.id", ondelete="RESTRICT"), nullable=False)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id", ondelete="RESTRICT"), nullable=False)
    kind: Mapped[DebtRepaymentKind] = mapped_column(
        Enum(DebtRepaymentKind, name="debt_repayment_kind", native_enum=False, length=20),
        nullable=False, default=DebtRepaymentKind.REPAYMENT,
    )
    # Set only when kind=reversal — the specific repayment this one undoes.
    # RESTRICT + unique: at most one reversal per original, and the
    # original can't be deleted while its own reversal still points at it
    # (delete the reversal first, or just delete the original directly if
    # there never was one).
    reverses_repayment_id: Mapped[int | None] = mapped_column(
        ForeignKey("debt_repayments.id", ondelete="RESTRICT"), nullable=True
    )
    # Always the debt's OWN native currency amount — never inferred from
    # the linked Transaction's own (possibly different-currency) amount;
    # see schemas/debt.py's debt_amount_pair_violation. A reversal's own
    # value here always mirrors the repayment it reverses (copied at
    # creation, never independently edited afterwards).
    amount_debt_currency: Mapped[Numeric] = mapped_column(Numeric(18, 6), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True)

    debt: Mapped["Debt"] = relationship(back_populates="repayments")
    transaction: Mapped["Transaction"] = relationship()
