"""Shared enum types used by the ORM models and API schemas."""
import enum


class AccountType(str, enum.Enum):
    CHECKING = "checking"
    DEBIT_CARD = "debit_card"
    SAVINGS = "savings"
    CREDIT_CARD = "credit_card"
    CASH = "cash"
    INVESTMENT = "investment"
    OTHER = "other"


class CategoryKind(str, enum.Enum):
    INCOME = "income"
    EXPENSE = "expense"


class TransactionType(str, enum.Enum):
    INCOME = "income"
    EXPENSE = "expense"
    TRANSFER = "transfer"
    ADJUSTMENT = "adjustment"
    ASSET_BUY = "asset_buy"
    ASSET_SELL = "asset_sell"


class AssetClass(str, enum.Enum):
    """Net-worth categories tracked manually (Cash is derived from Account
    balances instead — see services/net_worth_service.py)."""

    INVESTMENTS = "investments"
    CRYPTO = "crypto"
    REAL_ESTATE = "real_estate"
    VEHICLES = "vehicles"
    PRECIOUS_METALS = "precious_metals"
    OTHER = "other"


class CapitalRole(str, enum.Enum):
    """How an asset behaves month to month — set by the user, not inferred:
    the same laptop can be a productive work tool (NEUTRAL) or dead weight
    (DRAIN) depending on how it's actually used, which isn't derivable from
    any stored data."""

    INCOME = "income"  # e.g. a rented-out apartment
    NEUTRAL = "neutral"  # e.g. a laptop used for work, furniture
    DRAIN = "drain"  # e.g. a personal car, an idle depreciating gadget


class RecurringFrequency(str, enum.Enum):
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    YEARLY = "yearly"


class MandatoryPaymentKind(str, enum.Enum):
    """A self-employed user's own mandatory monthly payments in Poland — see
    docs/tasks/income-tax-separation.md. Names the user's own bookkeeping
    label, not a computed tax rule: this app never calculates what any of
    these *should* be, only records what was actually paid. VAT is kept
    under its own name even though the user's own historical records also
    call the same monthly VAT declaration "VAT-7" (the Polish form number,
    an old habit, not a distinct kind) — the free-text description field
    is where that older label still lives if the user wants to keep typing
    it; the classification itself only ever needs the three kinds below.
    Deliberately a closed, tiny set (not a free-form string): expanding the
    user's own reporting-currency-override "source" pattern here would let
    a typo silently create a new, never-aggregated "kind" with no warning."""

    ZUS = "zus"
    PPE = "ppe"
    VAT = "vat"


class CryptoTransactionType(str, enum.Enum):
    OPENING = "opening"
    BUY = "buy"
    SELL = "sell"


class RiskLevel(str, enum.Enum):
    """Risk of loss, not asset class — set by the user, not inferred: real
    estate can be a paid-off primary home (LOW) or a leveraged rental
    (HIGH), the same asset_class doesn't determine which. Cash is always
    LOW (see services/net_worth_service.py) — it's the zero-risk anchor an
    80/20-style allocation rule is measured against."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
