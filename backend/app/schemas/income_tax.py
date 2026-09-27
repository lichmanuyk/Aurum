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
    # Deliberately named "after paid taxes", never "net income": gross_income
    # already includes VAT — the user's own agreed bookkeeping (see "Модель"
    # in docs/tasks/income-tax-separation.md) — and it is never deducted a
    # second time here. Always preliminary, even once income_received below
    # is True: this app never registers an invoice or an expected total to
    # check completeness against, so there is no way to know every mandatory
    # payment this worked month will ever have has actually landed yet —
    # more ZUS/PPE/VAT for the same assigned_period can still show up later.
    net_after_paid_taxes: Decimal
    # False -> gross_income is still 0 while a mandatory payment for this
    # period already exists — taxes paid, income still pending; the
    # frontend must not read this period's net as a final loss. True only
    # means *some* gross income for this period has been recorded, never
    # that every expected payment for it is already in too (see
    # net_after_paid_taxes above) — there is deliberately no separate
    # "all taxes known" flag or status engine (see "Контекст и принятые
    # решения" in docs/tasks/income-tax-separation.md).
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
    # Every calendar year any assigned_period (its own, or any split line's)
    # ever falls in across the *whole* ledger — never narrowed by this
    # request's own year/month/page (see get_income_tax_report), and never
    # resolved through FX, so a currency with no rate for some unrelated
    # period can't affect it either. Lets the frontend's Year picker offer
    # every year that actually has classified data, independent of what's
    # currently selected or which page of periods is being shown right now
    # — see the read-only review that found the picker was previously
    # driven by real transaction dates (GET /transactions/years) instead,
    # which could hide a year whose only activity was assigned there from a
    # different real-dated year (docs/tasks/income-tax-separation.md's own
    # "worked in December, paid in January" example, just across a year
    # boundary).
    available_years: list[int] = Field(default_factory=list)
