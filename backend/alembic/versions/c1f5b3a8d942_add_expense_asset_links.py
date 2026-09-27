"""Link ordinary expenses (and their split lines/templates) to a
manually-tracked asset — see docs/tasks/property-expense-links.md. Purely
additive/nullable: an old row with no link keeps reading exactly as before,
and every write path treats "no expense_asset_id column value" the same
way it already treats every other nullable optional field.

Revision ID: c1f5b3a8d942
Revises: b7e21f4a9c36
Create Date: 2026-09-27 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c1f5b3a8d942'
down_revision: Union[str, None] = 'b7e21f4a9c36'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('transactions', sa.Column('expense_asset_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_transaction_expense_asset', 'transactions', 'assets', ['expense_asset_id'], ['id'], ondelete='RESTRICT'
    )
    op.add_column('transaction_splits', sa.Column('expense_asset_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_transaction_split_expense_asset', 'transaction_splits', 'assets', ['expense_asset_id'], ['id'],
        ondelete='RESTRICT',
    )
    op.add_column('recurring_transactions', sa.Column('expense_asset_id', sa.Integer(), nullable=True))
    op.create_foreign_key(
        'fk_recurring_transaction_expense_asset', 'recurring_transactions', 'assets', ['expense_asset_id'], ['id'],
        ondelete='RESTRICT',
    )


def downgrade() -> None:
    op.drop_constraint('fk_recurring_transaction_expense_asset', 'recurring_transactions', type_='foreignkey')
    op.drop_column('recurring_transactions', 'expense_asset_id')
    op.drop_constraint('fk_transaction_split_expense_asset', 'transaction_splits', type_='foreignkey')
    op.drop_column('transaction_splits', 'expense_asset_id')
    op.drop_constraint('fk_transaction_expense_asset', 'transactions', type_='foreignkey')
    op.drop_column('transactions', 'expense_asset_id')
