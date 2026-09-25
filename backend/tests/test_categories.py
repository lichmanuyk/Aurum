"""Category subcategories (parent_id): creation rules and the one-level-deep
invariant enforced in api/routes/categories.py. Category deletion is blocked
while any transaction or split references it, preserving reporting history.
"""
from httpx import AsyncClient

from tests.helpers import txn_payload as _txn


async def test_create_subcategory_under_top_level_category(client: AsyncClient, categories):
    groceries = categories["Groceries"]["id"]
    resp = await client.post(
        "/categories", json={"name": "Alcohol", "kind": "expense", "color": "#e34948", "parent_id": groceries}
    )
    assert resp.status_code == 201
    assert resp.json()["parent_id"] == groceries


async def test_subcategory_cannot_have_a_different_kind_than_its_parent(client: AsyncClient, categories):
    groceries = categories["Groceries"]["id"]
    resp = await client.post(
        "/categories", json={"name": "Bad", "kind": "income", "color": "#e34948", "parent_id": groceries}
    )
    assert resp.status_code == 400


async def test_subcategories_are_only_one_level_deep(client: AsyncClient, categories):
    groceries = categories["Groceries"]["id"]
    child = await client.post(
        "/categories", json={"name": "Alcohol", "kind": "expense", "color": "#e34948", "parent_id": groceries}
    )
    child_id = child.json()["id"]

    resp = await client.post(
        "/categories", json={"name": "Wine", "kind": "expense", "color": "#e34948", "parent_id": child_id}
    )
    assert resp.status_code == 400


async def test_category_cannot_be_its_own_parent(client: AsyncClient, categories):
    groceries = categories["Groceries"]["id"]
    resp = await client.patch(f"/categories/{groceries}", json={"parent_id": groceries})
    assert resp.status_code == 400


async def test_a_category_with_subcategories_cannot_itself_become_a_subcategory(client: AsyncClient, categories):
    groceries = categories["Groceries"]["id"]
    dining = categories["Dining Out"]["id"]
    await client.post(
        "/categories", json={"name": "Alcohol", "kind": "expense", "color": "#e34948", "parent_id": groceries}
    )

    resp = await client.patch(f"/categories/{groceries}", json={"parent_id": dining})
    assert resp.status_code == 400


async def test_deleting_a_parent_leaves_children_as_top_level(client: AsyncClient, categories):
    # A default category with transactions can't be deleted (separate rule,
    # tested below) — use a fresh, non-default parent so this test isolates
    # the parent/child rule.
    parent = await client.post("/categories", json={"name": "Custom Parent", "kind": "expense", "color": "#e34948"})
    parent_id = parent.json()["id"]
    created = await client.post(
        "/categories", json={"name": "Alcohol", "kind": "expense", "color": "#e34948", "parent_id": parent_id}
    )
    child_id = created.json()["id"]

    resp = await client.delete(f"/categories/{parent_id}")
    assert resp.status_code == 204

    refetched = await client.get("/categories")
    child = next(c for c in refetched.json() if c["id"] == child_id)
    assert child["parent_id"] is None


async def test_default_category_with_no_transactions_can_be_deleted(client: AsyncClient, categories):
    groceries = categories["Groceries"]["id"]
    assert categories["Groceries"]["is_default"] is True

    resp = await client.delete(f"/categories/{groceries}")
    assert resp.status_code == 204

    refetched = await client.get("/categories")
    assert groceries not in [c["id"] for c in refetched.json()]


async def test_default_category_with_a_transaction_cannot_be_deleted(client: AsyncClient, account_id, categories):
    groceries = categories["Groceries"]["id"]
    await client.post("/transactions", json=_txn(account_id, category_id=groceries))

    resp = await client.delete(f"/categories/{groceries}")
    assert resp.status_code == 400

    refetched = await client.get("/categories")
    assert groceries in [c["id"] for c in refetched.json()]


