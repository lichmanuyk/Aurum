"""Gross work income vs. mandatory ZUS/PPE/VAT payments — see
docs/tasks/income-tax-separation.md. Synthetic-only, no personal fixtures.
Covers the two-axis model (real `date` vs. `assigned_period`), mutual
exclusivity with expense_asset_id, exclusion from ordinary
spending/category/budget/report surfaces while staying fully counted in
real cash balances/cash flow, the Income & Taxes report's grouping and
"awaiting income" status, recurring mandatory-tax templates, and the
backup format-11 roundtrip/back-compat for the new columns. The FX-
resolution-order regression (unrelated-period rows must never be resolved)
has its own file: test_income_tax_unrelated_period_fx.py.
"""
from decimal import Decimal

import pytest

from tests.helpers import money, txn_payload
from tests.test_recurring import template


async def _account(client, currency="USD", **overrides):
    payload = {"name": "ITS account", "currency": currency, **overrides}
    response = await client.post("/accounts", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# --- The two-axis model: real date drives money, assigned_period drives analytics ---

async def test_income_october_tax_september_period_august_matches_real_cash_dates(client, account_id, categories):
    salary = categories["Salary"]["id"]
    income = await client.post("/transactions", json=txn_payload(
        account_id, type="income", amount="10000.00", category_id=salary,
        description="Aug invoice", date="2026-10-03", assigned_period="2026-08-01",
    ))
    assert income.status_code == 201, income.text
    tax = await client.post("/transactions", json=txn_payload(
        account_id, amount="1000.00", category_id=None,
        description="ZUS", date="2026-09-03", assigned_period="2026-08-01", mandatory_payment_kind="zus",
    ))
    assert tax.status_code == 201, tax.text

    # Real cash balance/cash-flow: September sees the debit, October the
    # credit — the two-axis invariant this whole feature is built on.
    september = (await client.get("/cash-flow", params={"start_date": "2026-09-01", "end_date": "2026-09-30"})).json()
    assert money(september["total_expense"]) == 1000 and money(september["total_income"]) == 0
    october = (await client.get("/cash-flow", params={"start_date": "2026-10-01", "end_date": "2026-10-31"})).json()
    assert money(october["total_income"]) == 10000 and money(october["total_expense"]) == 0

    # Income & Taxes: both land under the assigned month, August, regardless
    # of their own different real cash dates.
    report = (await client.get("/income-tax", params={"year": 2026, "month": 8})).json()
    assert report["total"] == 1
    period = report["periods"][0]
    assert period["period"] == "2026-08-01"
    assert money(period["gross_income"]) == 10000
    assert money(period["tax_paid_by_kind"]["zus"]) == 1000
    assert money(period["net_after_paid_taxes"]) == 9000
    assert period["income_received"] is True
    dates = {e["date"] for e in period["entries"]}
    assert dates == {"2026-10-03", "2026-09-03"}


async def test_gross_income_is_recorded_amount_no_vat_formula_applied(client, account_id, categories):
    """The user records the full amount actually received, VAT included —
    this app never derives or subtracts a VAT rate from it. A separately
    classified VAT expense reduces net_after_paid_taxes once, the same way
    ZUS/PPE would, never via a second, formula-based deduction from gross."""
    salary = categories["Salary"]["id"]
    await client.post("/transactions", json=txn_payload(
        account_id, type="income", amount="1230.00", category_id=salary,
        description="Invoice with VAT", date="2026-05-01", assigned_period="2026-04-01",
    ))
    await client.post("/transactions", json=txn_payload(
        account_id, amount="230.00", category_id=None,
        description="VAT-7", date="2026-05-20", assigned_period="2026-04-01", mandatory_payment_kind="vat",
    ))
    period = (await client.get("/income-tax", params={"year": 2026, "month": 4})).json()["periods"][0]
    assert money(period["gross_income"]) == 1230
    assert money(period["tax_paid_by_kind"]["vat"]) == 230
    assert money(period["net_after_paid_taxes"]) == 1000


async def test_taxes_paid_before_income_received_show_awaiting_status_not_a_final_loss(client, account_id):
    await client.post("/transactions", json=txn_payload(
        account_id, amount="500.00", category_id=None,
        description="PPE ahead of invoice", date="2026-09-03", assigned_period="2026-09-01", mandatory_payment_kind="ppe",
    ))
    period = (await client.get("/income-tax", params={"year": 2026, "month": 9})).json()["periods"][0]
    assert money(period["gross_income"]) == 0
    assert period["income_received"] is False
    assert money(period["net_after_paid_taxes"]) == -500  # visible, but flagged non-final by income_received


async def test_multiple_incomes_and_taxes_in_one_period_sum_correctly(client, account_id, categories):
    salary = categories["Salary"]["id"]
    for amount in ("400.00", "600.00"):
        await client.post("/transactions", json=txn_payload(
            account_id, type="income", amount=amount, category_id=salary,
            description="Partial invoice", date="2026-07-01", assigned_period="2026-06-01",
        ))
    for kind, amount in (("zus", "100.00"), ("ppe", "50.00"), ("vat", "70.00")):
        await client.post("/transactions", json=txn_payload(
            account_id, amount=amount, category_id=None,
            description=kind.upper(), date="2026-07-05", assigned_period="2026-06-01", mandatory_payment_kind=kind,
        ))
    period = (await client.get("/income-tax", params={"year": 2026, "month": 6})).json()["periods"][0]
    assert money(period["gross_income"]) == 1000
    assert money(period["tax_paid_total"]) == 220
    assert money(period["net_after_paid_taxes"]) == 780
    assert len(period["entries"]) == 5


async def test_old_ordinary_transactions_are_unaffected_and_absent_from_the_report(client, account_id, categories):
    groceries = categories["Groceries"]["id"]
    created = await client.post("/transactions", json=txn_payload(
        account_id, category_id=groceries, description="Plain old groceries", date="2026-01-05",
    ))
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["assigned_period"] is None and body["mandatory_payment_kind"] is None

    report = (await client.get("/income-tax")).json()
    assert report["total"] == 0

    dashboard = (await client.get("/dashboard/summary", params={"year": 2026, "month": 1})).json()
    assert money(dashboard["spent"]) == 10  # txn_payload's default amount
    assert money(dashboard["mandatory_payments_paid"]) == 0


# --- Mutual exclusivity with property expense links -----------------------

async def test_expense_asset_id_and_mandatory_payment_kind_are_mutually_exclusive(client, account_id):
    asset_resp = await client.post("/assets", json={
        "name": "ITS conflict asset", "asset_class": "real_estate", "currency": "USD",
        "value": "1000", "as_of_date": "2026-01-01",
    })
    asset_id = asset_resp.json()["id"]
    conflict = await client.post("/transactions", json=txn_payload(
        account_id, expense_asset_id=asset_id, assigned_period="2026-01-01", mandatory_payment_kind="zus",
    ))
    assert conflict.status_code == 422, conflict.text

    # No partial write: balance untouched by the rejected request.
    accounts = (await client.get("/accounts")).json()
    assert Decimal(next(a for a in accounts if a["id"] == account_id)["balance"]) == 0


async def test_a_bare_period_without_a_kind_or_a_kind_without_a_period_is_rejected(client, account_id):
    only_period = await client.post("/transactions", json=txn_payload(account_id, assigned_period="2026-01-01"))
    assert only_period.status_code == 422, only_period.text
    only_kind = await client.post("/transactions", json=txn_payload(account_id, mandatory_payment_kind="zus"))
    assert only_kind.status_code == 422, only_kind.text


async def test_a_future_assigned_period_and_a_non_first_of_month_day_are_both_rejected(client, account_id):
    future = await client.post("/transactions", json=txn_payload(
        account_id, assigned_period="2099-01-01", mandatory_payment_kind="zus",
    ))
    assert future.status_code == 422, future.text
    mid_month = await client.post("/transactions", json=txn_payload(
        account_id, assigned_period="2026-01-15", mandatory_payment_kind="zus",
    ))
    assert mid_month.status_code == 422, mid_month.text


async def test_mandatory_payment_kind_on_income_is_rejected(client, account_id, categories):
    salary = categories["Salary"]["id"]
    response = await client.post("/transactions", json=txn_payload(
        account_id, type="income", category_id=salary,
        assigned_period="2026-01-01", mandatory_payment_kind="zus",
    ))
    assert response.status_code == 422, response.text


# --- Mixed splits: part ordinary, part mandatory tax, in one transaction ---

async def test_mixed_split_excludes_only_the_classified_line_from_ordinary_reports(client, account_id, categories):
    groceries = categories["Groceries"]["id"]
    sweets = (await client.post(
        "/categories", json={"name": "ITS Sweets", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
    )).json()["id"]
    created = await client.post("/transactions", json=txn_payload(
        account_id, amount="300.00", category_id=None, date="2026-09-10",
        splits=[
            {"category_id": groceries, "amount": "200.00"},
            {"category_id": groceries, "amount": "100.00", "assigned_period": "2026-08-01", "mandatory_payment_kind": "vat"},
        ],
    ))
    assert created.status_code == 201, created.text

    dashboard = (await client.get("/dashboard/summary", params={"year": 2026, "month": 9})).json()
    assert money(dashboard["spent"]) == 200
    assert money(dashboard["mandatory_payments_paid"]) == 100

    ranking = (await client.get("/reports/category-ranking", params={"kind": "expense"})).json()
    assert money(ranking["total_amount"]) == 200

    spending = (await client.get("/reports/category-spending", params={"category_id": groceries})).json()
    assert money(spending["total_amount"]) == 200

    # Real money: the whole 300 left the account regardless of classification.
    accounts = (await client.get("/accounts")).json()
    assert Decimal(next(a for a in accounts if a["id"] == account_id)["balance"]) == -300


# --- Ordinary-surface exclusion vs. real cash inclusion --------------------

async def test_budget_excludes_mandatory_tax_even_when_filed_under_the_budgeted_category(client, account_id, categories):
    groceries = categories["Groceries"]["id"]
    budget = await client.post("/budgets", json={"category_id": groceries, "monthly_limit": "500.00"})
    assert budget.status_code == 201, budget.text
    await client.post("/transactions", json=txn_payload(
        account_id, amount="90.00", category_id=groceries,
        description="Ordinary groceries", date="2026-06-05",
    ))
    await client.post("/transactions", json=txn_payload(
        account_id, amount="200.00", category_id=groceries,
        description="Tax filed under groceries", date="2026-06-06",
        assigned_period="2026-06-01", mandatory_payment_kind="zus",
    ))
    status = (await client.get("/budgets/status", params={"year": 2026, "month": 6})).json()
    row = next(item for item in status["items"] if item["category_id"] == groceries)
    assert money(row["spent"]) == 90


async def test_net_worth_and_account_balance_include_every_tax_debit_exactly_once(client, account_id):
    starting = (await client.get(f"/accounts")).json()
    before = Decimal(next(a for a in starting if a["id"] == account_id)["balance"])
    await client.post("/transactions", json=txn_payload(
        account_id, amount="150.00", category_id=None,
        description="ZUS real cash", date="2026-03-03", assigned_period="2026-02-01", mandatory_payment_kind="zus",
    ))
    accounts = (await client.get("/accounts")).json()
    after = Decimal(next(a for a in accounts if a["id"] == account_id)["balance"])
    assert after == before - Decimal("150.00")
    capital = (await client.get("/net-worth/summary", params={"range": "all"})).json()
    assert Decimal(capital["current"]) == after


# --- Editing / clearing a classification -----------------------------------

async def test_patch_clears_classification_explicitly_and_leaves_money_untouched(client, account_id):
    created = (await client.post("/transactions", json=txn_payload(
        account_id, amount="80.00", category_id=None, description="ITS clearable",
        assigned_period="2026-01-01", mandatory_payment_kind="ppe",
    ))).json()
    patched = await client.patch(f"/transactions/{created['id']}", json={
        "assigned_period": None, "mandatory_payment_kind": None,
    })
    assert patched.status_code == 200, patched.text
    body = patched.json()
    assert body["assigned_period"] is None and body["mandatory_payment_kind"] is None
    assert money(body["amount"]) == 80  # money itself never touched


async def test_switching_type_away_from_expense_without_clearing_kind_is_rejected(client, account_id):
    created = (await client.post("/transactions", json=txn_payload(
        account_id, amount="60.00", category_id=None, description="ITS switch",
        assigned_period="2026-07-01", mandatory_payment_kind="zus",
    ))).json()
    rejected = await client.patch(f"/transactions/{created['id']}", json={"type": "income"})
    assert rejected.status_code == 400, rejected.text
    # Explicitly clearing the kind allows the switch, keeping the period as
    # a work-income marker instead.
    accepted = await client.patch(f"/transactions/{created['id']}", json={"type": "income", "mandatory_payment_kind": None})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["assigned_period"] == "2026-07-01"


# --- Recurring mandatory-tax templates -------------------------------------

async def test_recurring_tax_template_requires_assigned_period_and_never_defaults_it(client, account_id):
    t = await template(client, account_id, mandatory_payment_kind="ppe")
    bare = await client.post(f"/recurring/{t['id']}/post")
    assert bare.status_code == 422, bare.text

    posted = await client.post(f"/recurring/{t['id']}/post", json={"assigned_period": "2026-05-01"})
    assert posted.status_code == 201, posted.text
    transactions = (await client.get("/transactions")).json()["items"]
    row = next(r for r in transactions if r["description"] == t["description"])
    assert row["assigned_period"] == "2026-05-01" and row["mandatory_payment_kind"] == "ppe"

    # Same-day repost is still blocked exactly as before this feature (see
    # docs/tasks/recurring-variable-payments.md) — no duplicate created.
    duplicate = await client.post(f"/recurring/{t['id']}/post", json={"assigned_period": "2026-05-01"})
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "ALREADY_POSTED"
    matching = [r for r in transactions if r["description"] == t["description"]]
    assert len(matching) == 1


async def test_assigned_period_is_rejected_for_a_non_tax_recurring_template(client, account_id):
    t = await template(client, account_id)  # no mandatory_payment_kind
    response = await client.post(f"/recurring/{t['id']}/post", json={"assigned_period": "2026-05-01"})
    assert response.status_code == 422, response.text


async def test_recurring_tax_template_cannot_also_link_a_property_asset(client, account_id):
    asset_resp = await client.post("/assets", json={
        "name": "ITS template conflict asset", "asset_class": "real_estate", "currency": "USD",
        "value": "1000", "as_of_date": "2026-01-01",
    })
    response = await client.post("/recurring", json={
        "account_id": account_id, "type": "expense", "amount": "10", "description": "conflict template",
        "frequency": "monthly", "anchor_date": "2026-01-01",
        "mandatory_payment_kind": "zus", "expense_asset_id": asset_resp.json()["id"],
    })
    assert response.status_code == 400, response.text


# --- Backup format 11: new columns roundtrip, and default cleanly from older exports ---

async def test_backup_roundtrip_preserves_new_columns_and_defaults_older_versions(client, account_id, categories):
    groceries = categories["Groceries"]["id"]
    sweets = (await client.post(
        "/categories", json={"name": "ITS backup sweets", "kind": "expense", "color": "#7a869a", "parent_id": groceries}
    )).json()["id"]
    await client.post("/transactions", json=txn_payload(
        account_id, amount="90.00", category_id=None, date="2026-04-04",
        splits=[
            {"category_id": groceries, "amount": "50.00"},
            {"category_id": sweets, "amount": "40.00", "assigned_period": "2026-03-01", "mandatory_payment_kind": "vat"},
        ],
    ))
    await client.post("/recurring", json={
        "account_id": account_id, "type": "expense", "amount": "20", "description": "backup tax template",
        "frequency": "monthly", "anchor_date": "2026-01-01", "mandatory_payment_kind": "ppe",
    })

    payload = (await client.get("/backup/export")).json()
    assert payload["aurum_backup_version"] == 12

    restored = await client.post("/backup/import", json=payload)
    assert restored.status_code == 200, restored.text
    re_exported = (await client.get("/backup/export")).json()
    for key in ("transactions", "transaction_splits", "recurring_transactions"):
        original_sorted = sorted(payload[key], key=lambda r: r["id"])
        restored_sorted = sorted(re_exported[key], key=lambda r: r["id"])
        assert original_sorted == restored_sorted

    # An older (format-10, pre-this-feature) export has neither column at
    # all — importing it must default both to null, not fail or guess.
    downgraded = dict(payload)
    downgraded["aurum_backup_version"] = 10
    for row in downgraded["transactions"]:
        row.pop("assigned_period", None)
        row.pop("mandatory_payment_kind", None)
    for row in downgraded["transaction_splits"]:
        row.pop("assigned_period", None)
        row.pop("mandatory_payment_kind", None)
    for row in downgraded["recurring_transactions"]:
        row.pop("mandatory_payment_kind", None)
    restored_old = await client.post("/backup/import", json=downgraded)
    assert restored_old.status_code == 200, restored_old.text
    after_old = (await client.get("/backup/export")).json()
    assert all(row["assigned_period"] is None and row["mandatory_payment_kind"] is None for row in after_old["transactions"])
    assert all(row["assigned_period"] is None and row["mandatory_payment_kind"] is None for row in after_old["transaction_splits"])
    assert all(row["mandatory_payment_kind"] is None for row in after_old["recurring_transactions"])
