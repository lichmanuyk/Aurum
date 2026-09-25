"""Persistence and validation for the Dashboard/Net Worth/Crypto/Cash Flow/
Reports display currency preferences (see
docs/tasks/display-currency-preferences.md and
docs/tasks/cash-flow-reports-display-currency.md) — distinct from
`currency`, the ledger's primary/reporting currency, which this feature
never touches.
"""
from httpx import AsyncClient

from app.services.backup_service import BACKUP_FORMAT_VERSION

DISPLAY_CURRENCY_FIELDS = (
    "summary_currency", "dashboard_currency", "net_worth_currency", "crypto_currency",
    "cash_flow_currency", "reports_currency",
)


async def test_fresh_settings_have_no_display_currency_choice_yet(client: AsyncClient):
    settings = (await client.get("/settings")).json()
    for field in DISPLAY_CURRENCY_FIELDS:
        assert settings[field] is None


async def test_display_currency_choices_persist_independently(client: AsyncClient):
    resp = await client.patch("/settings", json={
        "summary_currency": "USD", "net_worth_currency": "EUR", "crypto_currency": "PLN",
        "cash_flow_currency": "EUR", "reports_currency": "PLN",
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["summary_currency"] == "USD"
    assert body["dashboard_currency"] is None  # untouched, still inheriting
    assert body["net_worth_currency"] == "EUR"
    assert body["crypto_currency"] == "PLN"
    assert body["cash_flow_currency"] == "EUR"
    assert body["reports_currency"] == "PLN"

    refetched = (await client.get("/settings")).json()
    assert refetched == body


async def test_explicit_null_resets_a_display_currency_field_to_inherit(client: AsyncClient):
    await client.patch("/settings", json={"dashboard_currency": "EUR"})
    resp = await client.patch("/settings", json={"dashboard_currency": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["dashboard_currency"] is None


async def test_null_still_rejected_for_every_other_settings_field(client: AsyncClient):
    resp = await client.patch("/settings", json={"idle_cash_threshold_currency": None})
    assert resp.status_code == 422
    resp = await client.patch("/settings", json={"currency": None})
    assert resp.status_code == 422


async def test_display_currency_rejects_values_outside_pln_usd_eur(client: AsyncClient):
    for field in DISPLAY_CURRENCY_FIELDS:
        resp = await client.patch("/settings", json={field: "GBP"})
        assert resp.status_code == 422, f"{field} should reject GBP"


async def test_backup_roundtrip_preserves_display_currency_choices(client: AsyncClient):
    await client.patch("/settings", json={
        "summary_currency": "USD", "dashboard_currency": "PLN", "net_worth_currency": "EUR", "crypto_currency": None,
        "cash_flow_currency": "EUR", "reports_currency": None,
    })
    export = (await client.get("/backup/export")).json()
    assert export["aurum_backup_version"] == BACKUP_FORMAT_VERSION
    assert export["app_settings"]["summary_currency"] == "USD"
    assert export["app_settings"]["dashboard_currency"] == "PLN"
    assert export["app_settings"]["net_worth_currency"] == "EUR"
    assert export["app_settings"]["crypto_currency"] is None
    assert export["app_settings"]["cash_flow_currency"] == "EUR"
    assert export["app_settings"]["reports_currency"] is None

    # Change everything locally, then restore the export — the file wins.
    await client.patch("/settings", json={"summary_currency": "EUR", "dashboard_currency": None, "cash_flow_currency": None})
    import_resp = await client.post("/backup/import", json=export)
    assert import_resp.status_code == 200, import_resp.text

    restored = (await client.get("/settings")).json()
    assert restored["summary_currency"] == "USD"
    assert restored["dashboard_currency"] == "PLN"
    assert restored["net_worth_currency"] == "EUR"
    assert restored["crypto_currency"] is None
    assert restored["cash_flow_currency"] == "EUR"
    assert restored["reports_currency"] is None


async def test_importing_a_pre_display_currency_backup_defaults_to_inherit(client: AsyncClient):
    """A v7 backup (the format right before display currencies existed at
    all) has none of these fields — restoring it must not fail, and must
    leave every section inheriting rather than guessing a currency."""
    export = (await client.get("/backup/export")).json()
    export["aurum_backup_version"] = 7
    for field in DISPLAY_CURRENCY_FIELDS:
        del export["app_settings"][field]

    import_resp = await client.post("/backup/import", json=export)
    assert import_resp.status_code == 200, import_resp.text

    settings = (await client.get("/settings")).json()
    for field in DISPLAY_CURRENCY_FIELDS:
        assert settings[field] is None


async def test_importing_a_pre_cash_flow_reports_currency_backup_defaults_to_inherit(client: AsyncClient):
    """A v8 backup (right before Cash Flow/Reports had their own overrides)
    has the four earlier fields but not these two — restoring it must
    leave Cash Flow/Reports inheriting, without touching the earlier four."""
    await client.patch("/settings", json={"summary_currency": "USD"})
    export = (await client.get("/backup/export")).json()
    export["aurum_backup_version"] = 8
    del export["app_settings"]["cash_flow_currency"]
    del export["app_settings"]["reports_currency"]

    import_resp = await client.post("/backup/import", json=export)
    assert import_resp.status_code == 200, import_resp.text

    settings = (await client.get("/settings")).json()
    assert settings["summary_currency"] == "USD"
    assert settings["cash_flow_currency"] is None
    assert settings["reports_currency"] is None


async def test_backup_import_rejects_invalid_display_currency(client: AsyncClient):
    export = (await client.get("/backup/export")).json()
    export["app_settings"]["summary_currency"] = "GBP"
    import_resp = await client.post("/backup/import", json=export)
    assert import_resp.status_code == 422
