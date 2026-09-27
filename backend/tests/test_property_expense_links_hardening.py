"""Follow-up hardening for docs/tasks/property-expense-links.md, covering
issues found in independent review of the first pass:

1. Reclassifying a *linked* asset to crypto is rejected (would make the
   very next export unrestorable — backup_service.py already refuses a
   crypto-class expense link on import).
2. GET /assets/{id}/expenses rejects an ambiguous month-without-year query
   and a year entirely in the future, instead of silently resolving to
   "all time" or a silently-empty start>end range.
8. A sparse PATCH that only changes `type` away from expense (splits
   omitted) can't silently keep a split line's own expense_asset_id.

Plus the explicitly requested financial-invariant regressions: an atomic
backup-import rejection for an unknown/crypto expense reference, a linked
recurring template posted with both an amount AND account override under
concurrent POSTs, and split-level FX/reporting-override exactness for
linked lines — real behavior, not a dict comparison.
"""
import asyncio
from datetime import date, timedelta
from decimal import Decimal

import pytest

from tests.helpers import money, txn_payload
from app.core.clock import business_today
from tests.test_property_expense_links import asset, rate
from tests.test_recurring import template


# --- 1: reclassifying a linked asset to crypto is blocked -----------------

async def test_reclassify_to_crypto_blocked_while_a_plain_expense_is_linked(client, account_id):
    a = await asset(client)
    created = (await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"]))).json()
    blocked = await client.patch(f"/assets/{a['id']}", json={"asset_class": "crypto"})
    assert blocked.status_code == 409, blocked.text

    await client.patch(f"/transactions/{created['id']}", json={"expense_asset_id": None})
    allowed = await client.patch(f"/assets/{a['id']}", json={"asset_class": "crypto"})
    assert allowed.status_code == 200, allowed.text


async def test_reclassify_to_crypto_blocked_while_a_split_line_is_linked(client, account_id, categories):
    a = await asset(client)
    groceries = categories["Groceries"]["id"]
    sweets = (await client.post(
        "/categories", json={"name": "HardeningSweets", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
    )).json()["id"]
    created = (await client.post("/transactions", json=txn_payload(
        account_id, amount="100.00", category_id=None,
        splits=[{"category_id": groceries, "amount": "60.00", "expense_asset_id": a["id"]},
                {"category_id": sweets, "amount": "40.00"}],
    ))).json()
    blocked = await client.patch(f"/assets/{a['id']}", json={"asset_class": "crypto"})
    assert blocked.status_code == 409, blocked.text

    await client.patch(f"/transactions/{created['id']}", json={"splits": [
        {"category_id": groceries, "amount": "60.00"}, {"category_id": sweets, "amount": "40.00"},
    ]})
    allowed = await client.patch(f"/assets/{a['id']}", json={"asset_class": "crypto"})
    assert allowed.status_code == 200, allowed.text


async def test_reclassify_to_crypto_blocked_while_a_recurring_template_is_linked(client, account_id):
    a = await asset(client)
    t = await template(client, account_id, expense_asset_id=a["id"])
    blocked = await client.patch(f"/assets/{a['id']}", json={"asset_class": "crypto"})
    assert blocked.status_code == 409, blocked.text

    await client.patch(f"/recurring/{t['id']}", json={"expense_asset_id": None})
    allowed = await client.patch(f"/assets/{a['id']}", json={"asset_class": "crypto"})
    assert allowed.status_code == 200, allowed.text


async def test_export_after_unlinked_crypto_reclassification_still_roundtrips(client, account_id):
    a = await asset(client)
    created = (await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"]))).json()
    await client.patch(f"/transactions/{created['id']}", json={"expense_asset_id": None})
    assert (await client.patch(f"/assets/{a['id']}", json={"asset_class": "crypto"})).status_code == 200
    payload = (await client.get("/backup/export")).json()
    imported = await client.post("/backup/import", json=payload)
    assert imported.status_code == 200, imported.text


# --- 2: /assets/{id}/expenses period query validation ----------------------

async def test_month_without_year_is_rejected_not_silently_treated_as_all_time(client, account_id):
    a = await asset(client)
    await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"], date="2025-06-15"))
    response = await client.get(f"/assets/{a['id']}/expenses", params={"month": 6})
    assert response.status_code == 422, response.text


async def test_year_entirely_in_the_future_is_rejected_not_a_silent_empty_range(client, account_id):
    a = await asset(client)
    future_year = business_today().year + 5
    response = await client.get(f"/assets/{a['id']}/expenses", params={"year": future_year})
    assert response.status_code == 422, response.text


async def test_current_year_future_month_still_resolves_to_a_legitimate_empty_period(client, account_id):
    # Not part of the fix: a *past* period within an otherwise valid year
    # (year <= current, month within 1..12) must keep resolving exactly as
    # dashboard_service._resolve_bounds already does elsewhere in the app —
    # this only guards against a regression narrowing that further.
    a = await asset(client)
    today = business_today()
    if today.month == 12:
        pytest.skip("no future month exists in December to exercise this case")
    response = await client.get(f"/assets/{a['id']}/expenses", params={"year": today.year, "month": 12})
    assert response.status_code == 200, response.text
    assert money(response.json()["total_amount"]) == 0


async def test_expenses_report_rejects_a_crypto_class_asset_outright(client, account_id):
    # A crypto-class Asset row is always a CryptoHolding's own shell (see
    # models/crypto.py) — it can never carry an expense_asset_id link, so
    # this report is a guaranteed dead end for one. Rejected explicitly
    # rather than silently returning a permanently-empty shape (see
    # routes/assets.py's get_asset_expenses and AssetsTable.tsx, which now
    # hides the "Expenses" action for a crypto row for the same reason).
    crypto_asset = await asset(client, asset_class="crypto", name="Synthetic report-check coin")
    response = await client.get(f"/assets/{crypto_asset['id']}/expenses")
    assert response.status_code == 400, response.text


# --- 8: sparse PATCH can't silently retain a split's own asset link -------

async def test_sparse_type_change_rejected_while_a_split_line_keeps_its_link(client, account_id, categories):
    a = await asset(client)
    groceries = categories["Groceries"]["id"]
    sweets = (await client.post(
        "/categories", json={"name": "HardeningSweets2", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
    )).json()["id"]
    created = (await client.post("/transactions", json=txn_payload(
        account_id, amount="100.00", category_id=None,
        splits=[{"category_id": groceries, "amount": "60.00", "expense_asset_id": a["id"]},
                {"category_id": sweets, "amount": "40.00"}],
    ))).json()

    # `splits` (and `category_id`) omitted entirely — the sparse-patch
    # case: the caller only meant to change `type`, and must not be able
    # to silently smuggle a split's own expense link through to a row
    # that's no longer even an expense.
    rejected = await client.patch(f"/transactions/{created['id']}", json={"type": "income"})
    assert rejected.status_code == 400, rejected.text
    unchanged = next(t for t in (await client.get("/transactions")).json()["items"] if t["id"] == created["id"])
    assert unchanged["type"] == "expense"
    linked_split = next(s for s in unchanged["splits"] if s["expense_asset_id"] == a["id"])
    assert linked_split is not None

    # Explicitly resending splits (clearing every line's link) in the same
    # request is accepted — same "same parent or its direct subcategories"
    # rule _build_splits already enforces for any other split, so the two
    # income categories here share one parent.
    income_salary = categories["Salary"]["id"]
    income_bonus = (await client.post(
        "/categories", json={"name": "HardeningBonus", "kind": "income", "color": "#7a869a", "parent_id": income_salary}
    )).json()["id"]
    accepted = await client.patch(f"/transactions/{created['id']}", json={
        "type": "income",
        "splits": [{"category_id": income_salary, "amount": "60.00"}, {"category_id": income_bonus, "amount": "40.00"}],
    })
    assert accepted.status_code == 200, accepted.text
    report = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert money(report["total_amount"]) == 0


async def test_sparse_amount_only_patch_on_a_linked_split_expense_stays_accepted(client, account_id, categories):
    # The fix must not over-reject: changing an unrelated field (amount,
    # description, ...) while type stays "expense" and splits stay omitted
    # keeps working exactly as before — this is the "no regression on the
    # common case" counterpart to the rejection test above.
    a = await asset(client)
    groceries = categories["Groceries"]["id"]
    sweets = (await client.post(
        "/categories", json={"name": "HardeningSweets3", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
    )).json()["id"]
    created = (await client.post("/transactions", json=txn_payload(
        account_id, amount="100.00", category_id=None, description="Sparse patch keeps link",
        splits=[{"category_id": groceries, "amount": "60.00", "expense_asset_id": a["id"]},
                {"category_id": sweets, "amount": "40.00"}],
    ))).json()
    ok = await client.patch(f"/transactions/{created['id']}", json={"description": "Renamed, still expense"})
    assert ok.status_code == 200, ok.text
    report = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert money(report["total_amount"]) == money("60.00")


# --- Backup import: atomic rejection of an unknown/crypto expense link -----

async def test_backup_import_rejects_unknown_expense_asset_id_atomically(client, account_id):
    a = await asset(client)
    created = (await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"]))).json()
    good = (await client.get("/backup/export")).json()

    corrupt = {**good, "transactions": [
        {**t, "expense_asset_id": 999999} if t["id"] == created["id"] else t for t in good["transactions"]
    ]}
    rejected = await client.post("/backup/import", json=corrupt)
    assert rejected.status_code == 400, rejected.text
    # Atomic: the previously-imported (good) state is exactly what's still there.
    still_there = next(t for t in (await client.get("/transactions")).json()["items"] if t["id"] == created["id"])
    assert still_there["expense_asset_id"] == a["id"]


async def test_backup_import_rejects_crypto_expense_asset_id_atomically(client, account_id):
    a = await asset(client)
    crypto_asset = await asset(client, asset_class="crypto", name="Synthetic hardening coin")
    created = (await client.post("/transactions", json=txn_payload(account_id, expense_asset_id=a["id"]))).json()
    good = (await client.get("/backup/export")).json()

    corrupt = {**good, "transactions": [
        {**t, "expense_asset_id": crypto_asset["id"]} if t["id"] == created["id"] else t for t in good["transactions"]
    ]}
    rejected = await client.post("/backup/import", json=corrupt)
    assert rejected.status_code == 422, rejected.text
    still_there = next(t for t in (await client.get("/transactions")).json()["items"] if t["id"] == created["id"])
    assert still_there["expense_asset_id"] == a["id"]


# --- Linked recurring: actual override + account change + concurrency -----

async def test_linked_template_posts_actual_amount_and_account_under_concurrent_posts(client, account_id):
    a = await asset(client)
    other_account = (await client.post("/accounts", json={"name": "Hardening other account", "currency": "USD"})).json()
    t = await template(client, account_id, expense_asset_id=a["id"], description="Hardening concurrent bill")

    responses = await asyncio.gather(*(
        client.post(f"/recurring/{t['id']}/post", json={"amount": "88.88", "account_id": other_account["id"]})
        for _ in range(2)
    ))
    assert sorted(r.status_code for r in responses) == [201, 409]

    transactions = (await client.get("/transactions")).json()
    matching = [row for row in transactions["items"] if row["description"] == "Hardening concurrent bill"]
    assert len(matching) == 1
    posted = matching[0]
    assert posted["account_id"] == other_account["id"]
    assert money(posted["amount"]) == money("88.88")
    assert posted["expense_asset_id"] == a["id"]

    report = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert money(report["total_amount"]) == money("88.88")
    assert report["total"] == 1

    unchanged = next(r for r in (await client.get("/recurring")).json() if r["id"] == t["id"])
    assert money(unchanged["amount"]) == 10 and unchanged["account_id"] == account_id

    other = [r for r in (await client.get("/accounts")).json() if r["id"] == other_account["id"]][0]
    assert money(other["balance"]) == money("-88.88")


# --- Split-level FX / reporting-override exactness for linked lines -------

async def test_linked_split_lines_convert_through_historical_fx_exactly(client, account_id):
    a = await asset(client)
    eur_account_id = (await client.post("/accounts", json={"name": "Hardening EUR", "currency": "EUR"})).json()["id"]
    await rate(client, "2025-04-01", base="EUR", quote="USD", value="1.2345")
    groceries_resp = await client.get("/categories")
    groceries = next(c for c in groceries_resp.json() if c["name"] == "Groceries")
    sweets = (await client.post(
        "/categories", json={"name": "HardeningFxSweets", "kind": "expense", "color": "#7a869a", "parent_id": groceries["id"]}
    )).json()["id"]
    created = (await client.post("/transactions", json=txn_payload(
        eur_account_id, amount="100.00", category_id=None, date="2025-04-01",
        splits=[{"category_id": groceries["id"], "amount": "60.00", "expense_asset_id": a["id"]},
                {"category_id": sweets, "amount": "40.00"}],
    ))).json()

    report = (await client.get(f"/assets/{a['id']}/expenses")).json()
    # The linked line is 60% of a 100 EUR purchase converted at the exact
    # historical rate — same largest-remainder split allocation
    # fx_service.py's FXConverter.splits() uses for every other report,
    # never a plain 60% of the whole converted total computed
    # independently (which can drift by a rounding unit from the real
    # per-line allocation).
    assert Decimal(report["items"][0]["native_amount"]) == Decimal("60.00")
    # 100 EUR * 1.2345 = 123.45 USD total; the 60/100 line's exact share
    # under largest-remainder allocation from that same rounded total.
    assert money(report["total_amount"]) == money("74.07")


async def test_linked_plain_expense_uses_reporting_override_exactly_not_native_times_rate(client, account_id):
    a = await asset(client)
    created = await client.post("/transactions", json=txn_payload(
        account_id, expense_asset_id=a["id"], amount="1000.00",
        reporting_amount_override="123.45", reporting_currency_override="USD", reporting_override_source="manual",
    ))
    assert created.status_code == 201, created.text
    report = (await client.get(f"/assets/{a['id']}/expenses")).json()
    assert money(report["total_amount"]) == money("123.45")
    assert money(report["items"][0]["native_amount"]) == money("1000.00")
