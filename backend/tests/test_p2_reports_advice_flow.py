"""One user's monthly figures must agree across summaries, reports and advice."""
from datetime import date

from httpx import AsyncClient

from tests.helpers import money, txn_payload


async def test_reports_alerts_and_advice_reconcile_then_expose_missing_fx(
    client: AsyncClient, account_id, categories
):
    today = date.today()
    period = {"year": today.year, "month": today.month}
    groceries = categories["Groceries"]["id"]
    dining = categories["Dining Out"]["id"]
    salary = categories["Salary"]["id"]

    empty_dashboard = (await client.get("/dashboard/summary", params=period)).json()
    assert money(empty_dashboard["net"]) == 0
    assert (await client.get("/cash-flow")).json()["points"] == []
    assert (await client.get("/reports/category-ranking")).json()["items"] == []
    assert (await client.get("/advice")).json()["items"] == []

    for kind, amount, category_id in [
        ("income", "1000", salary), ("expense", "200", groceries), ("expense", "50", dining),
    ]:
        created = await client.post("/transactions", json=txn_payload(
            account_id, type=kind, amount=amount, category_id=category_id, date=today.isoformat(),
        ))
        assert created.status_code == 201
    asset = await client.post("/assets", json={
        "name": "Synthetic asset", "asset_class": "other", "currency": "USD",
        "value": "500", "as_of_date": today.isoformat(),
    })
    assert asset.status_code == 201
    assert (await client.post("/budgets", json={"category_id": groceries, "monthly_limit": "100"})).status_code == 201

    dashboard = (await client.get("/dashboard/summary", params=period)).json()
    flow = (await client.get("/cash-flow", params={
        "start_date": today.isoformat(), "end_date": today.isoformat(),
    })).json()
    ranking = (await client.get("/reports/category-ranking", params={"kind": "expense"})).json()
    groceries_report = (await client.get("/reports/category-spending", params={"category_id": groceries})).json()
    capital = (await client.get("/net-worth/summary")).json()
    alerts = (await client.get("/insights/alerts")).json()
    advice = (await client.get("/advice")).json()

    assert (money(dashboard["real_income"]), money(dashboard["spent"]), money(dashboard["net"])) == (1000, 250, 750)
    assert (money(flow["total_income"]), money(flow["total_expense"]), money(flow["total_net"])) == (1000, 250, 750)
    assert money(ranking["total_amount"]) == 250
    assert {row["name"]: money(row["amount"]) for row in ranking["items"]} == {"Groceries": 200, "Dining Out": 50}
    assert money(groceries_report["total_amount"]) == 200
    assert money(capital["current"]) == 1250
    assert "budget_exceeded" in {row["key"] for row in alerts["alerts"]}
    assert any(row["key"] == "unbudgeted_top_category" and row["params"]["category"] == "Dining Out" for row in advice["items"])

    eur = (await client.post("/accounts", json={"name": "EUR", "currency": "EUR"})).json()["id"]
    assert (await client.post("/transactions", json=txn_payload(
        eur, type="income", amount="10", category_id=salary, date=today.isoformat(),
    ))).status_code == 201
    assert (await client.post("/transactions", json=txn_payload(
        eur, type="expense", amount="5", category_id=groceries, date=today.isoformat(),
    ))).status_code == 201
    for path, params in [
        ("/dashboard/summary", period), ("/cash-flow", {}),
        ("/reports/category-ranking", {}), ("/advice", {}),
    ]:
        response = await client.get(path, params=params)
        assert response.status_code == 409, (path, response.text)
