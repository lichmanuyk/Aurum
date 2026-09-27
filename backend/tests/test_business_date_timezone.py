"""Server-side business date/timezone (see docs/tasks/business-date-timezone.md).

Covers both the pure helper (app/core/clock.py) and its effect once it
reaches real request paths through the freeze_business_clock fixture
(tests/conftest.py) — recurring "post now", a cash-linked crypto trade's
"today" gate, and the dashboard's period end_date. All of these used to
read `date.today()` (the container's own, almost always UTC, OS clock);
every assertion below specifically exercises the window where that would
have disagreed with Europe/Warsaw.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.core import clock as clock_module
from app.core.clock import business_now, business_today, business_timezone
from app.core.config import Settings, get_settings
from app.services import crypto_service
from tests.test_crypto import _fake_fetch, _point


# ---------------------------------------------------------------------------
# Pure helper: no DB, no client — just app.core.clock itself.
# ---------------------------------------------------------------------------

def test_business_timezone_defaults_to_europe_warsaw():
    assert get_settings().business_timezone == "Europe/Warsaw"
    assert business_timezone().key == "Europe/Warsaw"


def test_invalid_business_timezone_setting_raises_not_silently_falls_back():
    """A typo'd/non-existent IANA zone must fail Settings() construction
    outright — never silently resolve to UTC or the OS zone deep inside a
    request. Constructs Settings() directly (not the process-wide cached
    get_settings()) so this doesn't disturb the real app's settings."""
    with pytest.raises(ValidationError):
        Settings(business_timezone="Not/AZone")


def test_business_now_rejects_naive_datetime():
    """No implicit "must already be UTC" guess — an explicit error instead."""
    with pytest.raises(ValueError):
        business_now(datetime(2026, 1, 1, 12, 0))


def test_business_today_warsaw_already_next_day_while_utc_still_shows_yesterday(monkeypatch):
    """The exact scenario the whole task is about: shortly after UTC
    midnight, Warsaw (UTC+2 in September, CEST) has already turned over to
    the next calendar day. The old `date.today()` (OS-local, UTC in a
    default-configured Docker container) would still report the previous
    day here."""
    pinned = datetime(2026, 9, 26, 23, 30, tzinfo=timezone.utc)
    monkeypatch.setattr(clock_module, "utcnow", lambda: pinned)

    assert pinned.date() == date(2026, 9, 26)  # what a naive UTC read would say
    assert business_today() == date(2026, 9, 27)  # what Warsaw actually shows


def test_business_today_warsaw_ahead_of_utc_in_winter_cet(monkeypatch):
    """Same shape as the CEST case above (Warsaw has already turned over to
    the next day while a naive UTC read would still say the previous one),
    just under winter's CET (UTC+1) offset instead of summer's CEST
    (UTC+2) — Warsaw is *always* at or ahead of UTC (+1 or +2, never
    behind), so there is no scenario where UTC's own calendar date could
    ever be ahead of Warsaw's; only the reverse, in either season. (An
    earlier version of this test was misnamed "reverse case ... warsaw
    still previous", which described exactly that impossible direction —
    the assertion below always disproves it.)"""
    pinned = datetime(2026, 1, 15, 23, 15, tzinfo=timezone.utc)
    monkeypatch.setattr(clock_module, "utcnow", lambda: pinned)

    assert pinned.date() == date(2026, 1, 15)  # what a naive UTC read would say
    assert business_today() == date(2026, 1, 16)  # what Warsaw (CET, UTC+1) actually shows
    warsaw_local = business_now()
    assert (warsaw_local.hour, warsaw_local.minute) == (0, 15)


@pytest.mark.parametrize("pinned_utc,expected_warsaw_date", [
    # Last Sunday of March 2026 (2026-03-29): Warsaw jumps 02:00->03:00 CET->CEST
    # at 01:00 UTC. Just before and just after, no exception, no date skip.
    (datetime(2026, 3, 28, 22, 30, tzinfo=timezone.utc), date(2026, 3, 28)),  # 23:30 CET, still the 28th
    (datetime(2026, 3, 29, 0, 30, tzinfo=timezone.utc), date(2026, 3, 29)),   # 01:30 CET, just before the jump
    (datetime(2026, 3, 29, 1, 30, tzinfo=timezone.utc), date(2026, 3, 29)),   # 03:30 CEST, just after the jump
])
def test_business_today_dst_spring_forward_no_shift_or_exception(monkeypatch, pinned_utc, expected_warsaw_date):
    monkeypatch.setattr(clock_module, "utcnow", lambda: pinned_utc)
    assert business_today() == expected_warsaw_date


@pytest.mark.parametrize("pinned_utc,expected_warsaw_date", [
    # Last Sunday of October 2026 (2026-10-25): Warsaw folds 03:00->02:00
    # CEST->CET at 01:00 UTC — an hour that happens twice, still one date.
    (datetime(2026, 10, 25, 0, 30, tzinfo=timezone.utc), date(2026, 10, 25)),  # 02:30 CEST, before the fold
    (datetime(2026, 10, 25, 1, 30, tzinfo=timezone.utc), date(2026, 10, 25)),  # 02:30 CET, after the fold
    (datetime(2026, 10, 25, 22, 45, tzinfo=timezone.utc), date(2026, 10, 25)), # 23:45 CET, still the 25th
])
def test_business_today_dst_fall_back_no_shift_or_exception(monkeypatch, pinned_utc, expected_warsaw_date):
    monkeypatch.setattr(clock_module, "utcnow", lambda: pinned_utc)
    assert business_today() == expected_warsaw_date


def test_freeze_business_clock_date_only_form_matches_business_now_date(freeze_business_clock):
    """Sanity-check the shared test fixture itself (tests/conftest.py):
    passing it a plain date pins business_today() to exactly that date,
    regardless of which DST offset Warsaw is on that day."""
    for day in (date(2026, 1, 15), date(2026, 7, 4), date(2026, 3, 29), date(2026, 10, 25)):
        freeze_business_clock(day)
        assert business_today() == day


# ---------------------------------------------------------------------------
# Reaches an actual endpoint: GET /api/settings is where the frontend's
# useBusinessDate() hook reads the server's business date/timezone from.
# ---------------------------------------------------------------------------

async def test_settings_endpoint_exposes_business_date_and_timezone(client, freeze_business_clock):
    freeze_business_clock(date(2026, 6, 1))
    body = (await client.get("/settings")).json()
    assert body["business_date"] == "2026-06-01"
    assert body["business_timezone"] == "Europe/Warsaw"
    # Additive-only: every previously existing field (old API contract) is
    # still present alongside the two new ones.
    assert "app_version" in body and "currency" in body


async def test_settings_endpoint_business_date_advances_on_next_read(client, freeze_business_clock):
    """No caching/staleness at the source itself — a later read under a
    later pinned instant reports the later day; the frontend hook's own
    refetch-on-interval/focus (see docs/tasks/business-date-timezone.md) is
    what makes that reach an already-open tab, but the endpoint itself must
    never hand back yesterday's value once the day has actually turned."""
    freeze_business_clock(date(2026, 6, 1))
    first = (await client.get("/settings")).json()["business_date"]
    freeze_business_clock(date(2026, 6, 2))
    second = (await client.get("/settings")).json()["business_date"]
    assert first == "2026-06-01"
    assert second == "2026-06-02"