async def test_default_category_used_only_by_a_split_line_cannot_be_deleted(client: AsyncClient, account_id, categories):
    groceries = categories["Groceries"]["id"]
    sweets = (
        await client.post(
            "/categories", json={"name": "Sweets", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
        )
    ).json()["id"]
    await client.post(
        "/transactions",
        json=_txn(
            account_id,
            amount="100.00",
            category_id=None,
            splits=[
                {"category_id": groceries, "amount": "70.00"},
                {"category_id": sweets, "amount": "30.00"},
            ],
        ),
    )

    resp = await client.delete(f"/categories/{groceries}")
    assert resp.status_code == 400


async def test_default_category_becomes_deletable_once_its_transaction_is_removed(
    client: AsyncClient, account_id, categories
):
    groceries = categories["Groceries"]["id"]
    created = await client.post("/transactions", json=_txn(account_id, category_id=groceries))
    txn_id = created.json()["id"]

    blocked = await client.delete(f"/categories/{groceries}")
    assert blocked.status_code == 400

    assert (await client.delete(f"/transactions/{txn_id}")).status_code == 204

    resp = await client.delete(f"/categories/{groceries}")
    assert resp.status_code == 204


async def test_custom_category_keeps_transaction_history_until_unused(client: AsyncClient, account_id):
    category_id = (await client.post(
        "/categories", json={"name": "Custom", "kind": "expense", "color": "#e34948"}
    )).json()["id"]
    created = await client.post("/transactions", json=_txn(account_id, category_id=category_id))
    txn_id = created.json()["id"]

    assert (await client.delete(f"/categories/{category_id}")).status_code == 400
    rows = (await client.get("/transactions", params={"category_id": category_id})).json()
    assert rows["total"] == 1
    assert rows["items"][0]["category"]["name"] == "Custom"
    assert (await client.patch(f"/categories/{category_id}", json={"name": "Renamed"})).status_code == 200
    assert (await client.get("/transactions", params={"category_id": category_id})).json()["items"][0]["category"]["name"] == "Renamed"

    assert (await client.delete(f"/transactions/{txn_id}")).status_code == 204
    assert (await client.delete(f"/categories/{category_id}")).status_code == 204


async def test_custom_subcategory_used_by_split_cannot_be_deleted(client: AsyncClient, account_id):
    category_id = (await client.post(
        "/categories", json={"name": "Custom", "kind": "expense", "color": "#e34948"}
    )).json()["id"]
    child_id = (await client.post(
        "/categories", json={"name": "Child", "kind": "expense", "color": "#e34948", "parent_id": category_id}
    )).json()["id"]
    created = await client.post("/transactions", json=_txn(
        account_id, amount="10", category_id=None,
        splits=[{"category_id": child_id, "amount": "6"}, {"category_id": category_id, "amount": "4"}],
    ))
    assert created.status_code == 201
    assert (await client.delete(f"/categories/{child_id}")).status_code == 400
    rows = (await client.get("/transactions")).json()["items"]
    assert next(row for row in rows if row["id"] == created.json()["id"])["splits"][0]["category_id"] == child_id


async def test_category_with_budget_cannot_be_deleted(client: AsyncClient):
    category_id = (await client.post(
        "/categories", json={"name": "Custom", "kind": "expense", "color": "#e34948"}
    )).json()["id"]
    created = await client.post("/budgets", json={"category_id": category_id, "monthly_limit": "100"})
    assert created.status_code == 201
    assert (await client.delete(f"/categories/{category_id}")).status_code == 400
    assert (await client.get("/budgets")).json()[0]["category_id"] == category_id


async def test_parent_with_used_child_keeps_historical_grouping(client: AsyncClient, account_id):
    parent_id = (await client.post(
        "/categories", json={"name": "Parent", "kind": "expense", "color": "#e34948"}
    )).json()["id"]
    child_id = (await client.post(
        "/categories", json={"name": "Child", "kind": "expense", "color": "#e34948", "parent_id": parent_id}
    )).json()["id"]
    assert (await client.post("/transactions", json=_txn(account_id, category_id=child_id))).status_code == 201
    assert (await client.delete(f"/categories/{parent_id}")).status_code == 400
    child = next(row for row in (await client.get("/categories")).json() if row["id"] == child_id)
    assert child["parent_id"] == parent_id
