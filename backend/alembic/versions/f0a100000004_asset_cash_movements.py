"""Link asset trades to their actual cash legs without rewriting old history."""
from alembic import op
import sqlalchemy as sa

revision = "f0a100000004"
down_revision = "f0a100000003"
branch_labels = None
depends_on = None


def upgrade():
    for name, kind in (
        ("asset_id", sa.Integer()),
        ("crypto_transaction_id", sa.Integer()),
        ("asset_valuation_id", sa.Integer()),
        ("gross_amount", sa.Numeric(18, 6)),
        ("fee_amount", sa.Numeric(18, 6)),
        ("prior_asset_value", sa.Numeric(14, 2)),
        ("idempotency_key", sa.String(64)),
    ):
        op.add_column("transactions", sa.Column(name, kind, nullable=True))
    op.create_foreign_key("fk_transaction_asset", "transactions", "assets", ["asset_id"], ["id"], ondelete="RESTRICT")
    op.create_foreign_key("fk_transaction_crypto_trade", "transactions", "crypto_transactions", ["crypto_transaction_id"], ["id"], ondelete="RESTRICT")
    op.create_foreign_key("fk_transaction_asset_valuation", "transactions", "asset_valuations", ["asset_valuation_id"], ["id"], ondelete="RESTRICT")
    op.create_unique_constraint("uq_transaction_crypto_trade", "transactions", ["crypto_transaction_id"])
    op.create_unique_constraint("uq_transaction_asset_valuation", "transactions", ["asset_valuation_id"])
    op.create_unique_constraint("uq_transaction_idempotency_key", "transactions", ["idempotency_key"])


def downgrade():
    raise RuntimeError("Cash-linked asset history needs a matching backup before downgrade")
