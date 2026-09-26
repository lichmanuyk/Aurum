"""Exercise the expense_asset_id migration (c1f5b3a8d942) against a
populated pre-migration schema in a separate disposable database — the
same "populate old schema, upgrade, check" shape as
test_multicurrency_migration.py, for the new nullable link columns added
by docs/tasks/property-expense-links.md."""
import os
import subprocess
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import _url


async def test_populated_upgrade_adds_null_expense_links_without_losing_data():
    name = 'aurum_expense_link_migration_test'
    backend = Path(__file__).resolve().parents[1]
    admin = create_async_engine(_url('postgres'), isolation_level='AUTOCOMMIT')
    async with admin.connect() as conn:
        await conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        await conn.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_async_engine(_url(name))
    try:
        env = {**os.environ, 'AURUM_POSTGRES_DB': name}
        # The revision immediately before this task's own migration — the
        # schema as every existing (format <= 9) deployment actually has it.
        subprocess.run(['alembic', 'upgrade', 'b7e21f4a9c36'], cwd=backend, env=env, check=True, capture_output=True)
        async with engine.begin() as conn:
            await conn.execute(text(
                "INSERT INTO app_settings (id,currency,negative_cash_flow_threshold_months,"
                "net_worth_decline_threshold_months,risky_allocation_threshold_percent,"
                "idle_cash_threshold_amount,idle_cash_threshold_days,idle_cash_threshold_currency) "
                "VALUES (1,'USD',2,2,20,1000,60,'USD')"
            ))
            await conn.execute(text(
                "INSERT INTO accounts (id,name,type,currency,is_archived) "
                "VALUES (1,'Synthetic checking','CHECKING','USD',false)"
            ))
            await conn.execute(text(
                "INSERT INTO categories (id,name,kind,color,sort_order,is_default) "
                "VALUES (1,'Synthetic Housing','EXPENSE','#2a78d6',0,false),"
                "(2,'Synthetic Sweets','EXPENSE','#2a78d6',1,false)"
            ))
            await conn.execute(text(
                "INSERT INTO transactions (id,account_id,category_id,type,amount,description,date) "
                "VALUES (1,1,1,'EXPENSE',100,'Synthetic pre-migration expense','2025-01-01')"
            ))
            await conn.execute(text(
                "INSERT INTO transaction_splits (id,transaction_id,category_id,amount) "
                "VALUES (1,1,2,40)"
            ))
            await conn.execute(text(
                "INSERT INTO recurring_transactions (id,account_id,category_id,type,amount,description,"
                "frequency,anchor_date,is_active) "
                "VALUES (1,1,1,'EXPENSE',10,'Synthetic pre-migration template','MONTHLY','2025-01-01',true)"
            ))
        subprocess.run(['alembic', 'upgrade', 'head'], cwd=backend, env=env, check=True, capture_output=True)
        async with engine.begin() as conn:
            # Existing rows read back exactly as before, with the new
            # column present and NULL — never a default of 0/false that
            # would silently look like a real link.
            tx = (await conn.execute(text(
                'SELECT amount, description, expense_asset_id FROM transactions WHERE id = 1'
            ))).one()
            assert (tx.amount, tx.description, tx.expense_asset_id) == (100, 'Synthetic pre-migration expense', None)
            split_link = (await conn.execute(text(
                'SELECT expense_asset_id FROM transaction_splits WHERE id = 1'
            ))).scalar_one()
            assert split_link is None
            recurring_link = (await conn.execute(text(
                'SELECT expense_asset_id FROM recurring_transactions WHERE id = 1'
            ))).scalar_one()
            assert recurring_link is None

            # The new FK is live and enforced: a real asset can be linked,
            # and deleting it while linked is rejected at the database level
            # (RESTRICT) — the same 409 the API surfaces is backed by a real
            # constraint, not just an application-level check.
            await conn.execute(text(
                "INSERT INTO assets (id,name,asset_class,currency,capital_role,risk_level) "
                "VALUES (1,'Synthetic post-migration asset','REAL_ESTATE','USD','NEUTRAL','MEDIUM')"
            ))
            await conn.execute(text('UPDATE transactions SET expense_asset_id = 1 WHERE id = 1'))
            linked = (await conn.execute(text(
                'SELECT expense_asset_id FROM transactions WHERE id = 1'
            ))).scalar_one()
            assert linked == 1
        async with engine.connect() as conn:
            failed = False
            try:
                async with conn.begin():
                    await conn.execute(text('DELETE FROM assets WHERE id = 1'))
            except Exception:
                failed = True
            assert failed, "deleting a linked asset must be rejected by the new FK, not silently cascaded"
    finally:
        await engine.dispose()
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        await admin.dispose()
