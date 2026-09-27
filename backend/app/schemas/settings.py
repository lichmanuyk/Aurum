from app.core.money import Currency
from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.clock import business_today
from app.core.config import APP_VERSION, get_settings

# The Dashboard/Net Worth/Crypto display-currency feature deliberately
# offers only these three, not the full CURRENCIES list `Currency` allows —
# a curated set for the one user this fork is built for, not a general
# currency picker. See docs/tasks/display-currency-preferences.md.
DisplayCurrency = Literal["PLN", "USD", "EUR"]


class AppSettingsRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    currency: Currency
    negative_cash_flow_threshold_months: int
    net_worth_decline_threshold_months: int
    risky_allocation_threshold_percent: int
    idle_cash_threshold_amount: Decimal
    idle_cash_threshold_currency: str
    idle_cash_threshold_days: int
    # General display currency for the three summary pages. None = no
    # explicit choice yet — the frontend falls back to `currency` above.
    summary_currency: DisplayCurrency | None = None
    # Per-page overrides. None = inherit summary_currency.
    dashboard_currency: DisplayCurrency | None = None
    net_worth_currency: DisplayCurrency | None = None
    crypto_currency: DisplayCurrency | None = None
    cash_flow_currency: DisplayCurrency | None = None
    reports_currency: DisplayCurrency | None = None
    # Not a stored column: the default fills itself in when FastAPI validates
    # the ORM row against this model, so neither route has to assemble it.
    # It lives on this (authenticated) response rather than on /api/health,
    # which is deliberately unauthenticated and so would hand the running
    # version to anyone who can reach the instance.
    app_version: str = APP_VERSION
    # Also not a stored column, same "fills in on validation" shape as
    # app_version above, but a `default_factory` (not a plain `=`) is
    # required here: this is a fresh reading of the server's current
    # business day (see app/core/clock.py) — a plain default would freeze
    # onto whatever day the process happened to import this module, and
    # never advance. The frontend's useBusinessDate() hook (see
    # docs/tasks/business-date-timezone.md) treats this GET /api/settings
    # response as the one place it reads "what day is it" from — never the
    # browser's own Date(). Same authenticated-only reasoning as app_version.
    business_date: date = Field(default_factory=business_today)
    business_timezone: str = Field(default_factory=lambda: get_settings().business_timezone)


class AppSettingsUpdate(BaseModel):
    """All fields optional — the route applies a partial update
    (`exclude_unset`), same as CategoryUpdate, so a single-field PATCH from
    e.g. CurrencyCard doesn't need to resend the alert thresholds."""

    # ISO 4217 code, e.g. "USD"/"UAH"/"EUR" — the frontend only ever sends
    # values from its curated currency list, but validate the shape anyway
    # since Intl.NumberFormat would otherwise silently accept garbage.
    currency: Currency | None = Field(default=None, min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    # Consecutive complete months before the corresponding alert fires.
    # Capped at 24 to match insights_service.py's MAX_LOOKBACK_MONTHS.
    negative_cash_flow_threshold_months: int | None = Field(default=None, ge=1, le=24)
    net_worth_decline_threshold_months: int | None = Field(default=None, ge=1, le=24)
    # Max % of capital allowed in medium/high risk tiers (the 80/20 rule's
    # "20% at most exposed" half) before risky_allocation_exceeded fires.
    risky_allocation_threshold_percent: int | None = Field(default=None, ge=1, le=100)
    # Balance (in the app's display currency) and days of no activity a
    # depository account needs to hit before idle_cash fires.
    idle_cash_threshold_amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    idle_cash_threshold_currency: Currency | None = None
    idle_cash_threshold_days: int | None = Field(default=None, ge=1, le=365)
    # These are the only fields where an explicitly-sent null is meaningful
    # (reset to "no choice"/"inherit") rather than rejected — see
    # NULLABLE_DISPLAY_CURRENCY_FIELDS in api/routes/settings.py.
    summary_currency: DisplayCurrency | None = None
    dashboard_currency: DisplayCurrency | None = None
    net_worth_currency: DisplayCurrency | None = None
    crypto_currency: DisplayCurrency | None = None
    cash_flow_currency: DisplayCurrency | None = None
    reports_currency: DisplayCurrency | None = None
