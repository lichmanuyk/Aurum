from app.core.money import Currency, adjustment_rule_violation
from typing import Literal

AdjustmentReason = Literal["opening_balance", "reconciliation", "migration"]
from datetime import date as date_
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.core.clock import business_today
from app.core.text import capitalize_first_letter
from app.models.enums import MandatoryPaymentKind, TransactionType
from app.schemas.account import AccountRead
from app.schemas.category import CategoryRead
from app.schemas.tag import TagRead


def transfer_rule_violation(
    *,
    type: TransactionType,
    account_id: int,
    transfer_account_id: int | None,
    category_id: int | None,
) -> str | None:
    """The transfer invariants in one place, returning the problem as text or
    None if the combination is valid.

    Both halves of the write path go through this: the create schema below
    (as a pydantic validator) and the PATCH route (see
    routes/transactions.py). Enforcing it on create only used to let an edit
    produce a row that create would have rejected — most damagingly a
    transfer with no transfer_account_id, which TransactionRead itself can't
    serialize, so the row broke every later read of the transactions list.
    """
    if type == TransactionType.TRANSFER:
        if not transfer_account_id:
            return "transfer_account_id is required for transfer transactions"
        if transfer_account_id == account_id:
            return "transfer_account_id must differ from account_id"
        if category_id:
            return "category_id is not valid for transfer transactions"
    elif transfer_account_id:
        return "transfer_account_id is only valid for transfer transactions"
    return None


def expense_asset_link_violation(
    *, type: TransactionType, expense_asset_id: int | None, split_count: int
) -> str | None:
    """A completed expense's optional, additive link to a manually-tracked
    asset (property, vehicle, ...) — see docs/tasks/property-expense-links.md.
    It never creates a second transaction and never changes the linked
    asset's own valuation; it only lets the asset's own "Expenses" view find
    this row later. Checked the same way as transfer_rule_violation/
    split_rule_violation above: on create, and against the row as it would
    look *after* a patch (routes/transactions.py), so an edit can't leave a
    non-expense row or a split parent still carrying the link.

    Only a plain (non-split) EXPENSE row's own amount can carry this link —
    a split transaction links its *lines* instead (TransactionSplitInput's
    own field), so the same money is never classified twice under one asset
    (once on the parent, once again on a line)."""
    if expense_asset_id is None:
        return None
    if type != TransactionType.EXPENSE:
        return "expense_asset_id is only valid for expense transactions"
    if split_count > 0:
        return "expense_asset_id cannot be set on a split transaction's parent; link its split lines instead"
    return None


def tax_classification_violation(
    *,
    type: TransactionType,
    assigned_period: date_ | None,
    mandatory_payment_kind: MandatoryPaymentKind | None,
    expense_asset_id: int | None,
    split_count: int,
) -> str | None:
    """The gross-income/mandatory-tax invariants in one place — see
    docs/tasks/income-tax-separation.md and Transaction.assigned_period's
    own docstring. Same shape and reuse pattern as
    expense_asset_link_violation above: called once against a plain
    (non-split) row with split_count=0, and once per split line with
    split_count=0 again (a line is never itself split further) but the
    *parent's* row checked with its real split_count, so a split parent can
    never carry either field itself — only its lines can.

    Neither field ever changes account/amount/date/currency or creates a
    second Transaction; this only decides whether the combination the
    caller is about to save makes sense at all.
    """
    if assigned_period is None and mandatory_payment_kind is None:
        return None
    if assigned_period is not None and assigned_period.day != 1:
        return "assigned_period must be the first day of its month"
    if assigned_period is not None:
        today = business_today()
        if (assigned_period.year, assigned_period.month) > (today.year, today.month):
            return "assigned_period cannot be in the future"
    if type not in (TransactionType.INCOME, TransactionType.EXPENSE):
        return "assigned_period is only valid for income or expense transactions"
    if split_count > 0:
        return "assigned_period/mandatory_payment_kind cannot be set on a split transaction's parent; classify its split lines instead"
    if type == TransactionType.INCOME:
        if mandatory_payment_kind is not None:
            return "mandatory_payment_kind is only valid for expense transactions"
        return None
    # EXPENSE: both or neither — a bare period with no kind (or vice versa)
    # is ambiguous, not a smaller, still-useful fact.
    if assigned_period is None or mandatory_payment_kind is None:
        return "a mandatory tax expense needs both assigned_period and mandatory_payment_kind"
    if expense_asset_id is not None:
        return "a transaction cannot be classified as both a mandatory tax payment and a property expense"
    return None


