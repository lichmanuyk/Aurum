from datetime import date
from decimal import Decimal
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from app.core.money import Currency


class FXRateInput(BaseModel):
    base_currency: Currency
    quote_currency: Currency
    rate_date: date
    rate: Decimal = Field(gt=0, max_digits=38, decimal_places=18)
    source: str = Field(default="manual", min_length=1, max_length=50)

    @model_validator(mode="after")
    def different_currencies(self):
        if self.base_currency == self.quote_currency:
            raise ValueError("FX currencies must differ")
        return self


class FXRateRead(FXRateInput):
    model_config = ConfigDict(from_attributes=True)
    id: int


class FXRateBatch(BaseModel):
    items: list[FXRateInput] = Field(min_length=1, max_length=10000)


class FxPeriodLeg(BaseModel):
    """One currency's own PLN leg contributing to a pair's value — a direct
    pair (e.g. USD/PLN) has exactly one; a cross pair (USD/BYN, USD/RUB) has
    two, each with its *own* actual publication date/source, which can (and
    routinely does) differ between the two legs — see
    docs/tasks/dashboard-fx-periods-sparklines.md."""

    currency: str
    rate_date: date
    source: str


class FxPeriodSeriesPoint(BaseModel):
    date: date
    # null = no official rate resolved for this day (even after the usual
    # 7-day carry-forward) — never a fabricated 0/1:1, and never connected
    # across in the chart.
    value: Decimal | None


class FxPeriodPair(BaseModel):
    base_currency: str
    quote_currency: str
    # The headline "1 base = value quote" figure — null when unavailable
    # (see unavailable_reason), never a guess.
    value: Decimal | None
    unavailable_reason: Literal["fx_rate_missing", "incomplete_coverage"] | None
    # Only populated for a genuinely available `value` in "latest" mode —
    # an average's "date" would misrepresent one of many days it covers, so
    # legs stay empty there; the period/label already say "average"/"ytd".
    legs: list[FxPeriodLeg]
    series: list[FxPeriodSeriesPoint]
    coverage_expected_days: int
    coverage_available_days: int


class FxRatePeriodOverview(BaseModel):
    mode: Literal["latest", "average"]
    label: Literal["latest", "average", "ytd"]
    start_date: date | None
    end_date: date
    series_start: date
    series_end: date
    items: list[FxPeriodPair]


class NBPImport(BaseModel):
    start_date: date
    end_date: date
    currencies: list[Currency] = Field(min_length=1, max_length=38)

    @model_validator(mode='after')
    def valid_range(self):
        if self.start_date < date(2002,1,2) or self.end_date > date.today() or not 0 <= (self.end_date-self.start_date).days < 93:
            raise ValueError('NBP interval must be 1–93 days, since 2002-01-02, with no future dates')
        if len(set(self.currencies)) != len(self.currencies):
            raise ValueError('Duplicate currencies')
        return self
