"""Currency units, historical reference rates and transfer destination amounts.

Legacy cross-currency transfers and crypto quotes remain unresolved rather than
inventing historical units. Resolve them explicitly before reporting.
"""
from alembic import op
import sqlalchemy as sa

revision = "f0a100000001"
down_revision = "d1a6f4c8b729"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("fx_rates",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("base_currency", sa.String(3), nullable=False),
        sa.Column("quote_currency", sa.String(3), nullable=False),
        sa.Column("rate_date", sa.Date(), nullable=False),
        sa.Column("rate", sa.Numeric(38,18), nullable=False),
        sa.Column("source", sa.String(50), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("base_currency", "quote_currency", "rate_date", name="uq_fx_pair_date"),
        sa.CheckConstraint("rate > 0 AND base_currency < quote_currency", name="ck_fx_rate_pair"))
    for field in ("destination_amount", "reporting_amount_override"):
        op.add_column("transactions", sa.Column(field, sa.Numeric(14,2)))
    op.add_column("transactions", sa.Column("reporting_currency_override", sa.String(3)))
    op.add_column("transactions", sa.Column("reporting_override_source", sa.String(50)))
    op.execute("UPDATE transactions t SET destination_amount=t.amount FROM accounts a, accounts b WHERE t.type='TRANSFER' AND t.account_id=a.id AND t.transfer_account_id=b.id AND a.currency=b.currency")
    for table, field in (("goals", "currency"), ("budgets", "currency"), ("app_settings", "idle_cash_threshold_currency")):
        op.add_column(table, sa.Column(field, sa.String(3)))
        op.execute(f"UPDATE {table} SET {field}=(SELECT currency FROM app_settings WHERE id=1)")
        # Empty old databases need no inferred money units; populated ones require settings.
        op.alter_column(table, field, nullable=False)
    op.add_column("crypto_transactions", sa.Column("quote_currency", sa.String(3)))


def downgrade():
    raise RuntimeError("Multi-currency downgrade loses monetary semantics; restore a pre-upgrade backup instead")
