"""build_backup()'s explicit ORDER BY on every entity-table collection.
A plain `select()` with no ORDER BY makes no ordering guarantee from
Postgres; a real production restore once reported a false mismatch purely
from two exports of the *same* rows coming back in a different physical
order, not from any actual data difference — see
scripts/check_backup_restore.py's own _canonical_multiset for the matching
order-insensitive-comparison half of this fix.

Each test inserts rows via raw SQL with ids/keys deliberately out of
ascending order, so a simple unordered heap scan would very likely return
them in that same (non-ascending) physical order — exactly the shape that
would have failed before build_backup() added an explicit ORDER BY. All
data here is synthetic; nothing about the money/asset engine itself is
exercised or changed.
"""
from datetime import date

from sqlalchemy import text


async def test_export_orders_accounts_by_id_regardless_of_insertion_order(client, test_sessionmaker):
    async with test_sessionmaker() as session:
        await session.execute(text(
            "INSERT INTO accounts (id, name, type, currency, is_archived) VALUES "
            "(30, 'Synthetic Z', 'CHECKING', 'USD', false), "
            "(10, 'Synthetic A', 'CHECKING', 'USD', false), "
            "(20, 'Synthetic M', 'CHECKING', 'USD', false)"
        ))
        await session.commit()

    payload = (await client.get("/backup/export")).json()
    ids = [row["id"] for row in payload["accounts"]]
    assert ids == sorted(ids), f"accounts export not ordered by id: {ids}"


async def test_export_orders_transactions_by_id_regardless_of_insertion_order(client, account_id, test_sessionmaker):
    async with test_sessionmaker() as session:
        await session.execute(text(
            "INSERT INTO transactions (id, account_id, type, amount, description, date) VALUES "
            "(300, :acc, 'EXPENSE', 5, 'Synthetic C', :d), "
            "(100, :acc, 'EXPENSE', 6, 'Synthetic A', :d), "
            "(200, :acc, 'EXPENSE', 7, 'Synthetic B', :d)"
        ), {"acc": account_id, "d": date.today()})
        await session.commit()

    payload = (await client.get("/backup/export")).json()
    ids = [row["id"] for row in payload["transactions"]]
    assert ids == sorted(ids), f"transactions export not ordered by id: {ids}"


async def test_export_orders_fx_rates_by_natural_key_regardless_of_insertion_order(client, test_sessionmaker):
    # Ordered by (base_currency, quote_currency, rate_date) — FXRate's own
    # real-world business key (see models/fx.py's uq_fx_pair_date), not its
    # surrogate `id` — a rate's identity for backup purposes is that
    # canonical pair+date, not the auto-increment row number.
    async with test_sessionmaker() as session:
        await session.execute(text(
            "INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate, source) VALUES "
            "('PLN', 'USD', '2025-03-01', 4.0, 'manual'), "
            "('EUR', 'PLN', '2025-01-01', 4.2, 'manual'), "
            "('EUR', 'PLN', '2024-01-01', 4.5, 'manual')"
        ))
        await session.commit()

    payload = (await client.get("/backup/export")).json()
    keys = [(row["base_currency"], row["quote_currency"], row["rate_date"]) for row in payload["fx_rates"]]
    assert keys == sorted(keys), f"fx_rates export not ordered by natural key: {keys}"


async def test_export_orders_crypto_holdings_by_asset_id_regardless_of_insertion_order(client, test_sessionmaker):
    # CryptoHolding has no separate `id` column at all — asset_id doubles
    # as its own real primary key (see models/crypto.py) — so the export
    # must order by *that*, not by some nonexistent surrogate.
    async with test_sessionmaker() as session:
        await session.execute(text(
            "INSERT INTO assets (id, name, asset_class, currency, capital_role, risk_level) VALUES "
            "(301, 'Synthetic coin C', 'CRYPTO', 'USD', 'NEUTRAL', 'MEDIUM'), "
            "(101, 'Synthetic coin A', 'CRYPTO', 'USD', 'NEUTRAL', 'MEDIUM'), "
            "(201, 'Synthetic coin B', 'CRYPTO', 'USD', 'NEUTRAL', 'MEDIUM')"
        ))
        await session.execute(text(
            "INSERT INTO crypto_portfolios (id, name, is_archived) VALUES (900, 'Synthetic portfolio', false)"
        ))
        await session.execute(text(
            "INSERT INTO crypto_holdings (asset_id, portfolio_id, coingecko_id, symbol, name) VALUES "
            "(301, 900, 'synthetic-c', 'SYC', 'Synthetic C'), "
            "(101, 900, 'synthetic-a', 'SYA', 'Synthetic A'), "
            "(201, 900, 'synthetic-b', 'SYB', 'Synthetic B')"
        ))
        await session.commit()

    payload = (await client.get("/backup/export")).json()
    asset_ids = [row["asset_id"] for row in payload["crypto_holdings"]]
    assert asset_ids == sorted(asset_ids), f"crypto_holdings export not ordered by asset_id: {asset_ids}"


async def test_export_sorts_tag_ids_within_each_transaction(client, account_id, categories):
    """A transaction's own tag *set* has no recorded order (no order_by on
    the many-to-many relationship — see models/tag.py) — the export must
    still hand back a canonical (sorted) order for it, not whatever the
    join table's own physical row order happens to be, so two exports of
    the same tag set always agree with each other."""
    tag_c = (await client.post("/tags", json={"name": "Synthetic tag C"})).json()["id"]
    tag_a = (await client.post("/tags", json={"name": "Synthetic tag A"})).json()["id"]
    tag_b = (await client.post("/tags", json={"name": "Synthetic tag B"})).json()["id"]
    created = await client.post("/transactions", json={
        "account_id": account_id, "type": "expense", "amount": "10.00",
        "description": "Synthetic tagged expense", "date": str(date.today()),
        "tag_ids": [tag_c, tag_a, tag_b],
    })
    assert created.status_code == 201, created.text
    tx_id = created.json()["id"]

    payload = (await client.get("/backup/export")).json()
    row = next(r for r in payload["transactions"] if r["id"] == tx_id)
    assert row["tag_ids"] == sorted(row["tag_ids"]), f"tag_ids not sorted: {row['tag_ids']}"
    assert set(row["tag_ids"]) == {tag_a, tag_b, tag_c}
