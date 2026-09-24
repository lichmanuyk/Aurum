"""Exercise a populated old schema in a separate disposable database."""
import os
import subprocess
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from tests.conftest import _url


async def test_populated_upgrade_preserves_unknown_transfer_amount():
    name = 'aurum_fx_migration_test'
    backend = Path(__file__).resolve().parents[1]
    admin = create_async_engine(_url('postgres'), isolation_level='AUTOCOMMIT')
    async with admin.connect() as conn:
        await conn.execute(text(f'CREATE DATABASE "{name}"'))
    engine = create_async_engine(_url(name))
    try:
        env = {**os.environ, 'AURUM_POSTGRES_DB': name}
        subprocess.run(['alembic', 'upgrade', 'd1a6f4c8b729'], cwd=backend, env=env, check=True, capture_output=True)
        async with engine.begin() as conn:
            await conn.execute(text("INSERT INTO app_settings (id,currency,negative_cash_flow_threshold_months,net_worth_decline_threshold_months,risky_allocation_threshold_percent,idle_cash_threshold_amount,idle_cash_threshold_days) VALUES (1,'PLN',2,2,20,1000,60)"))
            await conn.execute(text("INSERT INTO accounts (id,name,type,currency,is_archived) VALUES (1,'Synthetic EUR','CHECKING','EUR',false),(2,'Synthetic PLN','CHECKING','PLN',false),(3,'Synthetic EUR 2','CHECKING','EUR',false)"))
            await conn.execute(text("INSERT INTO transactions (account_id,transfer_account_id,type,amount,description,date) VALUES (1,2,'TRANSFER',100,'Unknown legacy exchange','2025-01-01'),(1,3,'TRANSFER',100,'Known same-currency','2025-01-01')"))
            await conn.execute(text("INSERT INTO goals (name,target_amount) VALUES ('Synthetic goal',1000)"))
        subprocess.run(['alembic', 'upgrade', 'head'], cwd=backend, env=env, check=True, capture_output=True)
        async with engine.connect() as conn:
            rows = (await conn.execute(text('SELECT transfer_account_id,destination_amount FROM transactions ORDER BY transfer_account_id'))).all()
            assert rows[0] == (2, None)
            assert rows[1] == (3, 100)
            assert (await conn.execute(text('SELECT currency FROM goals'))).scalar_one() == 'PLN'
            assert (await conn.execute(text('SELECT idle_cash_threshold_currency FROM app_settings'))).scalar_one() == 'PLN'
    finally:
        await engine.dispose()
        async with admin.connect() as conn:
            await conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        await admin.dispose()
