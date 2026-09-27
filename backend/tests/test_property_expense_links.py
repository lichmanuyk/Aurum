"""An ordinary expense's optional link to a manually-tracked asset (see
docs/tasks/property-expense-links.md) — synthetic-only, no personal fixtures.
Covers: link/unlink on a plain expense and on split lines, the type/asset
validity rules, delete protection, the asset's own "Expenses" report (period,
pagination, FX, reporting overrides), linked recurring templates, and the
backup roundtrip for all three new columns.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest

from tests.helpers import money, txn_payload
from tests.test_recurring import template
from app.core.clock import business_today


async def asset(client, **overrides):
    payload = dict(name="Synthetic property", asset_class="real_estate", currency="USD", value="100000",
                    as_of_date=str(business_today()))
    payload.update(overrides)
    response = await client.post("/assets", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def rate(client, day, base="EUR", quote="USD", value="1.1"):
    response = await client.post(
        "/fx-rates/bulk", json={"items": [dict(base_currency=base, quote_currency=quote, rate_date=str(day), rate=value)]}
    )
    assert response.status_code == 200, response.text


# --- Plain expense: link, unlink, and the type/asset validity rules ------

async def test_plain_expense_can_link_and_explicitly_unlink(client, account_id, categories):
    a = await asset(client)
    created = await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"]))
    assert created.status_code == 201, created.text
    tx_id = created.json()["id"]
    assert created.json()["expense_asset_id"] == a["id"]

    # Omitted on PATCH -> the link survives untouched.
    kept = await client.patch(f"/transactions/{tx_id}", json={"description": "Renamed"})
    assert kept.status_code == 200, kept.text
    assert kept.json()["expense_asset_id"] == a["id"]

    # Explicit null -> the link is cleared; the money itself is untouched.
    cleared = await client.patch(f"/transactions/{tx_id}", json={"expense_asset_id": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["expense_asset_id"] is None
    assert money(cleared.json()["amount"]) == money("10.00")


@pytest.mark.parametrize("bad_type,extra", [
    ("income", {}),
    ("transfer", {"transfer_account_id": None}),
    ("adjustment", {"adjustment_reason": "reconciliation"}),
])
async def test_link_is_rejected_for_non_expense_types(client, account_id, bad_type, extra):
    a = await asset(client)
    other = await client.post("/accounts", json={"name": "Synthetic other", "currency": "USD"})
    assert other.status_code == 201
    if bad_type == "transfer":
        extra = {"transfer_account_id": other.json()["id"]}
    payload = txn_payload(account_id, type=bad_type, expense_asset_id=a["id"], category_id=None, **extra)
    response = await client.post("/transactions", json=payload)
    assert response.status_code == 422, response.text


async def test_link_is_rejected_for_unknown_asset(client, account_id):
    response = await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=999999))
    assert response.status_code == 400, response.text
    assert (await client.get("/transactions")).json()["total"] == 0


async def test_link_is_rejected_for_a_crypto_class_asset(client, account_id):
    crypto_asset = await asset(client, asset_class="crypto", name="Synthetic coin")
    response = await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=crypto_asset["id"]))
    assert response.status_code == 400, response.text


async def test_link_cannot_be_set_together_with_splits_on_the_parent(client, account_id, categories):
    a = await asset(client)
    groceries = categories["Groceries"]["id"]
    sweets = (await client.post(
        "/categories", json={"name": "Sweets2", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
    )).json()["id"]
    payload = txn_payload(
        account_id, amount="100.00", category_id=None, expense_asset_id=a["id"],
        splits=[{"category_id": groceries, "amount": "60.00"}, {"category_id": sweets, "amount": "40.00"}],
    )
    response = await client.post("/transactions", json=payload)
    assert response.status_code == 422, response.text


async def test_switching_type_away_from_expense_requires_explicit_unlink(client, account_id):
    a = await asset(client)
    created = (await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"]))).json()

    # Switching type without clearing the link is rejected outright.
    rejected = await client.patch(f"/transactions/{created['id']}", json={"type": "income", "category_id": None})
    assert rejected.status_code == 400, rejected.text
    unchanged = (await client.get("/transactions")).json()["items"][0]
    assert unchanged["type"] == "expense" and unchanged["expense_asset_id"] == a["id"]

    # Explicitly clearing it alongside the type change is accepted.
    accepted = await client.patch(
        f"/transactions/{created['id']}", json={"type": "income", "category_id": None, "expense_asset_id": None}
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["expense_asset_id"] is None


# --- Split lines: independent links, no double counting ------------------

async def test_split_lines_link_different_assets_without_double_counting(client, account_id, categories):
    house = await asset(client, name="Synthetic house")
    car = await asset(client, name="Synthetic car", asset_class="vehicles")
    groceries = categories["Groceries"]["id"]
    sweets = (await client.post(
        "/categories", json={"name": "Sweets3", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
    )).json()["id"]
    payload = txn_payload(
        account_id, amount="100.00", category_id=None,
        splits=[
            {"category_id": groceries, "amount": "60.00", "expense_asset_id": house["id"]},
            {"category_id": sweets, "amount": "40.00", "expense_asset_id": car["id"]},
        ],
    )
    created = await client.post("/transactions", json=payload)
    assert created.status_code == 201, created.text

    house_report = (await client.get(f"/assets/{house['id']}/expenses")).json()
    car_report = (await client.get(f"/assets/{car['id']}/expenses")).json()
    assert money(house_report["total_amount"]) == money("60.00")
    assert money(car_report["total_amount"]) == money("40.00")
    assert house_report["items"][0]["is_split"] is True
    assert house_report["items"][0]["id"] == created.json()["id"]


async def test_split_expense_asset_id_rejected_for_income(client, account_id, categories):
    """A split's own expense_asset_id is EXPENSE-only, same as the parent's
    own field — income (which *can* otherwise be split, unlike transfers/
    adjustments) still can't carry the link on any of its lines."""
    a = await asset(client)
    salary = categories["Salary"]["id"]
    bonus = (await client.post(
        "/categories", json={"name": "Bonus", "kind": "income", "color": "#7a869a", "parent_id": salary}
    )).json()["id"]
    payload = txn_payload(
        account_id, type="income", amount="100.00", category_id=None,
        splits=[
            {"category_id": salary, "amount": "60.00"},
            {"category_id": bonus, "amount": "40.00", "expense_asset_id": a["id"]},
        ],
    )
    response = await client.post("/transactions", json=payload)
    assert response.status_code == 400, response.text