def split_rule_violation(
    *,
    type: TransactionType,
    amount: Decimal,
    category_id: int | None,
    split_count: int,
    split_total: Decimal | None,
) -> str | None:
    """The split invariants in one place, same shape as transfer_rule_violation
    above — checked on create, and against the row *as it would look after
    a patch* on update (see routes/transactions.py), so an edit can't leave
    a transaction whose splits no longer add up to its own amount.

    Takes counts/totals rather than the split objects themselves: the
    update path's "splits weren't touched by this patch" case has to check
    the existing ORM rows, whose category_id can be None (the category was
    since deleted) — nothing here needs a live category to check the sum.
    """
    if split_count == 0:
        return None
    if type in (TransactionType.TRANSFER, TransactionType.ADJUSTMENT):
        return "splits are not valid for transfers or adjustments"
    if category_id is not None:
        return "category_id must be omitted when splitting a transaction across categories"
    if split_count < 2:
        return "splitting a transaction needs at least 2 categories"
    if split_total != amount:
        return f"split amounts ({split_total}) must add up to the transaction amount ({amount})"
    return None


class TransactionFields(BaseModel):
    """A transaction's shape, without the rules that only make sense while
    writing one. Reading goes through this: rows already in the database can
    stop satisfying a write-time rule through no fault of their own — the
    transfer_account_id FK is ON DELETE SET NULL, so deleting an account
    leaves the transfers that pointed at it with no destination — and
    refusing to serialize such a row would take the whole transactions list
    down with it, leaving no way in the UI to find and delete the row."""

    destination_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    reporting_amount_override: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    reporting_currency_override: Currency | None = None
    reporting_override_source: str | None = Field(default=None, min_length=1, max_length=50)
    account_id: int
    category_id: int | None = None
    transfer_account_id: int | None = None
    # Optional classification of this expense as spending on a
    # manually-tracked asset — see expense_asset_link_violation above.
    # None/omitted here means "no link"; a split transaction links its
    # lines instead (see TransactionSplitInput.expense_asset_id below).
    expense_asset_id: int | None = None
    # The month (first day) this row's *earnings* belong to — see
    # tax_classification_violation above and Transaction.assigned_period's
    # own docstring. None/omitted -> not classified (an ordinary income or
    # expense, unchanged from before this existed).
    assigned_period: date_ | None = None
    # Which mandatory payment this EXPENSE is (ZUS/PPE/VAT) — always paired
    # with assigned_period above; never valid on INCOME.
    mandatory_payment_kind: MandatoryPaymentKind | None = None
    type: TransactionType
    adjustment_reason: AdjustmentReason | None = None
    amount: Decimal = Field(max_digits=18, decimal_places=6)
    description: str = Field(min_length=1, max_length=255)
    merchant: str | None = Field(default=None, max_length=150)
    notes: str | None = Field(default=None, max_length=2000)
    date: date_

    # Auto-capitalizes "траты на продукты" -> "Траты на продукты" so mixed
    # casing from quick manual entry doesn't need fixing by hand later.
    @field_validator("description")
    @classmethod
    def _capitalize_description(cls, value: str) -> str:
        return capitalize_first_letter(value)


class TransactionBase(TransactionFields):
    """The write-side shape: the fields plus the invariants a new or edited
    row has to satisfy."""

    @model_validator(mode="after")
    def _validate_type_specific_fields(self) -> "TransactionBase":
        if self.type in (TransactionType.ASSET_BUY, TransactionType.ASSET_SELL):
            raise ValueError("Use the asset movement route for purchases and sales")
        violation = adjustment_rule_violation(self.type, self.amount, self.adjustment_reason, self.category_id) or transfer_rule_violation(
            type=self.type,
            account_id=self.account_id,
            transfer_account_id=self.transfer_account_id,
            category_id=self.category_id,
        )
        if violation:
            raise ValueError(violation)
        return self


class TransactionSplitInput(BaseModel):
    category_id: int
    amount: Decimal = Field(gt=0, max_digits=18, decimal_places=6)
    note: str | None = Field(default=None, max_length=200)
    # This line's own optional asset link — see
    # expense_asset_link_violation's docstring above for why a split's
    # lines carry the link instead of the parent.
    expense_asset_id: int | None = None
    # This line's own optional gross-income/mandatory-tax classification —
    # same "parent XOR lines" reasoning as expense_asset_id just above; see
    # tax_classification_violation.
    assigned_period: date_ | None = None
    mandatory_payment_kind: MandatoryPaymentKind | None = None


