"""Deterministic, offline, request-scoped historical FX resolution."""
from datetime import date, timedelta
from decimal import Decimal, localcontext, ROUND_FLOOR
from fastapi import HTTPException
from sqlalchemy import select
from app.core.money import rounded, quantum
from app.models.fx import FXRate
from app.services.settings_service import get_or_create_app_settings


class FXConverter:
    def __init__(self, rates, currency):
        self.currency = currency
        self.rates = {(r.base_currency, r.quote_currency, r.rate_date): r.rate for r in rates}
        self.sources = {(r.base_currency, r.quote_currency, r.rate_date): getattr(r, "source", "manual") for r in rates}
        self.used = set()

    @classmethod
    async def load(cls, session):
        if "fx_converter" in session.info:
            return session.info["fx_converter"]
        settings = await get_or_create_app_settings(session)
        converter = cls((await session.scalars(select(FXRate))).all(), settings.currency)
        session.info["fx_converter"] = converter
        return converter

    def metadata(self):
        return [{"base_currency": a, "quote_currency": b, "rate_date": str(day), "source": self.sources.get((*sorted((a,b)),day), "manual")} for a, b, day in sorted(self.used)]

    def _leg(self, source, target, day):
        if source == target:
            return Decimal(1)
        pair = tuple(sorted((source, target)))
        rate = self.rates.get((*pair, day))
        return rate if source == pair[0] or rate is None else Decimal(1) / rate

    def rate(self, source: str, target: str, day: date) -> Decimal:
        if source == target:
            return Decimal(1)
        with localcontext() as ctx:
            ctx.prec = 80
            for offset in range(8):
                actual = day - timedelta(days=offset)
                rate = self._leg(source, target, actual)
                legs = [(source, target, actual)]
                if rate is None:
                    for pivot in ("USD", "PLN"):
                        if pivot in (source, target):
                            continue
                        left, right = self._leg(source, pivot, actual), self._leg(pivot, target, actual)
                        if left is not None and right is not None:
                            rate = left * right
                            legs = [(source, pivot, actual), (pivot, target, actual)]
                            break
                if rate is not None:
                    self.used.update(legs)
                    return rate
        raise HTTPException(409, detail={"code": "FX_RATE_MISSING", "base_currency": source,
                                        "quote_currency": target, "date": day.isoformat(), "max_age_days": 7})

    def convert(self, amount, source, day, target=None, *, quantize=True):
        target = target or self.currency
        if not amount:
            return Decimal(0)
        with localcontext() as ctx:
            ctx.prec = 80
            value = amount * self.rate(source, target, day)
            return rounded(value, target) if quantize else value

    def transaction(self, tx, target=None):
        if tx.reporting_amount_override is not None:
            if (target or self.currency) == tx.reporting_currency_override:
                return tx.reporting_amount_override
            return self.convert(tx.reporting_amount_override, tx.reporting_currency_override, tx.date, target)
        if (target or self.currency) == tx.account.currency:
            return tx.amount
        return self.convert(tx.amount, tx.account.currency, tx.date, target)

    def splits(self, tx, target=None):
        """Allocate the rounded parent total; largest remainders allocate rounding residual."""
        total = self.transaction(tx, target)
        unit = min(quantum(target or self.currency), Decimal(1).scaleb(total.as_tuple().exponent))
        with localcontext() as ctx:
            ctx.prec = 80
            exact = [total * split.amount / tx.amount for split in tx.splits]
            values = [(value / unit).to_integral_value(rounding=ROUND_FLOOR) * unit for value in exact]
            remaining = int((total - sum(values)) / unit)
            order = sorted(range(len(values)), key=lambda i: (-(exact[i] - values[i]), i))
            for i in order[:remaining]:
                values[i] += unit
        return [(split.category_id, value) for split, value in zip(tx.splits, values)]
