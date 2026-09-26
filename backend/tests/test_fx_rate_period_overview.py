"""Dashboard's period-aware FX card (see
docs/tasks/dashboard-fx-periods-sparklines.md, continuing PR #36's
fx_rate_overview) — GET /fx-rates/overview/period. The old endpoint's own
contract/tests (test_fx_rate_overview.py) stay untouched; this file only
covers the new, fixed-four-pair, period-reactive one.
"""
from datetime import date, timedelta
from decimal import Decimal

from tests.test_fx_rate_overview import nbp_rate
from tests.test_multicurrency import account, tx


def prior_month(today: date) -> tuple[int, int]:
    return (today.year - 1, 12) if today.month == 1 else (today.year, today.month - 1)


def by_pair(body: dict, base: str, quote: str) -> dict:
    return next(i for i in body["items"] if i["base_currency"] == base and i["quote_currency"] == quote)


async def test_latest_mode_reports_all_four_pairs_with_their_own_legs(client):
    today = date.today()
    await nbp_rate(client, "USD", today, "4.0000")
    await nbp_rate(client, "EUR", today, "4.3000")
    await nbp_rate(client, "BYN", today, "1.2500", table="B")
    await nbp_rate(client, "RUB", today - timedelta(days=1), "0.0400", table="B")

    body = (await client.get("/fx-rates/overview/period")).json()
    assert body["mode"] == "latest" and body["label"] == "latest"

    usd_pln = by_pair(body, "USD", "PLN")
    assert Decimal(usd_pln["value"]) == Decimal("4.0000")
    assert usd_pln["legs"] == [{"currency": "USD", "rate_date": str(today), "source": "NBP:A:1/A/NBP/2026"}]

    eur_pln = by_pair(body, "EUR", "PLN")
    assert Decimal(eur_pln["value"]) == Decimal("4.3000")

    usd_byn = by_pair(body, "USD", "BYN")
    assert Decimal(usd_byn["value"]) == Decimal("3.2000")  # 4.0 / 1.25
    assert {leg["currency"] for leg in usd_byn["legs"]} == {"USD", "BYN"}
    assert next(leg for leg in usd_byn["legs"] if leg["currency"] == "BYN")["rate_date"] == str(today)

    usd_rub = by_pair(body, "USD", "RUB")
    assert Decimal(usd_rub["value"]) == Decimal("100.0000")  # 4.0 / 0.04
    # RUB's own leg keeps its *actual* (carried-forward) publication date —
    # never silently promoted to today's USD date.
    assert next(leg for leg in usd_rub["legs"] if leg["currency"] == "RUB")["rate_date"] == str(today - timedelta(days=1))


async def test_cross_rate_uses_independent_leg_dates_not_frozen_to_the_weekly_pivot_day(client):
    """The exact scenario the task calls out: USD changes between two BYN
    weekly (table B) publications — the cross must pick up the *new* USD
    leg, not silently re-use whatever day BYN's own leg pivoted on."""
    today = date.today()
    stale_day = today - timedelta(days=2)
    await nbp_rate(client, "USD", stale_day, "4.0000")
    await nbp_rate(client, "BYN", stale_day, "1.2500", table="B")
    # A fresh daily USD publication with nothing new from BYN's weekly table.
    await nbp_rate(client, "USD", today, "4.2000")

    body = (await client.get("/fx-rates/overview/period")).json()
    usd_byn = by_pair(body, "USD", "BYN")
    # Correct: today's USD (4.2) over BYN's carried-forward leg (1.25).
    assert Decimal(usd_byn["value"]) == Decimal("3.3600")
    # Wrong-but-plausible alternative a naive "freeze to BYN's day" bug
    # would produce (4.0 / 1.25) — must NOT be what we got.
    assert Decimal(usd_byn["value"]) != Decimal("3.2000")
    legs = {leg["currency"]: leg["rate_date"] for leg in usd_byn["legs"]}
    assert legs["USD"] == str(today)
    assert legs["BYN"] == str(stale_day)


async def test_leg_older_than_the_carry_forward_window_is_unavailable_but_neighbours_remain(client):
    today = date.today()
    await nbp_rate(client, "USD", today, "4.0000")
    # BYN's only publication is 8 days old — one day past the 7-day
    # carry-forward limit shared with FXConverter.
    await nbp_rate(client, "BYN", today - timedelta(days=8), "1.2500", table="B")

    body = (await client.get("/fx-rates/overview/period")).json()
    usd_byn = by_pair(body, "USD", "BYN")
    assert usd_byn["value"] is None
    assert usd_byn["unavailable_reason"] == "fx_rate_missing"
    # The unrelated, fully available pair is untouched by BYN's gap.
    usd_pln = by_pair(body, "USD", "PLN")
    assert Decimal(usd_pln["value"]) == Decimal("4.0000")


async def test_manual_rate_is_never_used_as_an_official_leg(client):
    today = date.today()
    await nbp_rate(client, "USD", today, "4.0000")
    manual = await client.post("/fx-rates/bulk", json={"items": [dict(
        base_currency="BYN", quote_currency="PLN", rate_date=str(today), rate="1.2500",
    )]})
    assert manual.status_code == 200, manual.text

    body = (await client.get("/fx-rates/overview/period")).json()
    usd_byn = by_pair(body, "USD", "BYN")
    assert usd_byn["value"] is None
    assert usd_byn["unavailable_reason"] == "fx_rate_missing"


