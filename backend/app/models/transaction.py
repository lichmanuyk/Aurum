"""A single money movement: income, expense, or a transfer between accounts."""
from datetime import date as date_

from sqlalchemy import CheckConstraint, Date, Enum, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.enums import MandatoryPaymentKind, TransactionType
from app.models.mixins import TimestampMixin
from app.models.tag import transaction_tags


class Transaction(Base, TimestampMixin):
    __tablename__ = "transactions"
    __table_args__ = (
        UniqueConstraint("crypto_transaction_id", name="uq_transaction_crypto_trade"),
        UniqueConstraint("asset_valuation_id", name="uq_transaction_asset_valuation"),
        UniqueConstraint("idempotency_key", name="uq_transaction_idempotency_key"),
        # A month is stored as its first calendar day — this is the one
        # invariant cheap enough (and important enough to a wrong-month bug)
        # to also enforce at the database level, on top of
        # tax_classification_violation (schemas/transaction.py). Every other
        # rule for these two columns (which type, together-or-neither,
        # split-vs-parent, no future month, no expense_asset_id clash) needs
        # "today" or a sibling row and stays application-level, same as
        # every other cross-field money rule in this app.
        CheckConstraint(
            "assigned_period IS NULL OR extract(day from assigned_period) = 1",
            name="ck_transaction_assigned_period_month_start",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("accounts.id", ondelete="CASCADE"), nullable=False)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"), nullable=True)
    # Destination account for TRANSFER-type rows only.
    transfer_account_id: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )

    type: Mapped[TransactionType] = mapped_column(
        Enum(TransactionType, name="transaction_type", native_enum=False, length=10), nullable=False
    )
    # Always stored positive; `type` carries the sign/direction.
    # Exception: ADJUSTMENT is a signed change to the balance, outside cash flow.
    amount: Mapped[Numeric] = mapped_column(Numeric(18, 6), nullable=False)
    destination_amount: Mapped[Numeric | None] = mapped_column(Numeric(18, 6), nullable=True)
    reporting_amount_override: Mapped[Numeric | None] = mapped_column(Numeric(18, 6), nullable=True)
    reporting_currency_override: Mapped[str | None] = mapped_column(String(3), nullable=True)
    reporting_override_source: Mapped[str | None] = mapped_column(String(50), nullable=True)
    adjustment_reason: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # Set only for an atomic asset purchase/sale. The public generic
    # transaction routes cannot create or edit these linked ledger rows.
    asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), nullable=True)
    # An *additional*, optional classification of an ordinary EXPENSE row as
    # upkeep/spending on a manually-tracked asset (property, vehicle, ...) —
    # see docs/tasks/property-expense-links.md. Deliberately separate from
    # asset_id above: that column belongs to an atomic buy/sell that moves
    # money and the asset's own valuation in lockstep; this one never
    # changes the account/amount/category/date or the asset's valuation,
    # it just tags an existing expense. RESTRICT (not SET NULL) so deleting
    # an asset with linked expenses fails with a clear 409 instead of
    # silently erasing the classification (see routes/assets.py's
    # delete_asset). Only valid when this row is a plain (non-split)
    # EXPENSE — see schemas/transaction.py's expense_asset_link_violation —
    # a split transaction links its *lines* instead (TransactionSplit's own
    # column below), never both, so a linked amount is never counted twice.
    expense_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), nullable=True)
    # Two independent, additive, nullable classifications on top of the
    # plain cash fact `date` above already records — see
    # docs/tasks/income-tax-separation.md. Neither ever changes
    # account/amount/date/currency or creates a second Transaction; both
    # are "extra tags on real money that already moved", the same shape as
    # expense_asset_id above.
    #
    # assigned_period: the calendar MONTH (stored as that month's first
    # day) this row's *earnings* belong to for the user's own worked-a-
    # month/paid-later analytics — deliberately independent of `date`
    # itself, which keeps recording the real cash day for every account
    # balance, FX lookup and ordinary report exactly as before. Only two
    # shapes are valid (enforced by tax_classification_violation, not the
    # database): on an INCOME row, set alone, it marks "this is gross
    # work income for that month" (an ordinary income keeps this NULL).
    # On an EXPENSE row it is required together with
    # mandatory_payment_kind below, marking "this paid that month's ZUS/
    # PPE/VAT" — never on both a split parent and its own lines (same
    # "parent XOR lines" rule expense_asset_id already follows).
    assigned_period: Mapped[date_ | None] = mapped_column(Date, nullable=True)
    # mandatory_payment_kind: which mandatory payment this EXPENSE is —
    # always paired with assigned_period above, never set on an INCOME
    # row (that side has only the one "work income" concept, no kind).
    mandatory_payment_kind: Mapped[MandatoryPaymentKind | None] = mapped_column(
        Enum(MandatoryPaymentKind, name="mandatory_payment_kind", native_enum=False, length=10), nullable=True
    )
    crypto_transaction_id: Mapped[int | None] = mapped_column(
        ForeignKey("crypto_transactions.id", ondelete="RESTRICT"), nullable=True
    )
    asset_valuation_id: Mapped[int | None] = mapped_column(
        ForeignKey("asset_valuations.id", ondelete="RESTRICT"), nullable=True
    )
    gross_amount: Mapped[Numeric | None] = mapped_column(Numeric(18, 6), nullable=True)
    fee_amount: Mapped[Numeric | None] = mapped_column(Numeric(18, 6), nullable=True)
    prior_asset_value: Mapped[Numeric | None] = mapped_column(Numeric(14, 2), nullable=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    description: Mapped[str] = mapped_column(String(255), nullable=False)
    merchant: Mapped[str | None] = mapped_column(String(150), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    date: Mapped[date_] = mapped_column(Date, nullable=False)

    account: Mapped["Account"] = relationship(back_populates="transactions", foreign_keys=[account_id])
    transfer_account: Mapped["Account | None"] = relationship(foreign_keys=[transfer_account_id])
    category: Mapped["Category | None"] = relationship(back_populates="transactions")
    tags: Mapped[list["Tag"]] = relationship(secondary=transaction_tags, back_populates="transactions")
    splits: Mapped[list["TransactionSplit"]] = relationship(
        back_populates="transaction", cascade="all, delete-orphan", order_by="TransactionSplit.id"
    )


class TransactionSplit(Base):
    """One category's slice of a transaction whose amount is divided across
    several categories (one receipt, several kinds of goods) — an
    alternative to Transaction.category_id, not an addition to it: a split
    transaction has category_id=NULL and two or more of these instead, and
    their amounts must add up to the parent's amount exactly (see
    schemas/transaction.py's split_rule_violation).

    category_id is nullable + SET NULL, same as Transaction.category_id
    itself — deleting a category must not break *reading* a split that used
    to point at it, only creating/editing one requires a live category (see
    routes/transactions.py, and the same lesson already applied to
    transfer_account_id)."""

    __tablename__ = "transaction_splits"
    __table_args__ = (
        CheckConstraint(
            "assigned_period IS NULL OR extract(day from assigned_period) = 1",
            name="ck_transaction_split_assigned_period_month_start",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_id: Mapped[int] = mapped_column(ForeignKey("transactions.id", ondelete="CASCADE"), nullable=False)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"), nullable=True)
    amount: Mapped[Numeric] = mapped_column(Numeric(18, 6), nullable=False)
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # One split line's own optional link to a manually-tracked asset — see
    # Transaction.expense_asset_id above for the full rationale. Living here
    # too (rather than only on the parent) is what lets one split purchase
    # cover several unrelated things (part groceries, part a car repair
    # part) without double-counting: each line is its own classification,
    # the parent's own column stays NULL whenever splits exist (enforced by
    # expense_asset_link_violation).
    expense_asset_id: Mapped[int | None] = mapped_column(ForeignKey("assets.id", ondelete="RESTRICT"), nullable=True)
    # Same pair, same rules, as Transaction.assigned_period/
    # mandatory_payment_kind above — one split line's own share of a mixed
    # purchase (part ordinary spending, part a mandatory tax payment) can
    # carry it while the parent (and every other line) does not.
    assigned_period: Mapped[date_ | None] = mapped_column(Date, nullable=True)
    mandatory_payment_kind: Mapped[MandatoryPaymentKind | None] = mapped_column(
        Enum(MandatoryPaymentKind, name="split_mandatory_payment_kind", native_enum=False, length=10), nullable=True
    )

    transaction: Mapped["Transaction"] = relationship(back_populates="splits")
    category: Mapped["Category | None"] = relationship()
