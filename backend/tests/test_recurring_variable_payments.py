"""The actual amount/account of a posted expense template (see
docs/tasks/recurring-variable-payments.md) — the template's own stored
amount/account never change, only what gets posted this one time.
"""
import asyncio
from datetime import date, timedelta
from decimal import Decimal

import pytest

from tests.test_recurring import template


async def eur_account(client):
    response = await client.post("/accounts", json=dict(name="Synthetic EUR", currency="EUR"))
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def usd_account(client):
    response = await client.post("/accounts", json=dict(name="Synthetic USD 2", currency="USD"))
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def test_bare_post_keeps_posting_the_templates_own_amount_and_account_unchanged(client, account_id):
    t = await template(client, account_id)
    response = await client.post(f"/recurring/{t['id']}/post")
    assert response.status_code == 201, response.text
    row = (await client.get("/transactions")).json()["items"][0]
    assert Decimal(row["amount"]) == 10 and row["account_id"] == account_id
    recurring = (await client.get("/recurring")).json()[0]
    assert Decimal(recurring["amount"]) == 10 and recurring["account_id"] == account_id


async def test_amount_override_posts_the_actual_figure_and_leaves_the_template_alone(client, account_id):
    t = await template(client, account_id)
    response = await client.post(f"/recurring/{t['id']}/post", json={"amount": "123.45"})
    assert response.status_code == 201, response.text
    row = (await client.get("/transactions")).json()["items"][0]
    assert Decimal(row["amount"]) == Decimal("123.45")
    recurring = (await client.get("/recurring")).json()[0]
    assert Decimal(recurring["amount"]) == 10  # template's own stored amount is untouched
    assert Decimal((await client.get("/accounts")).json()[0]["balance"]) == Decimal("-123.45")


async def test_account_override_same_currency_posts_to_the_chosen_account_without_an_explicit_amount(client, account_id):
    other = await usd_account(client)
    t = await template(client, account_id)
    response = await client.post(f"/recurring/{t['id']}/post", json={"account_id": other})
    assert response.status_code == 201, response.text
    row = (await client.get("/transactions")).json()["items"][0]
    assert row["account_id"] == other and Decimal(row["amount"]) == 10
    recurring = (await client.get("/recurring")).json()[0]
    assert recurring["account_id"] == account_id  # template's own account is untouched


async def test_different_currency_account_requires_an_explicit_amount_not_a_recalculated_or_reused_one(client, account_id):
    eur = await eur_account(client)
    t = await template(client, account_id)
    rejected = await client.post(f"/recurring/{t['id']}/post", json={"account_id": eur})
    assert rejected.status_code == 422, rejected.text
    assert (await client.get("/transactions")).json()["total"] == 0
    assert (await client.get("/recurring")).json()[0]["last_posted_date"] is None

    accepted = await client.post(f"/recurring/{t['id']}/post", json={"account_id": eur, "amount": "9.50"})
    assert accepted.status_code == 201, accepted.text
    row = (await client.get("/transactions")).json()["items"][0]
    assert row["account_id"] == eur and Decimal(row["amount"]) == Decimal("9.50")
    eur_row = next(a for a in (await client.get("/accounts")).json() if a["id"] == eur)
    assert Decimal(eur_row["balance"]) == Decimal("-9.50")


@pytest.mark.parametrize("bad_amount", ["0", "-5", "1.1234567", "1" + "0" * 18])
async def test_invalid_amount_overrides_are_rejected_without_advancing_the_schedule(client, account_id, bad_amount):
    t = await template(client, account_id)
    response = await client.post(f"/recurring/{t['id']}/post", json={"amount": bad_amount})
    assert response.status_code == 422, response.text
    assert (await client.get("/transactions")).json()["total"] == 0
    assert (await client.get("/recurring")).json()[0]["last_posted_date"] is None


async def test_nonexistent_or_archived_account_override_is_rejected(client, account_id):
    t = await template(client, account_id)
    missing = await client.post(f"/recurring/{t['id']}/post", json={"account_id": 999999})
    assert missing.status_code == 422, missing.text

    archived_id = await usd_account(client)
    assert (await client.patch(f"/accounts/{archived_id}", json={"is_archived": True})).status_code == 200
    archived = await client.post(f"/recurring/{t['id']}/post", json={"account_id": archived_id})
    assert archived.status_code == 422, archived.text
    assert (await client.get("/transactions")).json()["total"] == 0
    assert (await client.get("/recurring")).json()[0]["last_posted_date"] is None