async def test_average_mode_for_a_past_month_averages_calendar_days_with_weekend_carry_forward(client):
    import calendar

    year, month = prior_month(date.today())
    start = date(year, month, 1)
    days_in_month = calendar.monthrange(year, month)[1]
    end = date(year, month, days_in_month)
    # A publication every 6 days is well within the shared 7-day
    # carry-forward window, so every calendar day of the month — including
    # weekends/holidays with no publication of their own — resolves to the
    # same constant rate; a genuine average of a constant is that constant,
    # which keeps this test's own arithmetic trivial to check by hand.
    day = start
    no = 1
    while day <= end:
        await nbp_rate(client, "USD", day, "4.0000", no=f"{no}/A/NBP/x")
        day += timedelta(days=6)
        no += 1

    body = (await client.get(f"/fx-rates/overview/period?year={year}&month={month}")).json()
    assert body["mode"] == "average" and body["label"] == "average"
    assert body["start_date"] == str(start) and body["end_date"] == str(end)

    usd_pln = by_pair(body, "USD", "PLN")
    assert usd_pln["unavailable_reason"] is None
    assert usd_pln["coverage_available_days"] == usd_pln["coverage_expected_days"] == days_in_month
    assert Decimal(usd_pln["value"]) == Decimal("4.0000")
    assert all(point["value"] is not None for point in usd_pln["series"])


async def test_incomplete_average_coverage_is_explicit_never_a_partial_average(client):
    year, month = prior_month(date.today())
    start = date(year, month, 1)
    # Only the first half of the month has any publication at all — the
    # second half has nothing to carry forward from (first-ever data lands
    # mid-period), so the average can't cover every day.
    await nbp_rate(client, "USD", start + timedelta(days=3), "4.0000")

    body = (await client.get(f"/fx-rates/overview/period?year={year}&month={month}")).json()
    usd_pln = by_pair(body, "USD", "PLN")
    assert usd_pln["value"] is None
    assert usd_pln["unavailable_reason"] == "incomplete_coverage"
    assert usd_pln["coverage_available_days"] < usd_pln["coverage_expected_days"]
    # No fabricated points in the series either.
    assert any(point["value"] is None for point in usd_pln["series"])


async def test_ytd_mode_averages_from_start_of_year_to_today(client):
    today = date.today()
    start = date(today.year, 1, 1)
    # A publication every 6 days (within the 7-day carry-forward window)
    # across the whole year-to-date, so the average has full coverage.
    day, no = start, 1
    while day <= today:
        await nbp_rate(client, "USD", day, "4.0000", no=f"{no}/A/NBP/x")
        day += timedelta(days=6)
        no += 1

    body = (await client.get(f"/fx-rates/overview/period?year={today.year}")).json()
    assert body["mode"] == "average" and body["label"] == "ytd"
    assert body["start_date"] == str(start)
    assert body["end_date"] == str(today)
    usd_pln = by_pair(body, "USD", "PLN")
    assert usd_pln["unavailable_reason"] is None
    assert Decimal(usd_pln["value"]) == Decimal("4.0000")


async def test_future_period_is_rejected(client):
    response = await client.get(f"/fx-rates/overview/period?year={date.today().year + 1}")
    assert response.status_code == 422


async def test_month_without_year_is_rejected_not_defaulted_to_the_current_year(client):
    # Unlike the Dashboard summary route, this card only ever sends
    # year/month together — a lone month must be an explicit 422, never a
    # silent "current year" guess.
    response = await client.get("/fx-rates/overview/period?month=5")
    assert response.status_code == 422


async def test_out_of_range_month_is_a_422_not_a_500(client):
    for month in (0, 13, -1):
        response = await client.get(f"/fx-rates/overview/period?year={date.today().year}&month={month}")
        assert response.status_code == 422, (month, response.text)


async def test_out_of_range_year_is_a_422_not_a_500(client):
    for year in (1999, 2101):
        response = await client.get(f"/fx-rates/overview/period?year={year}")
        assert response.status_code == 422, (year, response.text)


async def test_get_makes_no_writes_and_leaves_money_reports_untouched(client):
    today = date.today()
    await nbp_rate(client, "USD", today, "4.0000")
    usd_account, pln_account = await account(client, "USD"), await account(client, "PLN")
    await tx(client, usd_account, type="income", amount="1000", date=str(today))
    first = await tx(client, usd_account, type="transfer", transfer_account_id=pln_account,
                     amount="100", destination_amount="360", date=str(today))
    second = await tx(client, usd_account, type="transfer", transfer_account_id=pln_account,
                      amount="100", destination_amount="380", date=str(today))

    before_rates = (await client.get("/fx-rates")).json()
    before_backup = (await client.get("/backup/export")).json()

    for _ in range(3):
        assert (await client.get("/fx-rates/overview/period")).status_code == 200

    assert (await client.get("/fx-rates")).json() == before_rates
    after_backup = (await client.get("/backup/export")).json()
    for key in ("accounts", "transactions", "fx_rates"):
        assert after_backup[key] == before_backup[key]
    transfers = {row["id"]: row for row in after_backup["transactions"]}
    assert Decimal(transfers[first["id"]]["destination_amount"]) == Decimal("360")
    assert Decimal(transfers[second["id"]]["destination_amount"]) == Decimal("380")