# ---------------------------------------------------------------------------
# Recurring "post now" — records the transaction under the Warsaw business
# date, even when the container's own UTC clock still shows the day before.
# ---------------------------------------------------------------------------

async def test_recurring_post_now_uses_warsaw_date_not_utc_date(client, account_id, freeze_business_clock):
    # 23:40 UTC on the 26th = 01:40 CEST on the 27th: UTC is still "the 26th",
    # Warsaw is already "the 27th".
    freeze_business_clock(datetime(2026, 9, 26, 23, 40, tzinfo=timezone.utc))
    assert business_today() == date(2026, 9, 27)

    template = await client.post("/recurring", json=dict(
        account_id=account_id, type="expense", amount="10", description="Synthetic subscription",
        frequency="monthly", anchor_date="2026-09-27",
    ))
    assert template.status_code == 201, template.text

    posted = await client.post(f"/recurring/{template.json()['id']}/post")
    assert posted.status_code == 201, posted.text
    assert posted.json()["last_posted_date"] == "2026-09-27"

    created_rows = (await client.get("/transactions")).json()["items"]
    assert created_rows[0]["date"] == "2026-09-27"


# ---------------------------------------------------------------------------
# Cash-linked crypto trade's "today" gate — the sharpest regression check:
# before this fix, this gate compared against date.today() (UTC-local), so
# the Warsaw date would have been wrongly rejected as "not today" and the
# UTC date wrongly accepted as "today" during exactly this window.
# ---------------------------------------------------------------------------

