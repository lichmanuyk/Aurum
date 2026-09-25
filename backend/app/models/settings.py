"""App-wide configuration that isn't tied to any single account/asset — a
single-row table (id is always 1). Primary display currency (see UPDATES.md
for why this doesn't do currency conversion) and the proactive-alert
thresholds consumed by services/insights_service.py."""
from decimal import Decimal

from sqlalchemy import Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class AppSettings(Base):
    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    # Consecutive complete months of negative cash flow / declining net worth
    # before insights_service.py raises the corresponding alert.
    negative_cash_flow_threshold_months: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    net_worth_decline_threshold_months: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    # Max % of total capital (cash + assets) allowed in medium/high risk
    # tiers before insights_service.py raises risky_allocation_exceeded —
    # the classic "80% at zero risk, 20% at most exposed" rule.
    risky_allocation_threshold_percent: Mapped[int] = mapped_column(Integer, nullable=False, default=20)
    # A depository account (checking/savings/cash) sitting at or above this
    # balance with no transaction touching it in idle_cash_threshold_days
    # raises insights_service.py's idle_cash alert — money that isn't
    # working. In the app's display currency (see `currency` above).
    idle_cash_threshold_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=Decimal("1000"))
    idle_cash_threshold_currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")
    idle_cash_threshold_days: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    # Display-only currency for the Dashboard/Net Worth/Crypto summaries —
    # independent of `currency` above (the ledger's primary/reporting
    # currency, which this never changes). NULL means "no explicit choice
    # yet"; the frontend resolves that to the primary currency, same as the
    # behavior before this setting existed. Restricted to PLN/USD/EUR at the
    # schema layer (see schemas/settings.py), not the full CURRENCIES list.
    summary_currency: Mapped[str | None] = mapped_column(String(3), nullable=True, default=None)
    # Per-section overrides — NULL means "inherit summary_currency". Each is
    # independent so e.g. Crypto can pin USD while Dashboard and Net Worth
    # keep following the general summary_currency setting.
    dashboard_currency: Mapped[str | None] = mapped_column(String(3), nullable=True, default=None)
    net_worth_currency: Mapped[str | None] = mapped_column(String(3), nullable=True, default=None)
    crypto_currency: Mapped[str | None] = mapped_column(String(3), nullable=True, default=None)
