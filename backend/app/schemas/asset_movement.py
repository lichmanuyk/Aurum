"""One atomic cash leg paired with an asset or crypto-position change."""
from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class AssetMovementInput(BaseModel):
    asset_id: int
    account_id: int
    type: Literal["buy", "sell"]
    gross_amount: Decimal = Field(gt=0, max_digits=18, decimal_places=6)
    fee_amount: Decimal = Field(default=Decimal(0), ge=0, max_digits=18, decimal_places=6)
    # Manual assets have an explicit value after the trade; crypto derives
    # value from quantity and the last known market price instead.
    asset_value_after: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    quantity: Decimal | None = Field(default=None, gt=0, max_digits=38, decimal_places=18)
    price_per_unit: Decimal | None = Field(default=None, gt=0, max_digits=38, decimal_places=18)
    date: date
    note: str | None = Field(default=None, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=64)

    @model_validator(mode="after")
    def check_fields(self):
        if self.type == "sell" and self.fee_amount >= self.gross_amount:
            raise ValueError("Sale fee must be smaller than proceeds")
        if (self.quantity is None) != (self.price_per_unit is None):
            raise ValueError("Quantity and price per unit must be provided together")
        return self


class AssetMovementRead(BaseModel):
    id: int
    asset_id: int
    asset_name: str
    account_id: int
    account_name: str
    account_currency: str
    asset_currency: str
    type: Literal["buy", "sell"]
    gross_amount: Decimal
    fee_amount: Decimal
    cash_amount: Decimal
    asset_value_after: Decimal | None
    quantity: Decimal | None
    price_per_unit: Decimal | None
    date: date
    note: str | None
    idempotency_key: str
