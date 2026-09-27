"""Regression test for IncomeTaxReport.available_years — see
docs/tasks/income-tax-separation.md and the independent frontend review
that found the Year picker was being driven by GET /transactions/years
(real cash dates) instead of assigned_period. available_years must reflect
every calendar year any assigned_period ever falls in, regardless of the
request's own year/month filter or which page of periods is being returned
right now — otherwise a period assigned to a year with no *other*
real-dated activity in that year becomes unreachable through the Year
filter (only "All" would still show it).

Every transaction here stays on the default (reporting-currency) account —
deliberately no FX involved at all, so this stays entirely about the
available_years computation itself, independent of (and never blocked by)
FX resolution for anything else in the ledger.

Synthetic data only, no personal fixtures.
"""
from httpx import AsyncClient

from tests.helpers import txn_payload as _txn


async def _income(client: AsyncClient, account_id: int, *, date: str, assigned_period: str) -> int:
    resp = await client.post(
        "/transactions",
        json=_txn(account_id, type="income", amount="500.00", date=date, assigned_period=assigned_period),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _subcategory(client: AsyncClient, parent_id: int, name: str) -> int:
    resp = await client.post(
        "/categories", json={"name": name, "kind": "expense", "color": "#7a869a", "parent_id": parent_id}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _classified_split_expense(
    client: AsyncClient, account_id: int, groceries: int, sweets: int, *, date: str, assigned_period: str, kind: str
) -> int:
    resp = await client.post(
        "/transactions",
        json=_txn(
            account_id, amount="100.00", category_id=None, date=date,
            splits=[
                {"category_id": groceries, "amount": "40.00", "assigned_period": assigned_period, "mandatory_payment_kind": kind},
                {"category_id": sweets, "amount": "60.00"},
            ],
        ),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def test_available_years_includes_a_year_whose_only_activity_was_real_dated_a_different_year(
    client: AsyncClient, account_id, freeze_business_clock
):
    """The exact "onlycash2026 assignedDec2025" case: real cash date in
    2026, assigned_period in 2025 — 2025 must still be offered by the Year
    picker even while the request is filtered to a year (2026) that has no
    assigned_period of its own at all."""
    freeze_business_clock("2026-09-27")
    await _income(client, account_id, date="2026-01-10", assigned_period="2025-12-01")

    all_time = await client.get("/income-tax")
    assert all_time.status_code == 200, all_time.text
    assert all_time.json()["available_years"] == [2025]
    assert len(all_time.json()["periods"]) == 1

    # Filtered to 2026 (the real cash year, not the assigned one) — no
    # period matches, but available_years must still list 2025, or the
    # picker could never be used to navigate back to it from here.
    filtered = await client.get("/income-tax", params={"year": 2026})
    assert filtered.status_code == 200, filtered.text
    assert filtered.json()["periods"] == []
    assert filtered.json()["available_years"] == [2025]


async def test_available_years_is_identical_across_pages_and_reads_split_lines_too(
    client: AsyncClient, account_id, categories, freeze_business_clock
):
    """Three distinct periods across two distinct years (2024 and 2025 —
    one of the 2025 periods comes from a split line, not the parent row) —
    available_years must be the exact same two-year list on every page, not
    just the page that happens to include the earliest/latest period."""
    freeze_business_clock("2026-09-27")
    groceries = categories["Groceries"]["id"]
    sweets = await _subcategory(client, groceries, "Sweets")

    await _income(client, account_id, date="2024-03-05", assigned_period="2024-02-01")
    await _income(client, account_id, date="2026-01-10", assigned_period="2025-12-01")
    await _classified_split_expense(
        client, account_id, groceries, sweets, date="2025-07-20", assigned_period="2025-06-01", kind="zus",
    )

    expected_years = [2024, 2025]

    page_1 = (await client.get("/income-tax", params={"page": 1, "page_size": 2})).json()
    assert page_1["total"] == 3
    assert len(page_1["periods"]) == 2
    assert page_1["available_years"] == expected_years

    page_2 = (await client.get("/income-tax", params={"page": 2, "page_size": 2})).json()
    assert len(page_2["periods"]) == 1
    assert page_2["available_years"] == expected_years

    # A year filter that narrows the *periods* shown must not narrow
    # available_years the same way.
    only_2024 = (await client.get("/income-tax", params={"year": 2024})).json()
    assert len(only_2024["periods"]) == 1
    assert only_2024["available_years"] == expected_years
