"""Keep optional goal reservations tied to a real account."""
from alembic import op
import sqlalchemy as sa

revision = "f0a100000006"
down_revision = "f0a100000005"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("goal_contributions", sa.Column("account_id", sa.Integer(), nullable=True))
    op.create_foreign_key("fk_goal_contribution_account", "goal_contributions", "accounts",
                          ["account_id"], ["id"], ondelete="RESTRICT")
    op.create_index("ix_goal_contribution_account", "goal_contributions", ["account_id"])


def downgrade():
    raise RuntimeError("Goal reservations need a matching backup before downgrade")
