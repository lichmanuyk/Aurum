"""Opening crypto balances with unknown purchase cost."""
from alembic import op
import sqlalchemy as sa
revision = "f0a100000003"
down_revision = "f0a100000002"
branch_labels = None
depends_on = None

def upgrade():
    op.alter_column("crypto_transactions", "price_per_unit", existing_type=sa.Numeric(38,18), nullable=True)

def downgrade():
    raise RuntimeError("Opening balances require nullable cost; restore a matching backup")
