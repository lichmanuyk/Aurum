"""Gross work income vs. mandatory ZUS/PPE/VAT payments, grouped by the
month they're *assigned* to — see docs/tasks/income-tax-separation.md.
Every amount here is the same already-FX-converted real cash figure every
other report uses (fx.transaction/fx.splits, resolved against the row's own
real `date`, never `period`); this view only regroups those real amounts by
assigned_period instead of by calendar month of the real cash date.
"""
from datetime import date as date_
from decimal import Decimal

from pydantic import BaseModel, Field

from app.models.enums import MandatoryPaymentKind


class IncomeTaxEntry(BaseModel):
    """One real transaction (or split line) contributing to a period —
    `date` is the real cash day (for drilldown to the ordinary ledger),
    deliberately distinct from the period it's grouped under here."""

    id: int
    split_id: int | None
    date: date_
    # None -> a gross work income line; set -> which mandatory payment.
    kind: MandatoryPaymentKind | None
    description: str
    account_id: int
    account_name: str
    account_currency: str
    native_amount: Decimal
    amount: Decimal


class IncomeTaxPeriod(BaseModel):
    period: date_
    gross_income: Decimal
    tax_paid_by_kind: dict[str, Decimal]
    tax_paid_total: Decimal
    # Deliberately named "after paid taxes", not "net income": VAT
    # inclusion in gross_income is unresolved (see
    # docs/tasks/income-tax-separation.md) and not every mandatory payment
    # for this period may exist yet — see income_received/all_taxes_known
    # below. Never presented as a final number until gross_income is
    # actually received for this period.
    net_after_paid_taxes: Decimal
    # False -> gross_income is 0 (or partial) while a mandatory payment for
    # this period already exists — taxes paid, income still pending. The
    # frontend must not read this period's net as a final loss just
    # because tax_paid_total > 0 with nothing received yet.
    income_received: bool
    entries: list[IncomeTaxEntry]


class IncomeTaxReport(BaseModel):
    fx_rates_used: list[dict[str, str]] = Field(default_factory=list)
    reporting_currency: str
    year: int | None
    month: int | None
    periods: list[IncomeTaxPeriod]
    total: int
    page: int
    page_size: int
