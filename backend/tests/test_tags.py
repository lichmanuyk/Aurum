"""Tags: CRUD, case-insensitive dedup on create, and their use on
transactions (create/update with tag_ids, filtering by tag_id).
"""
from httpx import AsyncClient

from tests.helpers import txn_payload as _txn


async def test_create_tag(client: AsyncClient):
    resp = await client.post("/tags", json={"name": "Georgia Trip"})
    assert resp.status_code == 201
    assert resp.json()["name"] == "Georgia Trip"


async def test_create_tag_dedups_case_insensitively(client: AsyncClient):
    first = await client.post("/tags", json={"name": "Tax Deductible"})
    second = await client.post("/tags", json={"name": "tax deductible"})

    assert first.json()["id"] == second.json()["id"]
    assert len((await client.get("/tags")).json()) == 1


async def test_delete_tag(client: AsyncClient):
    created = await client.post("/tags", json={"name": "Temp"})
    resp = await client.delete(f"/tags/{created.json()['id']}")
    assert resp.status_code == 204
    assert (await client.get("/tags")).json() == []


async def test_create_transaction_with_tags(client: AsyncClient, account_id, categories):
    tag = await client.post("/tags", json={"name": "Georgia"})
    tag_id = tag.json()["id"]

    resp = await client.post(
        "/transactions",
        json=_txn(account_id, category_id=categories["Groceries"]["id"], tag_ids=[tag_id]),
    )
    assert resp.status_code == 201
    assert [t["id"] for t in resp.json()["tags"]] == [tag_id]


async def test_update_transaction_replaces_tags(client: AsyncClient, account_id, categories):
    tag_a = (await client.post("/tags", json={"name": "A"})).json()["id"]
    tag_b = (await client.post("/tags", json={"name": "B"})).json()["id"]
    created = await client.post(
        "/transactions", json=_txn(account_id, category_id=categories["Groceries"]["id"], tag_ids=[tag_a])
    )
    txn_id = created.json()["id"]

    resp = await client.patch(f"/transactions/{txn_id}", json={"tag_ids": [tag_b]})
    assert [t["id"] for t in resp.json()["tags"]] == [tag_b]

    # Omitting tag_ids entirely leaves the existing tags untouched.
    resp = await client.patch(f"/transactions/{txn_id}", json={"description": "renamed"})
    assert [t["id"] for t in resp.json()["tags"]] == [tag_b]

    # Sending an empty list clears them.
    resp = await client.patch(f"/transactions/{txn_id}", json={"tag_ids": []})
    assert resp.json()["tags"] == []


async def test_create_transaction_rejects_unknown_tag_id(client: AsyncClient, account_id, categories):
    resp = await client.post(
        "/transactions",
        json=_txn(account_id, category_id=categories["Groceries"]["id"], tag_ids=[999999]),
    )
    assert resp.status_code == 400


async def test_filter_transactions_by_tag(client: AsyncClient, account_id, categories):
    tag = (await client.post("/tags", json={"name": "Filtered"})).json()["id"]
    await client.post(
        "/transactions", json=_txn(account_id, category_id=categories["Groceries"]["id"], tag_ids=[tag])
    )
    await client.post("/transactions", json=_txn(account_id, category_id=categories["Groceries"]["id"]))

    resp = await client.get("/transactions", params={"tag_id": tag})
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["tags"][0]["id"] == tag


async def test_deleting_used_tag_keeps_the_transaction(client: AsyncClient, account_id, categories):
    tag_id = (await client.post("/tags", json={"name": "Temporary"})).json()["id"]
    category_id = categories["Groceries"]["id"]
    created = await client.post(
        "/transactions", json=_txn(account_id, category_id=category_id, tag_ids=[tag_id])
    )
    transaction_id = created.json()["id"]

    assert (await client.delete(f"/tags/{tag_id}")).status_code == 204
    rows = (await client.get("/transactions", params={"category_id": category_id})).json()
    assert rows["total"] == 1
    assert rows["items"][0]["id"] == transaction_id
    assert rows["items"][0]["tags"] == []
    assert rows["items"][0]["category"]["id"] == category_id
