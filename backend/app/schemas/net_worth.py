from pydantic import Field
from datetime import date as date_
from decimal import Decimal

from pydantic import BaseModel


class NetWorthPoint(BaseModel):
    date: date_
    value: Decimal


class NetWorthBreakdownItem(BaseModel):
    key: str
    name: str
    color: str
    icon: str
    amount: Decimal
    percent: float


class CapitalRoleSummary(BaseModel):
    """Assets grouped by how they behave month to month (see CapitalRole) —
    a cross-cut of the asset-class breakdown, not a replacement for it."""

    role: str
    label: str
    color: str
    total_value: Decimal
    monthly_cash_flow: Decimal
    count: int


class RiskLevelItem(BaseModel):
    """One holding within a risk tier — Cash (key="cash") or a single asset
    (key=f"asset:{id}"). This list IS the diversification view: a tier with
    one item at 100% is concentrated, several items with even shares aren't,
    no separate score needed."""

    key: str
    name: str
    amount: Decimal
    percent: float  # share of this tier, not of total capital


class RiskLevelSummary(BaseModel):
    """Cash + assets grouped by user-tagged risk of loss (see RiskLevel) —
    another cross-cut, like capital_roles, but Cash participates here since
    it's the zero-risk anchor an 80/20-style allocation rule needs."""

    risk_level: str
    label: str
    color: str
    total_value: Decimal
    percent: float  # share of total capital (cash + assets)
    items: list[RiskLevelItem]


class NetWorthSummary(BaseModel):
    fx_rates_used: list[dict[str, str]] = Field(default_factory=list)
    reporting_currency: str
    range: str
    # cash + assets + total_receivables - total_liabilities — see
    # docs/tasks/debt-tracking.md and net_worth_service.get_net_worth_summary.
    current: Decimal
    change_amount: Decimal
    change_percent: float | None
    series: list[NetWorthPoint]
    # Receivables (owed_to_me debts) join this as their own positive
    # class-like slice (key="receivables"); liabilities deliberately never
    # appear here — see total_liabilities below and
    # get_net_worth_summary's own comment on why a negative donut slice
    # would misrepresent money owed rather than surface it.
    breakdown: list[NetWorthBreakdownItem]
    capital_roles: list[CapitalRoleSummary]
    risk_levels: list[RiskLevelSummary]
    # Today's total across every owed_to_me/owed_by_me Debt, in
    # reporting_currency — the same figures already folded into
    # `current`/`series` above, surfaced explicitly so the UI can show
    # liabilities as their own clearly-negative callout instead of
    # silently dropping them from the capital view.
    total_receivables: Decimal
    total_liabilities: Decimal
