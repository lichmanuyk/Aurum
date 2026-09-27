"""Single source of truth for "today" in server-side financial rules.

The app runs for one user in Poland: every date-only business decision (a
recurring template's due date and "post now" date, a crypto trade's
"today", a dashboard/report period's upper bound, the idle-cash/insights
"not a future transaction yet" filter, etc.) must use the *business* date
in AURUM_BUSINESS_TIMEZONE (default Europe/Warsaw, see app/core/config.py),
never `date.today()` (the container's/database host's own OS timezone,
almost always UTC in Docker) and never a browser's local date.

Freshness/audit timestamps — crypto sync's `last_synced_at`, backup export's
`exported_at`, an FXRate row's `updated_at` — stay in UTC on purpose; they
answer "when did this happen", not "which calendar day is it for the user",
and this module is only for the latter. Do not route those through here.
"""
from datetime import date, datetime, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

from app.core.config import get_settings


@lru_cache
def business_timezone() -> ZoneInfo:
    """Cached: the running app never changes timezone mid-process, and
    re-parsing the IANA database on every call would be wasteful.
    get_settings() already validates the configured name eagerly at
    Settings() construction time (see core/config.py) — a bad
    AURUM_BUSINESS_TIMEZONE fails app startup outright, so this can trust
    the value without a second silent fallback here."""
    return ZoneInfo(get_settings().business_timezone)


def utcnow() -> datetime:
    """The one real clock read in this module. Tests monkeypatch exactly
    this function (`app.core.clock.utcnow`) to pin a fixed instant — e.g.
    to reproduce "UTC still shows yesterday, Warsaw already shows today"
    around midnight, or a DST transition — which business_now/business_today
    below then convert exactly as production code would. This project has
    no time-freezing test dependency (freezegun etc.) and a single
    monkeypatchable function does not need one added."""
    return datetime.now(timezone.utc)


def business_now(instant: datetime | None = None) -> datetime:
    """`instant` (an aware datetime, any zone) converted to the business
    timezone; defaults to the real current instant via utcnow().

    Deliberately rejects a naive datetime rather than assuming it is
    already UTC — that assumption is exactly the kind of silent fallback
    this module exists to avoid; callers must be explicit."""
    moment = instant if instant is not None else utcnow()
    if moment.tzinfo is None:
        raise ValueError("business_now() requires an aware datetime, got a naive one")
    return moment.astimezone(business_timezone())


def business_today(instant: datetime | None = None) -> date:
    """The calendar day it currently is for the app's user in
    AURUM_BUSINESS_TIMEZONE (Warsaw by default) — use this everywhere a
    financial rule means "today". Never `date.today()` (OS/container-local,
    silently wrong for hours around every midnight whenever the container's
    timezone differs from Warsaw's, which is the Docker default) and never
    `datetime.now(timezone.utc).date()` (always UTC, up to two hours behind
    Warsaw in both winter and summer)."""
    return business_now(instant).date()
