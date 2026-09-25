"""One split purchase must agree across the ledger, dashboard, reports and budgets."""
from decimal import Decimal


async def test_split_purchase_edit_and_delete_recalculate_every_view(client, account_id, categories):
    parent = categories["Groceries"]["id"]
    child_response = await client.post("/categories", json={
        "name": "P1 Sweets", "kind": "expense", "color": "#7a869a", "parent_id": parent,
    })
    assert child_response.status_code == 201, child_response.text
    child = child_response.json()["id"]
    for category, limit in ((parent, "120"), (child, "40")):
        response = await client.post("/budgets", json={"category_id": category, "monthly_limit": limit})
        assert response.status_code == 201, response.text

    date = "2026-09-10"
    opening = await client.post("/transactions", json={
        "account_id": account_id, "type": "adjustment", "amount": "500",
        "adjustment_reason": "opening_balance", "description": "P1 opening", "date": date,
    })
    assert opening.status_code == 201, opening.text

    def receipt(amount, parent_share, child_share):
        return {
            "account_id": account_id, "type": "expense", "amount": amount,
            "description": "P1 split purchase", "date": date,
            "splits": [
                {"category_id": parent, "amount": parent_share},
                {"category_id": child, "amount": child_share},
            ],
        }

    async def check(balance, spent, child_spent):
        account = next(row for row in (await client.get("/accounts")).json() if row["id"] == account_id)
        assert Decimal(account["balance"]) == Decimal(balance)
        dashboard = (await client.get("/dashboard/summary?year=2026&month=9")).json()
        assert Decimal(dashboard["spent"]) == Decimal(spent)
        status = (await client.get("/budgets/status?year=2026&month=9")).json()["items"]
        budgets = {row["category_id"]: row for row in status}
        assert Decimal(budgets[parent]["spent"]) == Decimal(spent)
        assert Decimal(budgets[parent]["remaining"]) == 120 - Decimal(spent)
        assert Decimal(budgets[child]["spent"]) == Decimal(child_spent)
        assert Decimal(budgets[child]["remaining"]) == 40 - Decimal(child_spent)
        for category, expected in ((parent, spent), (child, child_spent)):
            report = (await client.get("/reports/category-spending", params={
                "category_id": category, "start_date": "2026-09-01", "end_date": "2026-09-30",
            })).json()
            assert Decimal(report["total_amount"]) == Decimal(expected)

    created = await client.post("/transactions", json=receipt("100", "70", "30"))
    assert created.status_code == 201, created.text
    transaction_id = created.json()["id"]
    await check("400", "100", "30")

    edited = await client.patch(f"/transactions/{transaction_id}", json=receipt("80", "50", "30"))
    assert edited.status_code == 200, edited.text
    await check("420", "80", "30")

    deleted = await client.delete(f"/transactions/{transaction_id}")
    assert deleted.status_code == 204, deleted.text
    await check("500", "0", "0")
