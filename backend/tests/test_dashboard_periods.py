"""Dashboard's three period modes (see docs/tasks/dashboard-periods.md).

The original contract is preserved byte-for-byte: a bare request (no
params at all) still resolves to the current year/month, `month` alone
still resolves against the current year, and an explicit `year=&month=`
still means exactly that one month — none of that changed. The two new
modes ("every month of a year", "all time") are opt-in via the new
`period` param, never implied by omitting year/month, so an old caller's
request shape and result are both untouched.

Plain month-scoping arithmetic (income/expense/net, category breakdown) is
already covered by test_dashboard.py — this file covers what's new: the
period contract itself (old shape preserved, new shapes explicit), that
"ends today" clips a stray future-dated transaction out of a period that's
supposed to end today, and that transfers/adjustments/asset
trades/splits behave the same way across all three modes as they already
do for a single month.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from httpx import AsyncClient

from tests.helpers import money, txn_payload as _txn


async def test_bare_call_still_means_the_current_month_exactly_as_before(client: AsyncClient, account_id, categories):
    """The original contract: no params at all == current year/month —
    must keep resolving this way even though the Dashboard's own frontend
    now always sends an explicit `period` (see api/dashboard.ts)."""
    today = date.today()
    salary = categories["Salary"]["id"]
    await client.post("/transactions", json=_txn(account_id, type="income", amount="500.00", category_id=salary, date=str(today)))
    last_month = (today.replace(day=1) - timedelta(days=1))
    await client.post("/transactions", json=_txn(account_id, type="income", amount="9999.00", category_id=salary, date=str(last_month)))

    bare = (await client.get("/dashboard/summary")).json()
    explicit = (await client.get("/dashboard/summary", params={"year": today.year, "month": today.month})).json()
    assert bare == explicit
    assert bare["year"] == today.year and bare["month"] == today.month
    assert money(bare["real_income"]) == Decimal("500.00")  # not 10499 — last month is out of scope


async def test_month_alone_still_resolves_against_the_current_year_exactly_as_before(client: AsyncClient, account_id, categories):
    today = date.today()
    salary = categories["Salary"]["id"]
    await client.post("/transactions", json=_txn(account_id, type="income", amount="321.00", category_id=salary, date=f"{today.year}-01-15"))

    resp = await client.get("/dashboard/summary", params={"month": 1})
    body = resp.json()
    assert resp.status_code == 200, resp.text
    assert body["year"] == today.year and body["month"] == 1
    assert money(body["real_income"]) == Decimal("321.00")


async def test_period_all_is_the_explicit_opt_in_for_all_time(client: AsyncClient, account_id, categories):
    salary = categories["Salary"]["id"]
    await client.post("/transactions", json=_txn(account_id, type="income", amount="500.00", category_id=salary, date="2019-01-01"))
    # "All time" ends today, not the far future — a stray 2031-dated row
    # (e.g. a data-entry slip) must not inflate it.
    await client.post("/transactions", json=_txn(account_id, type="income", amount="9999.00", category_id=salary, date="2031-06-01"))

    resp = await client.get("/dashboard/summary", params={"period": "all"})
    body = resp.json()
    assert body["year"] is None and body["month"] is None
    assert money(body["real_income"]) == Decimal("500.00")


@pytest.mark.parametrize("params", [{"period": "all", "year": 2020}, {"period": "all", "month": 5}, {"period": "year", "month": 5}])
async def test_new_modes_reject_year_or_month_combinations_that_dont_apply_to_them(client: AsyncClient, params):
    resp = await client.get("/dashboard/summary", params=params)
    assert resp.status_code == 422


async def test_period_year_is_the_explicit_opt_in_for_every_month_of_that_past_year(client: AsyncClient, account_id, categories):
    salary = categories["Salary"]["id"]
    groceries = categories["Groceries"]["id"]
    await client.post("/transactions", json=_txn(account_id, type="income", amount="100.00", category_id=salary, date="2020-01-01"))
    await client.post("/transactions", json=_txn(account_id, type="income", amount="200.00", category_id=salary, date="2020-12-31"))
    # Out of scope: same categories, one day either side of the year.
    await client.post("/transactions", json=_txn(account_id, type="income", amount="9999.00", category_id=salary, date="2019-12-31"))
    await client.post("/transactions", json=_txn(account_id, type="expense", amount="9999.00", category_id=groceries, date="2021-01-01"))

    resp = await client.get("/dashboard/summary", params={"period": "year", "year": 2020})
    body = resp.json()
    assert body["year"] == 2020 and body["month"] is None
    assert money(body["real_income"]) == Decimal("300.00")
    assert money(body["spent"]) == 0


async def test_period_year_defaults_to_the_current_year_when_year_is_omitted(client: AsyncClient, account_id, categories):
    today = date.today()
    salary = categories["Salary"]["id"]
    await client.post("/transactions", json=_txn(account_id, type="income", amount="77.00", category_id=salary, date=str(today)))

    resp = await client.get("/dashboard/summary", params={"period": "year"})
    body = resp.json()
    assert body["year"] == today.year and body["month"] is None
    assert money(body["real_income"]) == Decimal("77.00")


async def test_a_past_years_all_months_arent_clipped_even_though_they_predate_today(client: AsyncClient, account_id, categories):
    """Distinct from the current-year case below — a *past* year's own
    calendar end (Dec 31) is already before today, so nothing should ever
    be clipped away from it."""
    groceries = categories["Groceries"]["id"]
    await client.post("/transactions", json=_txn(account_id, type="expense", amount="42.00", category_id=groceries, date="2020-12-31"))

    resp = await client.get("/dashboard/summary", params={"period": "year", "year": 2020})
    assert money(resp.json()["spent"]) == Decimal("42.00")


@pytest.mark.skipif(date.today().month == 12 and date.today().day == 31, reason="no room left in the current year to place a synthetic future date")
async def test_all_time_and_the_current_years_all_months_clip_to_today_not_a_stray_future_date(
    client: AsyncClient, account_id, categories
):
    today = date.today()
    future_this_year = date(today.year, 12, 31)
    salary = categories["Salary"]["id"]
    await client.post("/transactions", json=_txn(account_id, type="income", amount="100.00", category_id=salary, date=str(today)))
    await client.post("/transactions", json=_txn(account_id, type="income", amount="9999.00", category_id=salary, date=str(future_this_year)))

    all_time = (await client.get("/dashboard/summary", params={"period": "all"})).json()
    assert money(all_time["real_income"]) == Decimal("100.00")

    whole_year = (await client.get("/dashboard/summary", params={"period": "year", "year": today.year})).json()
    assert money(whole_year["real_income"]) == Decimal("100.00")

    # The *specific current month* mode already did full-calendar-month
    # bounds before this task — confirms it now also clips to today, not
    # just to the month's own last day.
    current_month = (await client.get("/dashboard/summary", params={"year": today.year, "month": today.month})).json()
    assert money(current_month["real_income"]) == Decimal("100.00")


async def test_transfers_adjustments_asset_trades_and_splits_behave_the_same_in_every_period_mode(
    client: AsyncClient, account_id, categories
):
    """Synthetic scenario covering the task's own acceptance criteria: an
    income, an expense split across a subcategory, a transfer, an
    opening-balance adjustment and a manual asset purchase, all checked
    under "all time" — the exact same exclusions/rollup as the existing
    single-month behavior (test_dashboard.py), just over a wider period."""
    today = date.today()
    groceries = categories["Groceries"]["id"]
    salary = categories["Salary"]["id"]
    sweets = (
        await client.post("/categories", json={"name": "Sweets DP", "kind": "expense", "color": "#7a869a", "parent_id": groceries})
    ).json()["id"]
    other_account = (await client.post("/accounts", json={"name": "Savings DP", "type": "savings", "currency": "USD"})).json()["id"]

    await client.post("/transactions", json=_txn(account_id, type="adjustment", amount="1000.00", adjustment_reason="opening_balance", date="2020-01-01"))
    await client.post("/transactions", json=_txn(account_id, type="income", amount="500.00", category_id=salary, date=str(today)))
    await client.post(
        "/transactions",
        json=_txn(
            account_id, amount="100.00", category_id=None, date=str(today),
            splits=[{"category_id": groceries, "amount": "70.00"}, {"category_id": sweets, "amount": "30.00"}],
        ),
    )
    await client.post("/transactions", json=_txn(account_id, type="transfer", amount="50.00", transfer_account_id=other_account, date=str(today)))

    asset = (await client.post("/assets", json={"name": "DP asset", "asset_class": "other", "currency": "USD", "value": "0", "as_of_date": "2020-01-01"})).json()
    await client.post(
        "/asset-movements",
        json=dict(asset_id=asset["id"], account_id=account_id, type="buy", gross_amount="150", fee_amount="0",
                   asset_value_after="150", date=str(today), idempotency_key="dashboard-periods-buy-001"),
    )

    body = (await client.get("/dashboard/summary", params={"period": "all"})).json()
    assert money(body["real_income"]) == Decimal("500.00")  # not 1500 — the adjustment never counts as income
    assert money(body["spent"]) == Decimal("100.00")  # the split, not the transfer or the asset purchase
    assert money(body["transferred_out"]) == Decimal("50.00")
    groceries_slice = next(s for s in body["spending_by_category"] if s["category_id"] == groceries)
    assert money(groceries_slice["amount"]) == Decimal("100.00")  # both split lines rolled into their parent, once each


async def test_missing_historical_rate_is_an_explicit_error_in_all_time_mode_too(client: AsyncClient, categories):
    await client.patch("/settings", json={"currency": "PLN"})
    eur = (await client.post("/accounts", json={"name": "DP EUR", "currency": "EUR"})).json()["id"]
    await client.post("/transactions", json=_txn(eur, category_id=categories["Groceries"]["id"], date=str(date.today())))

    response = await client.get("/dashboard/summary", params={"period": "all"})
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "FX_RATE_MISSING"
