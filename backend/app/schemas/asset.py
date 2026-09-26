from app.core.money import Currency
from datetime import date as date_
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import AssetClass, CapitalRole, RiskLevel


class AssetValuationCreate(BaseModel):
    value: Decimal = Field(ge=0, max_digits=14, decimal_places=2)
    as_of_date: date_ = Field(default_factory=date_.today)


class AssetValuationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    value: Decimal
    as_of_date: date_


class AssetBase(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    asset_class: AssetClass
    currency: Currency = Field(default="USD", min_length=3, max_length=3)
    notes: str | None = Field(default=None, max_length=2000)
    capital_role: CapitalRole = CapitalRole.NEUTRAL
    # Rough self-reported monthly net cash flow — informational, not tracked
    # transactions (see Asset.monthly_cash_flow).
    monthly_cash_flow: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    risk_level: RiskLevel = RiskLevel.MEDIUM


class AssetCreate(AssetBase):
    value: Decimal = Field(ge=0, max_digits=14, decimal_places=2)
    as_of_date: date_ = Field(default_factory=date_.today)


class AssetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=150)
    asset_class: AssetClass | None = None
    currency: Currency | None = Field(default=None, min_length=3, max_length=3)
    notes: str | None = Field(default=None, max_length=2000)
    capital_role: CapitalRole | None = None
    monthly_cash_flow: Decimal | None = Field(default=None, max_digits=14, decimal_places=2)
    risk_level: RiskLevel | None = None


class AssetRead(AssetBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    current_value: Decimal
    as_of_date: date_
    # Read-only, additive — existing consumers that only read current_value/
    # currency (native amount, unchanged semantics) are unaffected. The
    # equivalent reuses the exact same FXConverter/date net_worth_service
    # uses for this asset's contribution to the capital summary (see
    # list_assets in api/routes/assets.py), not a new client-side rate or a
    # separately-determined "today" — so it's directly comparable across
    # assets in different native currencies, and matches the summary total.
    # `None` (with `capital_value_error` set) when there's nothing to
    # convert — never a fabricated 0 or a silent 1:1 guess.
    capital_value: Decimal | None = None
    capital_currency: str
    capital_value_error: Literal["no_valuation", "fx_rate_missing"] | None = None
