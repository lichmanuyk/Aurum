"""add display currency settings

Revision ID: a3d5f8c2e914
Revises: f0a100000006
Create Date: 2026-09-25 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a3d5f8c2e914'
down_revision: Union[str, None] = 'f0a100000006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('app_settings', sa.Column('summary_currency', sa.String(length=3), nullable=True))
    op.add_column('app_settings', sa.Column('dashboard_currency', sa.String(length=3), nullable=True))
    op.add_column('app_settings', sa.Column('net_worth_currency', sa.String(length=3), nullable=True))
    op.add_column('app_settings', sa.Column('crypto_currency', sa.String(length=3), nullable=True))


def downgrade() -> None:
    op.drop_column('app_settings', 'crypto_currency')
    op.drop_column('app_settings', 'net_worth_currency')
    op.drop_column('app_settings', 'dashboard_currency')
    op.drop_column('app_settings', 'summary_currency')
