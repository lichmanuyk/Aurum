"""Allow consecutive valuations for multiple manual-asset trades on one date."""
from alembic import op

revision = "f0a100000005"
down_revision = "f0a100000004"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_constraint("uq_asset_valuation_date", "asset_valuations", type_="unique")
    op.create_index("ix_asset_valuation_order", "asset_valuations", ["asset_id", "as_of_date", "id"])


def downgrade():
    raise RuntimeError("Multiple same-day asset valuations need a matching backup before downgrade")
