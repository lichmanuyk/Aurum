"""Dashboard's compact 'what's 1 USD/EUR/BYN/RUB worth' card (see
docs/tasks/fx-rate-overview.md) — reads only already-saved reference
rates, reports official (NBP) rates only, and never touches ledger history,
account balances or capital.
"""
from datetime import date, timedelta
from decimal import Decimal

from tests.test_multicurrency import account, tx


async def nbp_rate(client, currency, day, value, table="A", no="1/A/NBP/2026"):
    """Posts a rate the same shape a real NBP import would produce — an
    explicit official-looking `source`, unlike test_multicurrency.py's own
    `rate()` helper (which defaults to `source='manual'`)."""
    response = await client.post("/fx-rates/bulk", json={"items": [dict(
        base_currency=currency, quote_currency="PLN", rate_date=str(day), rate=value, source=f"NBP:{table}:{no}",
    )]})
    assert response.status_code == 200, response.text


async def test_overview_shows_all_four_currencies_with_correct_direction_date_and_source(client):
    await client.patch("/settings", json={"currency": "PLN"})
    today = date.today()
    await nbp_rate(client, "USD", today, "4.1000")
    await nbp_rate(client, "EUR", today, "4.5000")
    await nbp_rate(client, "BYN", today, "1.2000", table="B")
    await nbp_rate(client, "RUB", today, "0.0450", table="B")

    body = (await client.get("/fx-rates/overview")).json()
    assert body["reporting_currency"] == "PLN"
    assert body["as_of"] == str(today)
    by_currency = {item["currency"]: item for item in body["items"]}
    assert set(by_currency) == {"USD", "EUR", "BYN", "RUB"}
    for currency, expected in [("USD", "4.1000"), ("EUR", "4.5000"), ("BYN", "1.2000"), ("RUB", "0.0450")]:
        item = by_currency[currency]
        # "1 <currency> = <rate> PLN" — never the inverse.
        assert Decimal(item["rate"]) == Decimal(expected)
        assert item["rate_date"] == str(today)
        assert item["source"] == "NBP"


async def test_missing_currency_is_explicit_never_zero_or_one_to_one(client):
    await client.patch("/settings", json={"currency": "PLN"})
    today = date.today()
    await nbp_rate(client, "USD", today, "4.1000")
    # BYN and RUB are simply never fetched (e.g. NBP outage) — no row at all.

    body = (await client.get("/fx-rates/overview")).json()
    by_currency = {item["currency"]: item for item in body["items"]}
    assert by_currency["USD"]["rate"] is not None
    for currency in ("BYN", "RUB"):
        item = by_currency[currency]
        assert item["rate"] is None
        assert item["rate_date"] is None
        assert item["source"] is None


async def test_manual_rate_is_never_shown_as_an_official_quote(client):
    await client.patch("/settings", json={"currency": "PLN"})
    today = date.today()
    # A manually typed rate exists (e.g. entered once in Settings) — real
    # enough for ordinary transaction conversion, but not an NBP quote.
    manual = await client.post("/fx-rates/bulk", json={"items": [dict(
        base_currency="RUB", quote_currency="PLN", rate_date=str(today), rate="0.05",
    )]})
    assert manual.status_code == 200, manual.text

    body = (await client.get("/fx-rates/overview")).json()
    item = next(item for item in body["items"] if item["currency"] == "RUB")
    assert item["rate"] is None and item["rate_date"] is None and item["source"] is None

    # The same manual rate is still perfectly usable for real conversion —
    # this card just never presents it as an official one.
    rub_account = await account(client, "RUB")
    await tx(client, rub_account, type="income", amount="100", date=str(today))
    cash_flow = await client.get("/cash-flow")
    assert cash_flow.status_code == 200
    assert Decimal(cash_flow.json()["total_income"]) == Decimal("5.00")


async def test_weekend_or_holiday_gap_reuses_the_last_publication_without_a_false_error(client):
    await client.patch("/settings", json={"currency": "PLN"})
    published = date.today() - timedelta(days=2)
    await nbp_rate(client, "BYN", published, "1.2500", table="B")

    item = next(i for i in (await client.get("/fx-rates/overview")).json()["items"] if i["currency"] == "BYN")
    assert item["rate_date"] == str(published)
    assert Decimal(item["rate"]) == Decimal("1.2500")


async def test_overview_never_writes_fx_rates_or_touches_capital(client):
    await client.patch("/settings", json={"currency": "PLN"})
    today = date.today()
    await nbp_rate(client, "USD", today, "4.1000")
    usd_account, pln_account = await account(client, "USD"), await account(client, "PLN")
    await tx(client, usd_account, type="income", amount="1000", date=str(today))
    # Two same-day exchanges at different actual rates — the reference
    # overview must never touch either.
    first = await tx(client, usd_account, type="transfer", transfer_account_id=pln_account,
                     amount="100", destination_amount="360", date=str(today))
    second = await tx(client, usd_account, type="transfer", transfer_account_id=pln_account,
                      amount="100", destination_amount="380", date=str(today))

    before_rates = (await client.get("/fx-rates")).json()
    before_backup = (await client.get("/backup/export")).json()

    for _ in range(3):
        assert (await client.get("/fx-rates/overview")).status_code == 200

    assert (await client.get("/fx-rates")).json() == before_rates
    after_backup = (await client.get("/backup/export")).json()
    for key in ("accounts", "transactions", "fx_rates"):
        assert after_backup[key] == before_backup[key]
    transfers = {row["id"]: row for row in after_backup["transactions"]}
    assert Decimal(transfers[first["id"]]["destination_amount"]) == Decimal("360")
    assert Decimal(transfers[second["id"]]["destination_amount"]) == Decimal("380")


async def test_overview_covers_a_currency_the_user_holds_no_account_in(client):
    await client.patch("/settings", json={"currency": "PLN"})
    accounts = (await client.get("/accounts")).json()
    assert all(row["currency"] != "RUB" for row in accounts)
    await nbp_rate(client, "RUB", date.today(), "0.0450", table="B")

    item = next(i for i in (await client.get("/fx-rates/overview")).json()["items"] if i["currency"] == "RUB")
    assert Decimal(item["rate"]) == Decimal("0.0450")
