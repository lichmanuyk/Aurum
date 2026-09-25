"""Connected daily-ledger and restore checks on the isolated test database."""
from copy import deepcopy
from datetime import date
from decimal import Decimal

from app.services import crypto_service
from tests.test_crypto import _fake_fetch, _point


async def test_mixed_backup_restores_balances_reports_and_capital(client, categories, monkeypatch):
    monkeypatch.setattr(crypto_service, "_fetch_market_data", _fake_fetch({"bitcoin": _point("200")}))
    today = str(date.today())
    salary = categories["Salary"]["id"]
    groceries = categories["Groceries"]["id"]

    async def create(path, payload):
        response = await client.post(path, json=payload)
        assert response.status_code == 201, response.text
        return response.json()

    cash = await create("/accounts", {"name": "Daily cash", "currency": "USD"})
    savings = await create("/accounts", {"name": "Savings", "currency": "USD"})
    account, destination = cash["id"], savings["id"]
    for kind, amount, category in (("income", "1000", salary), ("expense", "120", groceries)):
        await create("/transactions", {"account_id": account, "type": kind, "amount": amount,
                                       "category_id": category, "description": kind, "date": today})
    await create("/transactions", {"account_id": account, "type": "transfer", "amount": "300",
                                   "transfer_account_id": destination, "destination_amount": "300",
                                   "description": "Savings transfer", "date": today})
    await create("/assets", {"name": "Equipment", "asset_class": "other", "currency": "USD",
                             "value": "50", "as_of_date": today})
    await create("/crypto/holdings", {"coingecko_id": "bitcoin", "symbol": "BTC", "name": "Bitcoin",
                                      "quantity": "2", "date": today})

    async def outcomes():
        balances = {row["id"]: Decimal(row["balance"]) for row in (await client.get("/accounts")).json()}
        dashboard = (await client.get("/dashboard/summary", params={"year": date.today().year,
                                                                      "month": date.today().month})).json()
        flow = (await client.get("/cash-flow")).json()
        capital = (await client.get("/net-worth/summary")).json()
        report = (await client.get("/reports/category-spending", params={"category_id": groceries})).json()
        return balances, dashboard, flow, capital, report

    before = await outcomes()
    assert before[0][account] == 580 and before[0][destination] == 300
    assert Decimal(before[1]["real_income"]) == 1000 and Decimal(before[1]["spent"]) == 120
    assert Decimal(before[2]["total_net"]) == 880
    assert Decimal(before[3]["current"]) == 1330
    assert Decimal(before[4]["total_amount"]) == 120

    backup = (await client.get("/backup/export")).json()
    assert backup["aurum_backup_version"] == 5
    assert len(backup["transactions"]) == 3 and len(backup["crypto_transactions"]) == 1
    async def assert_same_data():
        exported = (await client.get("/backup/export")).json()
        exported.pop("exported_at")
        assert exported == {key: value for key, value in backup.items() if key != "exported_at"}

    await create("/transactions", {"account_id": account, "type": "expense", "amount": "10",
                                   "description": "Temporary change", "date": today})
    assert (await client.post("/backup/import", json=backup)).status_code == 200
    await assert_same_data()
    assert await outcomes() == before

    damaged = deepcopy(backup)
    damaged["transactions"][0]["account_id"] = 999999
    assert (await client.post("/backup/import", json=damaged)).status_code in (400, 422)
    await assert_same_data()
    assert await outcomes() == before
