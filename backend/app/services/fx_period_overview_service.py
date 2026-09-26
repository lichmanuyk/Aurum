"""Period-aware version of the Dashboard's compact FX rate card (see
docs/tasks/dashboard-fx-periods-sparklines.md, continuing PR #36's
`fx_rate_overview` in quote_status_service.py, which stays untouched for
backward compatibility with old consumers of GET /fx-rates/overview).

Reuses FXConverter's own single-leg lookup/carry-forward (the same 7-day-
back window, the same NBP-only filtering, the same base<quote storage
convention) as a stateless per-(currency, day) utility — but always through
a *fresh*, request-scoped instance, never the shared session-cached one
financial reports rely on (see FXConverter.load), and never through its own
pivot-cross feature (which ties both legs of a cross rate to the same day).
A USD/BYN or USD/RUB cross here is built from two *independent* USD→PLN and
BYN→PLN/RUB→PLN lookups instead, each resolving its own best day on its
own — so a BYN publication lagging behind that day's USD one doesn't freeze
the whole cross onto a stale week, and vice versa.
"""
from datetime import date, timedelta
from decimal import Decimal, localcontext

from fastapi import HTTPException
from sqlalchemy import select

from app.models.fx import FXRate
from app.services.dashboard_service import _resolve_bounds
from app.services.fx_service import FXConverter

# The four fixed pairs shown, regardless of settings.currency or the
# summary display-currency choice — see the task's own "Пары фиксированы
# по предпочтению пользователя" requirement. (base, quote) reads as
# "1 base = X quote".
FX_PERIOD_PAIRS: tuple[tuple[str, str], ...] = (("USD", "PLN"), ("EUR", "PLN"), ("USD", "BYN"), ("USD", "RUB"))
SPARKLINE_LATEST_DAYS = 30
LOOKBACK_DAYS = 7  # mirrors FXConverter.rate()'s own carry-forward window
DISPLAY_QUANTUM = Decimal("0.0001")


def _resolve_mode_and_label(year: int | None, month: int | None, today: date) -> tuple[str, str]:
    if year is None:
        return "latest", "latest"
    if month is not None:
        if year == today.year and month == today.month:
            return "latest", "latest"
        return "average", "average"
    if year == today.year:
        return "average", "ytd"
    return "average", "average"


def _leg_rate(fx: FXConverter, currency: str, day: date) -> tuple[Decimal, date] | None:
    """1 `currency` in PLN, on `day` — the actual date used can be up to
    LOOKBACK_DAYS earlier (weekend/holiday carry-forward, same rule
    FXConverter.rate() already applies). `None`, never an exception or a
    fabricated 0/1:1, when nothing resolves within that window.

    `fx.used` only ever *grows* (it's a set FXConverter itself never
    clears) — across a whole request's worth of days, many of them
    routinely carry forward to the exact same underlying publication, so
    the second and later such calls would add nothing "new" to diff
    against. Clearing it before each call keeps this read exact —
    nothing else in this module still needs the accumulated history."""
    fx.used.clear()
    try:
        rate = fx.rate(currency, "PLN", day)
    except HTTPException:
        return None
    actual_day = min((d for _, _, d in fx.used), default=day)
    return rate, actual_day


def _leg_source(rows_by_pair: dict[tuple[str, str, date], FXRate], currency: str, day: date) -> str | None:
    pair = tuple(sorted((currency, "PLN")))
    row = rows_by_pair.get((*pair, day))
    return row.source if row else None


async def get_fx_period_overview(session, year: int | None, month: int | None) -> dict:
    today = date.today()
    if year is not None and (year > today.year or (year == today.year and month is not None and month > today.month)):
        raise HTTPException(422, "Future period is not available yet")

    start_date, end_date = _resolve_bounds(year, month)
    mode, label = _resolve_mode_and_label(year, month, today)

    if mode == "latest":
        series_start, series_end = end_date - timedelta(days=SPARKLINE_LATEST_DAYS - 1), end_date
    else:
        series_start, series_end = start_date, end_date  # average's own chart covers the period itself

    currencies = sorted({c for pair in FX_PERIOD_PAIRS for c in pair} | {"PLN"})
    fetch_from = series_start - timedelta(days=LOOKBACK_DAYS)
    rows = (await session.scalars(select(FXRate).where(
        FXRate.source.like("NBP:%"),
        FXRate.rate_date >= fetch_from, FXRate.rate_date <= series_end,
        FXRate.base_currency.in_(currencies), FXRate.quote_currency.in_(currencies),
    ))).all()
    rows_by_pair = {(r.base_currency, r.quote_currency, r.rate_date): r for r in rows}
    fx = FXConverter(rows, "PLN")

    days = [series_start + timedelta(days=i) for i in range((series_end - series_start).days + 1)]

    items = []
    for base, quote in FX_PERIOD_PAIRS:
        series: list[dict] = []
        legs_by_day: dict[date, list[tuple[str, date]]] = {}
        for day in days:
            base_leg = _leg_rate(fx, base, day)
            quote_leg = None if quote == "PLN" else _leg_rate(fx, quote, day)
            if base_leg is None or (quote != "PLN" and quote_leg is None):
                series.append({"date": day, "value": None})
                continue
            base_rate, base_day = base_leg
            if quote == "PLN":
                value, legs = base_rate, [(base, base_day)]
            else:
                quote_rate, quote_day = quote_leg
                with localcontext() as ctx:
                    ctx.prec = 80
                    value = base_rate / quote_rate
                legs = [(base, base_day), (quote, quote_day)]
            series.append({"date": day, "value": value})
            legs_by_day[day] = legs

        available = [point["value"] for point in series if point["value"] is not None]
        coverage_expected, coverage_available = len(series), len(available)

        if mode == "latest":
            value = series[-1]["value"]
            unavailable = None if value is not None else "fx_rate_missing"
            legs_out = legs_by_day.get(days[-1], [])
        else:
            legs_out = []
            if coverage_expected > 0 and coverage_available == coverage_expected:
                with localcontext() as ctx:
                    ctx.prec = 80
                    value = sum(available, Decimal(0)) / coverage_available
                unavailable = None
            else:
                value = None
                unavailable = "fx_rate_missing" if coverage_available == 0 else "incomplete_coverage"

        items.append({
            "base_currency": base, "quote_currency": quote,
            # Rounded only here, for display — every value that fed the
            # average above (and every series point below) stays at full
            # precision, per the task's own "округление только для
            # вывода" requirement.
            "value": value.quantize(DISPLAY_QUANTUM) if value is not None else None,
            "unavailable_reason": unavailable,
            "legs": [
                {"currency": currency, "rate_date": leg_day, "source": _leg_source(rows_by_pair, currency, leg_day)}
                for currency, leg_day in legs_out
            ],
            "series": series,
            "coverage_expected_days": coverage_expected,
            "coverage_available_days": coverage_available,
        })

    return {
        "mode": mode, "label": label,
        "start_date": start_date, "end_date": end_date,
        "series_start": series_start, "series_end": series_end,
        "items": items,
    }
