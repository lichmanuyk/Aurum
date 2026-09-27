"""Regression test for the "Income & Taxes" report resolving FX for rows
*outside* the requested year/month filter — see
docs/tasks/income-tax-separation.md and the independent backend review that
found it. get_income_tax_report's initial query fetches every transaction
with *any* assigned_period, on itself or any split line, across all history
(needed when year/month are omitted); for a split-bearing row, the buggy
code called fx.splits(tx) unconditionally, before checking whether that
row's own assigned_period even matched the request. That let a completely
unrelated period's row — one whose currency/date has no FX rate at all —
either 409 an otherwise-fine, narrowly-scoped request, or silently add its
FX pair to fx_rates_used even though nothing it backs is actually shown.

Synthetic data only, no personal fixtures. Every test here truncates and
reseeds via conftest's autouse _clean_database, so they don't interact.
"""
from decimal import Decimal

from httpx import AsyncClient

from tests.helpers import money, txn_payload as _txn


async def _account(client: AsyncClient, currency: str) -> int:
    resp = await client.post("/accounts", json={"name": f"Test {currency}", "currency": currency})
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _rate(client: AsyncClient, day: str, base: str, quote: str, value: str) -> None:
    resp = await client.post(
        "/fx-rates/bulk",
        json={"items": [dict(base_currency=base, quote_currency=quote, rate_date=day, rate=value)]},
    )
    assert resp.status_code == 200, resp.text


async def _subcategory(client: AsyncClient, parent_id: int, name: str) -> int:
    resp = await client.post(
        "/categories", json={"name": name, "kind": "expense", "color": "#7a869a", "parent_id": parent_id}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _classified_split_expense(
    client: AsyncClient,
    *,
    account_id: int,
    groceries: int,
    sweets: int,
    date: str,
    assigned_period: str,
    kind: str = "vat",
    amount: str = "100.00",
) -> dict:
    """A minimal mixed split — one classified tax line (assigned_period +
    mandatory_payment_kind), one ordinary line — the same "part ordinary,
    part mandatory tax payment" shape docs/tasks/income-tax-separation.md
    describes for a mixed purchase. Both lines share Groceries as their
    common top-level category, same as _build_splits already requires (see
    tests/test_transactions.py's own _subcategory-based split tests)."""
    tax_amount = Decimal("40.00")
    resp = await client.post(
        "/transactions",
        json=_txn(
            account_id,
            amount=amount,
            category_id=None,
            date=date,
            splits=[
                {
                    "category_id": groceries,
                    "amount": str(tax_amount),
                    "assigned_period": assigned_period,
                    "mandatory_payment_kind": kind,
                },
                {"category_id": sweets, "amount": str(Decimal(amount) - tax_amount)},
            ],
        ),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_unrelated_period_split_without_fx_does_not_block_selected_month(
    client: AsyncClient, account_id, categories
):
    """An old, differently-assigned split classification on a foreign-
    currency account with *no* FX rate at all must not break a request for a
    completely different month."""
    groceries = categories["Groceries"]["id"]
    sweets = await _subcategory(client, groceries, "Sweets")

    # The row this request actually wants: on the default (reporting-
    # currency) account, so it never needs FX resolution at all — isolates
    # the bug to the unrelated transaction below.
    selected = await _classified_split_expense(
        client, account_id=account_id, groceries=groceries, sweets=sweets,
        date="2026-09-03", assigned_period="2026-08-01", kind="vat",
    )

    # Unrelated transaction: unrelated period, unrelated (foreign) currency,
    # and deliberately *no* FX rate posted for it anywhere.
    eur = await _account(client, "EUR")
    await _classified_split_expense(
        client, account_id=eur, groceries=groceries, sweets=sweets,
        date="2019-03-10", assigned_period="2019-02-01", kind="zus",
    )

    response = await client.get("/income-tax", params={"year": 2026, "month": 8})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["total"] == 1
    period = body["periods"][0]
    assert period["period"] == "2026-08-01"
    assert set(period["tax_paid_by_kind"]) == {"vat"}
    assert money(period["tax_paid_by_kind"]["vat"]) == Decimal("40.00")
    entry = period["entries"][0]
    # The real cash date stays independent of the assigned_period grouping —
    # the two-axis invariant this whole feature is built on.
    assert entry["date"] == "2026-09-03"
    assert entry["id"] == selected["id"]


async def test_fx_metadata_only_reflects_the_filtered_period(client: AsyncClient, account_id, categories):
    """fx_rates_used must list only the rates actually backing what's shown
    for the requested period, never a rate resolved for a different
    period's row that the broad "has any assigned_period" query also
    happened to fetch."""
    groceries = categories["Groceries"]["id"]
    sweets = await _subcategory(client, groceries, "Sweets")

    eur = await _account(client, "EUR")
    await _rate(client, "2026-09-03", base="EUR", quote="USD", value="1.10")
    await _classified_split_expense(
        client, account_id=eur, groceries=groceries, sweets=sweets,
        date="2026-09-03", assigned_period="2026-08-01", kind="vat",
    )

    gbp = await _account(client, "GBP")
    await _rate(client, "2019-03-10", base="GBP", quote="USD", value="1.30")
    await _classified_split_expense(
        client, account_id=gbp, groceries=groceries, sweets=sweets,
        date="2019-03-10", assigned_period="2019-02-01", kind="zus",
    )

    response = await client.get("/income-tax", params={"year": 2026, "month": 8})
    assert response.status_code == 200, response.text
    pairs = {(r["base_currency"], r["quote_currency"], r["rate_date"]) for r in response.json()["fx_rates_used"]}
    assert ("EUR", "USD", "2026-09-03") in pairs
    assert ("GBP", "USD", "2019-03-10") not in pairs


async def test_selected_period_split_with_missing_fx_still_raises_explicit_error(
    client: AsyncClient, account_id, categories
):
    """The fix must only skip transactions *outside* the filter — a
    classified split that genuinely belongs to the requested period, on a
    foreign-currency account with no FX rate at all, must still surface the
    same explicit FX_RATE_MISSING 409 every other report already gives for
    this, never a silently empty/succeeding response."""
    groceries = categories["Groceries"]["id"]
    sweets = await _subcategory(client, groceries, "Sweets")

    eur = await _account(client, "EUR")
    await _classified_split_expense(
        client, account_id=eur, groceries=groceries, sweets=sweets,
        date="2026-09-03", assigned_period="2026-08-01", kind="vat",
    )

    response = await client.get("/income-tax", params={"year": 2026, "month": 8})
    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "FX_RATE_MISSING"
