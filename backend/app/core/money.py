"""Shared fiat units; never use binary floats for posting or conversion."""
from decimal import Decimal, ROUND_HALF_EVEN, localcontext
from typing import Annotated
from pydantic import AfterValidator

CURRENCIES = frozenset("AED AMD AUD AZN BRL BYN CAD CHF CNY CZK EUR GBP GEL HKD HUF IDR ILS INR JPY KGS KRW KZT MDL MXN NZD PLN RON RUB SAR SGD THB TJS TMT TRY UAH USD UZS ZAR".split())
ZERO_MINOR = {"JPY", "KRW"}


def currency_code(value: str) -> str:
    if value not in CURRENCIES:
        raise ValueError("Unsupported currency; use an uppercase supported ISO code")
    return value


Currency = Annotated[str, AfterValidator(currency_code)]


def quantum(currency: str) -> Decimal:
    currency_code(currency)
    return Decimal("1") if currency in ZERO_MINOR else Decimal("0.01")


def rounded(amount: Decimal, currency: str) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = 80
        return amount.quantize(quantum(currency), rounding=ROUND_HALF_EVEN)


def validate_money(amount: Decimal, currency: str) -> None:
    if not amount.is_finite() or abs(amount) >= Decimal("1000000000000") or rounded(amount, currency) != amount:
        raise ValueError("Amount exceeds the currency precision or supported range")


def validate_ledger_money(amount: Decimal, currency: str) -> None:
    """Preserve sub-cent ledger facts; currency rounding is a presentation policy."""
    currency_code(currency)
    unit = Decimal("1") if currency in ZERO_MINOR else Decimal("0.000001")
    if not amount.is_finite() or abs(amount) >= Decimal("1000000000000") or amount % unit:
        raise ValueError("Ledger amount exceeds supported precision or range")


def require_ledger_money(amount: Decimal, currency: str) -> None:
    from fastapi import HTTPException
    try:
        validate_ledger_money(amount, currency)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def adjustment_rule_violation(kind, amount, reason, category_id=None):
    if kind == "adjustment":
        if amount is None or amount == 0 or reason not in {"opening_balance", "reconciliation", "migration"} or category_id is not None:
            return "Adjustment requires a nonzero signed amount, a reason and no category"
    elif amount is None or amount <= 0 or reason is not None:
        return "Income, expense and transfer require a positive amount and no adjustment reason"
    return None


def require_money(amount: Decimal, currency: str) -> None:
    from fastapi import HTTPException
    try:
        validate_money(Decimal(amount), currency)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
