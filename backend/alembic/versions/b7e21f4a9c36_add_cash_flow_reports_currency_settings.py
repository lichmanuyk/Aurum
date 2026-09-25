"""add cash flow and reports display currency settings

Revision ID: b7e21f4a9c36
Revises: a3d5f8c2e914
Create Date: 2026-09-25 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7e21f4a9c36'
down_revision: Union[str, None] = 'a3d5f8c2e914'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('app_settings', sa.Column('cash_flow_currency', sa.String(length=3), nullable=True))
    op.add_column('app_settings', sa.Column('reports_currency', sa.String(length=3), nullable=True))


def downgrade() -> None:
    op.drop_column('app_settings', 'reports_currency')
    op.drop_column('app_settings', 'cash_flow_currency')
