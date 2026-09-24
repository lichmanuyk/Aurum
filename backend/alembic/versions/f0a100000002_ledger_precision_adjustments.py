"""Preserve ledger precision and distinguish balance adjustments from income."""
from alembic import op
import sqlalchemy as sa

revision = "f0a100000002"
down_revision = "f0a100000001"
branch_labels = None
depends_on = None


def upgrade():
    for table, columns in {"transactions": ("amount", "destination_amount", "reporting_amount_override"), "transaction_splits": ("amount",)}.items():
        for column in columns:
            op.alter_column(table, column, type_=sa.Numeric(18, 6), existing_type=sa.Numeric(14, 2))
    # transaction_type is VARCHAR(10), not a native PostgreSQL enum.
    op.add_column("transactions", sa.Column("adjustment_reason", sa.String(20), nullable=True))


def downgrade():
    raise RuntimeError("Restore a matching backup to downgrade without losing ledger precision or adjustments")
