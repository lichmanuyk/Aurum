from pydantic import Field
from datetime import date as date_
from decimal import Decimal

from pydantic import BaseModel


class CashFlowPoint(BaseModel):
    year: int
    month: int
    income: Decimal
    # Every real cash EXPENSE this month, mandatory tax payments included —
    # unchanged in meaning from before mandatory-tax classification existed
    # (see docs/tasks/income-tax-separation.md).
    expense: Decimal
    # This same month's share of `expense` that was a classified ZUS/PPE/
    # VAT payment — an explicit breakdown, not a second deduction: it is
    # already included in `expense` above, never subtracted from it.
    tax_expense: Decimal
    net: Decimal


class CashFlowResponse(BaseModel):
    fx_rates_used: list[dict[str, str]] = Field(default_factory=list)
    reporting_currency: str
    start_date: date_ | None
    end_date: date_ | None
    points: list[CashFlowPoint]
    total_income: Decimal
    total_expense: Decimal
    total_tax_expense: Decimal
    total_net: Decimal
