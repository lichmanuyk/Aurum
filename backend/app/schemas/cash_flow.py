from pydantic import Field
from datetime import date as date_
from decimal import Decimal

from pydantic import BaseModel


class CashFlowPoint(BaseModel):
    year: int
    month: int
    income: Decimal
    expense: Decimal
    net: Decimal


class CashFlowResponse(BaseModel):
    fx_rates_used: list[dict[str, str]] = Field(default_factory=list)
    reporting_currency: str
    start_date: date_ | None
    end_date: date_ | None
    points: list[CashFlowPoint]
    total_income: Decimal
    total_expense: Decimal
    total_net: Decimal