class TransactionCreate(TransactionBase):
    tag_ids: list[int] = Field(default_factory=list)
    # None/omitted -> a normal single-category transaction, unchanged from
    # before. 2+ entries -> the amount is divided across categories instead
    # of using category_id (which must then be omitted — see
    # split_rule_violation). A single entry isn't accepted: that's just
    # category_id with extra steps.
    splits: list[TransactionSplitInput] | None = None

    @model_validator(mode="after")
    def _validate_splits(self) -> "TransactionCreate":
        splits = self.splits or []
        violation = split_rule_violation(
            type=self.type,
            amount=self.amount,
            category_id=self.category_id,
            split_count=len(splits),
            split_total=sum((s.amount for s in splits), Decimal("0")) if splits else None,
        )
        if violation:
            raise ValueError(violation)
        asset_violation = expense_asset_link_violation(
            type=self.type, expense_asset_id=self.expense_asset_id, split_count=len(splits)
        )
        if asset_violation:
            raise ValueError(asset_violation)
        tax_violation = tax_classification_violation(
            type=self.type,
            assigned_period=self.assigned_period,
            mandatory_payment_kind=self.mandatory_payment_kind,
            expense_asset_id=self.expense_asset_id,
            split_count=len(splits),
        )
        if tax_violation:
            raise ValueError(tax_violation)
        for split in splits:
            split_violation = tax_classification_violation(
                type=self.type,
                assigned_period=split.assigned_period,
                mandatory_payment_kind=split.mandatory_payment_kind,
                expense_asset_id=split.expense_asset_id,
                split_count=0,
            )
            if split_violation:
                raise ValueError(split_violation)
        return self


class TransactionUpdate(BaseModel):
    destination_amount: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    reporting_amount_override: Decimal | None = Field(default=None, gt=0, max_digits=18, decimal_places=6)
    reporting_currency_override: Currency | None = None
    reporting_override_source: str | None = Field(default=None, min_length=1, max_length=50)

    account_id: int | None = None
    category_id: int | None = None
    transfer_account_id: int | None = None
    # Omitted -> the existing link (if any) is left untouched. Explicit
    # null -> the link is cleared. Explicit id -> the link is set/replaced,
    # subject to the same expense_asset_link_violation checks as create
    # (see routes/transactions.py's update_transaction) — this is the
    # "explicit user action" required to change/remove a link per
    # docs/tasks/property-expense-links.md, never an implicit side effect
    # of some other field changing.
    expense_asset_id: int | None = None
    # Omitted -> the existing classification (if any) is left untouched.
    # Explicit null -> cleared. Explicit value -> set/replaced — same
    # "explicit user action" contract as expense_asset_id above. Both
    # fields are always sent/cleared together by the frontend, but the API
    # itself allows patching either alone (e.g. correcting just the kind);
    # the row *as it would look after the patch* is what
    # tax_classification_violation checks (see routes/transactions.py).
    assigned_period: date_ | None = None
    mandatory_payment_kind: MandatoryPaymentKind | None = None
    type: TransactionType | None = None
    adjustment_reason: AdjustmentReason | None = None
    amount: Decimal | None = Field(default=None, max_digits=18, decimal_places=6)
    description: str | None = Field(default=None, min_length=1, max_length=255)
    merchant: str | None = Field(default=None, max_length=150)
    notes: str | None = Field(default=None, max_length=2000)
    date: date_ | None = None
    # Omitted -> tags untouched; sent (even as []) -> replaces the full tag set.
    tag_ids: list[int] | None = None
    # Omitted -> splits untouched; sent (even as []) -> replaces the full
    # split set (send [] together with a category_id to turn a split
    # transaction back into a normal single-category one).
    splits: list[TransactionSplitInput] | None = None

    @field_validator("description")
    @classmethod
    def _capitalize_description(cls, value: str | None) -> str | None:
        return capitalize_first_letter(value) if value is not None else None


class TransactionSplitRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    category_id: int | None
    category: CategoryRead | None = None
    amount: Decimal
    note: str | None
    expense_asset_id: int | None = None
    assigned_period: date_ | None = None
    mandatory_payment_kind: MandatoryPaymentKind | None = None


class TransactionRead(TransactionFields):
    model_config = ConfigDict(from_attributes=True)

    id: int
    asset_id: int | None = None
    transfer_account: AccountRead | None = None
    account: AccountRead
    category: CategoryRead | None = None
    tags: list[TagRead] = Field(default_factory=list)
    splits: list[TransactionSplitRead] = Field(default_factory=list)


class TransactionPage(BaseModel):
    items: list[TransactionRead]
    total: int
    page: int
    page_size: int


class TransactionBulkCreate(BaseModel):
    """CSV import (see routes/transactions.py's /bulk): the frontend parses
    the file and maps its columns client-side, then sends already-shaped
    rows here. All-or-nothing — same failure semantics as backup restore, so
    a single bad row never leaves a partial import behind."""

    items: list[TransactionCreate] = Field(min_length=1, max_length=5000)


class TransactionBulkCreateResult(BaseModel):
    created: int
