"""Exercise the debt-tracking migration (d8a1f4c9e352) against a populated
pre-migration schema in a separate disposable database — same "populate old
schema, upgrade, check" shape as test_property_expense_links_migration.py,
for the two brand-new tables added by docs/tasks/debt-tracking.md."""
import os
import subprocess
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import _url


async def test_populated_upgrade_adds_debt_tables_without_losing_data():
    name = 'aurum_debt_migration_test'
    backend = Path(__file__).resolve().parents[1]
    admin = create_async_engine(_url('postgres'), isolation_level='AUTOCOMMIT')
    async with admin.connect() as conn:
        await conn.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        await conn.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_async_engine(_url(name))
    try:
        env = {**os.environ, 'AURUM_POSTGRES_DB': name}
        # The revision immediately before this task's own migration — the
        # schema as every existing (format <= 11) deployment actually has it.
        subprocess.run(['alembic', 'upgrade', 'cf4362a05090'], cwd=backend, env=env, check=True, capture_output=True)
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
                "INSERT INTO transactions (id,account_id,type,amount,description,date) "
                "VALUES (1,1,'EXPENSE',10,'Synthetic pre-migration expense','2025-01-01')"
            ))
        subprocess.run(['alembic', 'upgrade', 'head'], cwd=backend, env=env, check=True, capture_output=True)
        async with engine.begin() as conn:
            # Existing rows read back exactly as before — the migration is
            # purely additive (two new tables, no column changes).
            tx = (await conn.execute(text(
                'SELECT amount, description FROM transactions WHERE id = 1'
            ))).one()
            assert (tx.amount, tx.description) == (10, 'Synthetic pre-migration expense')

            # Both new tables exist and accept a real debt + repayment,
            # with their FKs live and enforced.
            await conn.execute(text(
                "INSERT INTO transactions (id,account_id,type,amount,description,date) "
                "VALUES (2,1,'DEBT_OUT',50,'Loan to Synthetic friend','2025-02-01')"
            ))
            await conn.execute(text(
                "INSERT INTO debts (id,direction,counterparty,currency,principal_amount,start_date,"
                "issuance_transaction_id) VALUES (1,'owed_to_me','Synthetic friend','USD',50,'2025-02-01',2)"
            ))
            await conn.execute(text(
                "INSERT INTO transactions (id,account_id,type,amount,description,date) "
                "VALUES (3,1,'DEBT_IN',50,'Repayment: Synthetic friend','2025-03-01')"
            ))
            await conn.execute(text(
                "INSERT INTO debt_repayments (id,debt_id,transaction_id,kind,amount_debt_currency) "
                "VALUES (1,1,3,'repayment',50)"
            ))
            debt = (await conn.execute(text(
                'SELECT direction, principal_amount, issuance_transaction_id FROM debts WHERE id = 1'
            ))).one()
            assert (debt.direction, debt.principal_amount, debt.issuance_transaction_id) == ('owed_to_me', 50, 2)
            repayment = (await conn.execute(text(
                'SELECT debt_id, amount_debt_currency FROM debt_repayments WHERE id = 1'
            ))).one()
            assert (repayment.debt_id, repayment.amount_debt_currency) == (1, 50)

        # Deleting a Transaction that a debt/repayment still points at is
        # rejected by the new FKs (RESTRICT, not SET NULL/CASCADE) — the
        # same "the API's own clean 409 is backed by a real constraint"
        # guarantee test_property_expense_links_migration.py already
        # proves for expense_asset_id.
        async with engine.connect() as conn:
            failed = False
            try:
                async with conn.begin():
                    await conn.execute(text('DELETE FROM transactions WHERE id = 2'))
            except Exception:
                failed = True
            assert failed, "deleting a debt's issuance transaction must be rejected by the new FK"
        async with engine.connect() as conn:
            failed = False
            try:
                async with conn.begin():
                    await conn.execute(text('DELETE FROM debts WHERE id = 1'))
            except Exception:
                failed = True
            assert failed, "deleting a debt with a live repayment must be rejected by the new FK"
    finally:
        await engine.dispose()
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        await admin.dispose()
