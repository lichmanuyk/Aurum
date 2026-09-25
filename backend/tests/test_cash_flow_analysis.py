"""Cash Flow's two new category lists (see docs/tasks/cash-flow-analysis.md)
reuse /reports/category-ranking as-is for both "income" and "expense" kinds
— see reports_service.get_category_ranking_report and
category_rollup.rollup_spending_by_top_level_category. Split-purchase
rollup and currency handling for that endpoint are already covered by
test_reports.py and test_cash_flow_reports_currency.py; this file covers
what's specific to reusing it for two independent kind-scoped lists: income
ranking itself, and that transfers/adjustments/asset trades — the
transaction kinds Cash Flow's chart already excludes from its totals — can
never leak into either category list.
"""
from datetime import date, timedelta
from decimal import Decimal

from httpx import AsyncClient

from tests.helpers import money, txn_payload as _txn


async def test_income_ranking_sorted_descending_with_percent_scoped_to_income_total(
    client: AsyncClient, account_id, categories
):
    salary = categories["Salary"]["id"]
    gift = (
        await client.post("/categories", json={"name": "Gifts", "kind": "income", "color": "#7a869a"})
    ).json()["id"]
    await client.post("/transactions", json=_txn(account_id, type="income", amount="300.00", category_id=gift, date="2026-08-01"))
    await client.post("/transactions", json=_txn(account_id, type="income", amount="700.00", category_id=salary, date="2026-08-02"))
    # An expense in the same period must not affect the income list's own total/percentages.
    await client.post("/transactions", json=_txn(account_id, type="expense", amount="9999.00", category_id=categories["Groceries"]["id"], date="2026-08-03"))

    resp = await client.get("/reports/category-ranking", params={"kind": "income"})
    body = resp.json()
    assert [item["name"] for item in body["items"]] == ["Salary", "Gifts"]
    assert money(body["items"][0]["amount"]) == Decimal("700.00")
    assert money(body["items"][0]["percent"]) == Decimal("70")
    assert money(body["items"][1]["percent"]) == Decimal("30")


async def test_ranking_never_includes_transfers_adjustments_or_asset_trades_in_either_list(
    client: AsyncClient, account_id, categories
):
    """Synthetic scenario mirroring the task's acceptance criteria: an
    income, an expense, a transfer between own accounts, an opening-balance
    adjustment and a manual asset purchase all in the same period — only
    the income and the expense may surface in the two ranking lists."""
    today = date.today()
    salary = categories["Salary"]["id"]
    groceries = categories["Groceries"]["id"]

    other_account = (await client.post("/accounts", json={"name": "Savings", "type": "savings", "currency": "USD"})).json()["id"]
    await client.post("/transactions", json=_txn(account_id, type="adjustment", amount="1000.00", adjustment_reason="opening_balance", date=str(today - timedelta(days=2))))
    await client.post("/transactions", json=_txn(account_id, type="income", amount="500.00", category_id=salary, date=str(today)))
    await client.post("/transactions", json=_txn(account_id, type="expense", amount="120.00", category_id=groceries, date=str(today)))
    await client.post("/transactions", json=_txn(account_id, type="transfer", amount="200.00", transfer_account_id=other_account, date=str(today)))

    asset = (await client.post("/assets", json={"name": "Synthetic investment", "asset_class": "investments", "currency": "USD", "value": "0", "as_of_date": str(today - timedelta(days=1))})).json()
    await client.post(
        "/asset-movements",
        json=dict(asset_id=asset["id"], account_id=account_id, type="buy", gross_amount="150", fee_amount="0",
                   asset_value_after="150", date=str(today), idempotency_key="analysis-test-buy-001"),
    )

    income_items = (await client.get("/reports/category-ranking", params={"kind": "income"})).json()["items"]
    expense_items = (await client.get("/reports/category-ranking", params={"kind": "expense"})).json()["items"]

    assert [item["name"] for item in income_items] == ["Salary"]
    assert money(income_items[0]["amount"]) == Decimal("500.00")
    assert [item["name"] for item in expense_items] == ["Groceries"]
    assert money(expense_items[0]["amount"]) == Decimal("120.00")

    # The chart's own totals for the same period stay in lockstep with the
    # two lists — same exclusions, same amounts.
    cash_flow = (await client.get("/cash-flow", params={"start_date": str(today - timedelta(days=3)), "end_date": str(today)})).json()
    assert money(cash_flow["total_income"]) == Decimal("500.00")
    assert money(cash_flow["total_expense"]) == Decimal("120.00")