# --- Deleting a linked asset is blocked until explicitly unlinked ---------

async def test_delete_blocked_while_a_plain_expense_is_linked(client, account_id):
    a = await asset(client)
    created = (await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"]))).json()
    blocked = await client.delete(f"/assets/{a['id']}")
    assert blocked.status_code == 409, blocked.text
    await client.patch(f"/transactions/{created['id']}", json={"expense_asset_id": None})
    assert (await client.delete(f"/assets/{a['id']}")).status_code == 204


async def test_delete_blocked_while_a_split_line_is_linked(client, account_id, categories):
    a = await asset(client)
    groceries = categories["Groceries"]["id"]
    sweets = (await client.post(
        "/categories", json={"name": "Sweets4", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
    )).json()["id"]
    created = (await client.post("/transactions", json=txn_payload(
        account_id, amount="100.00", category_id=None,
        splits=[{"category_id": groceries, "amount": "60.00", "expense_asset_id": a["id"]},
                {"category_id": sweets, "amount": "40.00"}],
    ))).json()
    assert (await client.delete(f"/assets/{a['id']}")).status_code == 409
    await client.patch(f"/transactions/{created['id']}", json={"splits": [
        {"category_id": groceries, "amount": "60.00"}, {"category_id": sweets, "amount": "40.00"},
    ]})
    assert (await client.delete(f"/assets/{a['id']}")).status_code == 204


async def test_delete_blocked_while_a_recurring_template_is_linked(client, account_id):
    a = await asset(client)
    t = await template(client, account_id, expense_asset_id=a["id"])
    assert (await client.delete(f"/assets/{a['id']}")).status_code == 409
    await client.patch(f"/recurring/{t['id']}", json={"expense_asset_id": None})
    assert (await client.delete(f"/assets/{a['id']}")).status_code == 204


# --- The asset's own "Expenses" report: period, pagination, FX -----------

async def test_report_period_bounds_and_pagination(client, account_id):
    a = await asset(client)
    for i, day in enumerate(["2025-01-10", "2025-06-15", "2026-01-05"]):
        await client.post("/transactions", json=txn_payload(
            account_id, expense_asset_id=a["id"], amount=f"{10 + i}.00", date=day, description=f"Bill {i}"
        ))
    tomorrow = str(business_today() + timedelta(days=1))
    await client.post("/transactions", json=txn_payload(
        account_id, expense_asset_id=a["id"], amount="999.00", date=tomorrow, description="Future bill"
    ))

    all_time = (await client.get(f"/assets/{a['id']}/expenses")).json()
    # The future-dated row must never leak into an "all time" total that's
    # supposed to end at the server's own today (see dashboard-periods.md's
    # same rule, reused here via _resolve_bounds).
    assert money(all_time["total_amount"]) == money("10.00") + money("11.00") + money("12.00")
    assert all_time["total"] == 3

    year_2025 = (await client.get(f"/assets/{a['id']}/expenses", params={"year": 2025})).json()
    assert money(year_2025["total_amount"]) == money("10.00") + money("11.00")
    assert year_2025["total"] == 2

    month = (await client.get(f"/assets/{a['id']}/expenses", params={"year": 2025, "month": 6})).json()
    assert money(month["total_amount"]) == money("11.00")

    page1 = (await client.get(f"/assets/{a['id']}/expenses", params={"page": 1, "page_size": 2})).json()
    page2 = (await client.get(f"/assets/{a['id']}/expenses", params={"page": 2, "page_size": 2})).json()
    assert len(page1["items"]) == 2 and len(page2["items"]) == 1
    # The period total is over every matching row, not just the requested page.
    assert money(page1["total_amount"]) == money(all_time["total_amount"])
    ids_page1 = {item["id"] for item in page1["items"]}
    ids_page2 = {item["id"] for item in page2["items"]}
    assert not (ids_page1 & ids_page2)  # no repeats across pages


async def test_report_requires_fx_and_never_returns_a_partial_total(client, account_id):
    a = await asset(client)
    eur_account_id = (await client.post("/accounts", json={"name": "Synthetic EUR", "currency": "EUR"})).json()["id"]
    await client.post("/transactions", json=txn_payload(eur_account_id, expense_asset_id=a["id"], date="2025-03-01"))
    missing_fx = await client.get(f"/assets/{a['id']}/expenses")
    assert missing_fx.status_code == 409, missing_fx.text
    assert missing_fx.json()["detail"]["code"] == "FX_RATE_MISSING"

    await rate(client, "2025-03-01")
    ok = await client.get(f"/assets/{a['id']}/expenses")
    assert ok.status_code == 200, ok.text
    assert money(ok.json()["total_amount"]) == money("10.00") * Decimal("1.1")


async def test_report_uses_the_reporting_override_not_the_raw_amount(client, account_id):
    a = await asset(client)
    created = await client.post("/transactions", json=txn_payload(
        account_id, expense_asset_id=a["id"], amount="100.00",
        reporting_amount_override="80.00", reporting_currency_override="USD", reporting_override_source="manual",
    ))
    assert created.status_code == 201, created.text
    report = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert money(report["total_amount"]) == money("80.00")
    assert money(report["items"][0]["native_amount"]) == money("100.00")


# --- Linked recurring templates surface in the report and post through --

async def test_report_lists_linked_templates_and_posting_updates_the_total(client, account_id):
    a = await asset(client)
    t = await template(client, account_id, expense_asset_id=a["id"], description="Synthetic utility bill")

    before = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert len(before["templates"]) == 1
    assert before["templates"][0]["id"] == t["id"]
    assert before["total_amount"] == "0" or money(before["total_amount"]) == 0

    posted = await client.post(f"/recurring/{t['id']}/post", json={"amount": "55.50"})
    assert posted.status_code == 201, posted.text
    posted_tx = (await client.get("/transactions")).json()["items"][0]
    assert posted_tx["expense_asset_id"] == a["id"]

    after = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert money(after["total_amount"]) == money("55.50")
    assert after["total"] == 1
    # The template's own stored amount is untouched by posting.
    unchanged = (await client.get("/recurring")).json()[0]
    assert money(unchanged["amount"]) == 10


async def test_template_link_rejected_for_non_expense_and_crypto_asset(client, account_id):
    a = await asset(client)
    rejected = await client.post("/recurring", json=dict(
        account_id=account_id, type="income", amount="10", description="Synthetic income",
        frequency="monthly", anchor_date=str(business_today()), expense_asset_id=a["id"],
    ))
    assert rejected.status_code == 400, rejected.text

    crypto_asset = await asset(client, asset_class="crypto", name="Synthetic coin 2")
    rejected_crypto = await client.post("/recurring", json=dict(
        account_id=account_id, type="expense", amount="10", description="Synthetic crypto-linked bill",
        frequency="monthly", anchor_date=str(business_today()), expense_asset_id=crypto_asset["id"],
    ))
    assert rejected_crypto.status_code == 400, rejected_crypto.text
    assert (await client.get("/recurring")).json() == []


# --- Editing/deleting a linked expense recomputes the asset's total ------

async def test_editing_and_deleting_a_linked_expense_updates_the_report(client, account_id):
    a = await asset(client)
    created = (await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"], amount="30.00"))).json()
    first = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert money(first["total_amount"]) == money("30.00")

    await client.patch(f"/transactions/{created['id']}", json={"amount": "45.00"})
    second = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert money(second["total_amount"]) == money("45.00")

    await client.delete(f"/transactions/{created['id']}")
    third = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert money(third["total_amount"]) == 0
    assert third["total"] == 0


# --- Backup roundtrip preserves all three new links ----------------------

async def test_backup_roundtrip_preserves_transaction_split_and_recurring_links(client, account_id, categories):
    a = await asset(client)
    groceries = categories["Groceries"]["id"]
    sweets = (await client.post(
        "/categories", json={"name": "Sweets5", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
    )).json()["id"]
    plain = (await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"]))).json()
    split = (await client.post("/transactions", json=txn_payload(
        account_id, amount="50.00", category_id=None,
        splits=[{"category_id": groceries, "amount": "20.00", "expense_asset_id": a["id"]},
                {"category_id": sweets, "amount": "30.00"}],
    ))).json()
    t = await template(client, account_id, expense_asset_id=a["id"], description="Synthetic backup bill")

    payload = (await client.get("/backup/export")).json()
    assert payload["aurum_backup_version"] == 11
    tx_backup = next(row for row in payload["transactions"] if row["id"] == plain["id"])
    assert tx_backup["expense_asset_id"] == a["id"]
    split_backup = next(row for row in payload["transaction_splits"] if money(row["amount"]) == money("20.00"))
    assert split_backup["expense_asset_id"] == a["id"]
    recurring_backup = next(row for row in payload["recurring_transactions"] if row["id"] == t["id"])
    assert recurring_backup["expense_asset_id"] == a["id"]

    imported = await client.post("/backup/import", json=payload)
    assert imported.status_code == 200, imported.text

    refetched = await client.get("/transactions")
    items = {row["id"]: row for row in refetched.json()["items"]}
    assert items[plain["id"]]["expense_asset_id"] == a["id"]
    refetched_split = next(s for s in items[split["id"]]["splits"] if money(s["amount"]) == money("20.00"))
    assert refetched_split["expense_asset_id"] == a["id"]
    refetched_recurring = next(r for r in (await client.get("/recurring")).json() if r["id"] == t["id"])
    assert refetched_recurring["expense_asset_id"] == a["id"]


async def test_backup_import_accepts_pre_v10_payload_defaulting_the_link_to_null(client, account_id):
    created = (await client.post("/transactions", json=txn_payload(account_id))).json()
    payload = (await client.get("/backup/export")).json()
    payload["aurum_backup_version"] = 9
    for row in payload["transactions"]:
        row.pop("expense_asset_id", None)
    for row in payload["transaction_splits"]:
        row.pop("expense_asset_id", None)
    for row in payload["recurring_transactions"]:
        row.pop("expense_asset_id", None)
    imported = await client.post("/backup/import", json=payload)
    assert imported.status_code == 200, imported.text
    refetched = next(t for t in (await client.get("/transactions")).json()["items"] if t["id"] == created["id"])
    assert refetched["expense_asset_id"] is None