async def test_crypto_trade_today_gate_uses_warsaw_date_not_utc_date(client, account_id, monkeypatch, freeze_business_clock):
    monkeypatch.setattr(crypto_service, "_fetch_market_data", _fake_fetch({"bitcoin": _point("100")}))
    freeze_business_clock(datetime(2026, 9, 26, 23, 40, tzinfo=timezone.utc))
    warsaw_today = business_today()
    utc_today = datetime(2026, 9, 26, 23, 40, tzinfo=timezone.utc).date()
    assert warsaw_today == date(2026, 9, 27) and utc_today == date(2026, 9, 26)

    opened = await client.post("/transactions", json=dict(
        account_id=account_id, type="adjustment", amount="1000",
        adjustment_reason="opening_balance", description="Opening", date=str(warsaw_today),
    ))
    assert opened.status_code == 201, opened.text

    holding = (await client.post("/crypto/holdings", json=dict(
        coingecko_id="bitcoin", symbol="BTC", name="Bitcoin", quantity="1", date=str(warsaw_today),
    ))).json()
    asset_id = holding["asset_id"]

    def movement(day, key):
        return dict(asset_id=asset_id, account_id=account_id, type="buy", gross_amount="100",
                    fee_amount="0", quantity="1", price_per_unit="100", date=str(day), idempotency_key=key)

    rejected = await client.post("/asset-movements", json=movement(utc_today, "biz-date-utc-attempt"))
    assert rejected.status_code == 422, rejected.text
    assert "today" in rejected.json()["detail"].lower()

    accepted = await client.post("/asset-movements", json=movement(warsaw_today, "biz-date-warsaw-attempt"))
    assert accepted.status_code == 201, accepted.text
    assert accepted.json()["date"] == str(warsaw_today)


# ---------------------------------------------------------------------------
# Dashboard period bounds — end_date must clamp to the Warsaw "today", not
# the container's UTC date, so a same-Warsaw-day transaction isn't dropped
# and a UTC-future/Warsaw-today transaction isn't treated as future.
# ---------------------------------------------------------------------------

async def test_dashboard_end_date_uses_warsaw_today(client, account_id, freeze_business_clock):
    freeze_business_clock(datetime(2026, 9, 26, 23, 40, tzinfo=timezone.utc))
    warsaw_today = business_today()

    summary = (await client.get("/dashboard/summary")).json()
    assert summary["end_date"] == str(warsaw_today)


# ---------------------------------------------------------------------------
# Date-only round trip: a recorded date is never reinterpreted just because
# "today" (as computed by business_today()) has moved on since.
# ---------------------------------------------------------------------------

async def test_recorded_date_never_shifts_when_business_today_moves_on(client, account_id, categories, freeze_business_clock):
    freeze_business_clock(date(2026, 5, 10))
    recorded_date = "2026-05-10"
    created = await client.post("/transactions", json=dict(
        account_id=account_id, type="expense", amount="12.34",
        category_id=categories["Groceries"]["id"], description="Synthetic groceries", date=recorded_date,
    ))
    assert created.status_code == 201, created.text
    tx_id = created.json()["id"]

    # "Today" moves forward by a week from the server's point of view —
    # the already-recorded transaction's own date must stay byte-identical.
    freeze_business_clock(date(2026, 5, 17))
    listed = (await client.get("/transactions")).json()["items"]
    assert next(row for row in listed if row["id"] == tx_id)["date"] == recorded_date