@pytest.mark.parametrize("field", ["amount", "account_id"])
async def test_explicit_null_override_is_rejected_not_treated_as_unset(client, account_id, field):
    t = await template(client, account_id)
    response = await client.post(f"/recurring/{t['id']}/post", json={field: None})
    assert response.status_code == 422, response.text
    assert (await client.get("/transactions")).json()["total"] == 0
    assert (await client.get("/recurring")).json()[0]["last_posted_date"] is None


@pytest.mark.parametrize("recurring_type,changes", [
    ("income", {}),
    ("transfer", {"transfer_account_id": None}),  # filled in below, EUR target
])
async def test_amount_and_account_overrides_are_rejected_for_income_and_transfer_not_silently_dropped(client, account_id, recurring_type, changes):
    if recurring_type == "transfer":
        changes = {"transfer_account_id": await eur_account(client)}
    t = await template(client, account_id, type=recurring_type, **changes)
    for override in ({"amount": "5"}, {"account_id": account_id}):
        response = await client.post(f"/recurring/{t['id']}/post", json=override)
        assert response.status_code == 422, response.text
    assert (await client.get("/transactions")).json()["total"] == 0
    assert (await client.get("/recurring")).json()[0]["last_posted_date"] is None


async def test_retry_with_corrected_amount_succeeds_after_a_failed_validation(client, account_id):
    t = await template(client, account_id)
    failed = await client.post(f"/recurring/{t['id']}/post", json={"amount": "0"})
    assert failed.status_code == 422
    ok = await client.post(f"/recurring/{t['id']}/post", json={"amount": "42"})
    assert ok.status_code == 201, ok.text
    assert (await client.get("/transactions")).json()["total"] == 1


async def test_concurrent_overridden_posts_create_exactly_one_transaction_and_one_balance_change(client, account_id):
    t = await template(client, account_id)
    responses = await asyncio.gather(*(
        client.post(f"/recurring/{t['id']}/post", json={"amount": "77.00"}) for _ in range(2)
    ))
    assert sorted(r.status_code for r in responses) == [201, 409]
    rows = (await client.get("/transactions")).json()
    assert rows["total"] == 1 and Decimal(rows["items"][0]["amount"]) == Decimal("77.00")
    assert Decimal((await client.get("/accounts")).json()[0]["balance"]) == Decimal("-77.00")
    assert (await client.get("/recurring")).json()[0]["last_posted_date"] == str(date.today())


async def test_409_carries_a_distinct_code_for_each_of_its_three_causes(client, account_id):
    # A lost-response retry (ALREADY_POSTED) is the one case where the
    # client needs to reconcile balances/reports — the other two never
    # posted anything, so the client must be able to tell them apart
    # (see docs/tasks/recurring-variable-payments.md).
    posted = await template(client, account_id)
    assert (await client.post(f"/recurring/{posted['id']}/post")).status_code == 201
    already_posted = await client.post(f"/recurring/{posted['id']}/post")
    assert already_posted.status_code == 409
    assert already_posted.json()["detail"]["code"] == "ALREADY_POSTED"

    tomorrow = str(date.today() + timedelta(days=1))
    not_due = await template(client, account_id, anchor_date=tomorrow, description="Synthetic not due yet")
    not_due_response = await client.post(f"/recurring/{not_due['id']}/post")
    assert not_due_response.status_code == 409
    assert not_due_response.json()["detail"]["code"] == "TEMPLATE_NOT_DUE"

    inactive = await template(client, account_id, description="Synthetic inactive")
    assert (await client.patch(f"/recurring/{inactive['id']}", json={"is_active": False})).status_code == 200
    inactive_response = await client.post(f"/recurring/{inactive['id']}/post")
    assert inactive_response.status_code == 409
    assert inactive_response.json()["detail"]["code"] == "TEMPLATE_INACTIVE"


async def test_already_posted_takes_priority_over_inactive_when_both_are_true(client, account_id):
    # A template deactivated right after being posted today is *both*
    # inactive and already posted — ALREADY_POSTED must still win, since
    # that's the one fact the client actually needs to act on.
    t = await template(client, account_id)
    assert (await client.post(f"/recurring/{t['id']}/post")).status_code == 201
    assert (await client.patch(f"/recurring/{t['id']}", json={"is_active": False})).status_code == 200
    response = await client.post(f"/recurring/{t['id']}/post")
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "ALREADY_POSTED"
