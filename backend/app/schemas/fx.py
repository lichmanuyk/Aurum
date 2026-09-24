from datetime import date
from decimal import Decimal
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
