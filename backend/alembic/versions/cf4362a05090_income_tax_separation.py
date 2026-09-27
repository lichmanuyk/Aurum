"""Add gross-income/mandatory-tax-payment classification — see
docs/tasks/income-tax-separation.md. Purely additive/nullable, same shape
as c1f5b3a8d942's expense_asset_id: an old row with neither column set keeps
reading exactly as before, and every write path treats "not classified" the
same way it already treats every other nullable optional field.

Revision ID: cf4362a05090
Revises: c1f5b3a8d942
Create Date: 2026-09-27 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'cf4362a05090'
down_revision: Union[str, None] = 'c1f5b3a8d942'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_KIND_VALUES = ("zus", "ppe", "vat")


def upgrade() -> None:
    kind = sa.Enum(*_KIND_VALUES, name="mandatory_payment_kind", native_enum=False, length=10)
    split_kind = sa.Enum(*_KIND_VALUES, name="split_mandatory_payment_kind", native_enum=False, length=10)
    recurring_kind = sa.Enum(*_KIND_VALUES, name="recurring_mandatory_payment_kind", native_enum=False, length=10)

    op.add_column('transactions', sa.Column('assigned_period', sa.Date(), nullable=True))
    op.add_column('transactions', sa.Column('mandatory_payment_kind', kind, nullable=True))
    op.create_check_constraint(
        'ck_transaction_assigned_period_month_start', 'transactions',
        'assigned_period IS NULL OR extract(day from assigned_period) = 1',
    )

    op.add_column('transaction_splits', sa.Column('assigned_period', sa.Date(), nullable=True))
    op.add_column('transaction_splits', sa.Column('mandatory_payment_kind', split_kind, nullable=True))
    op.create_check_constraint(
        'ck_transaction_split_assigned_period_month_start', 'transaction_splits',
        'assigned_period IS NULL OR extract(day from assigned_period) = 1',
    )

    op.add_column('recurring_transactions', sa.Column('mandatory_payment_kind', recurring_kind, nullable=True))


def downgrade() -> None:
    op.drop_column('recurring_transactions', 'mandatory_payment_kind')

    op.drop_constraint('ck_transaction_split_assigned_period_month_start', 'transaction_splits', type_='check')
    op.drop_column('transaction_splits', 'mandatory_payment_kind')
    op.drop_column('transaction_splits', 'assigned_period')

    op.drop_constraint('ck_transaction_assigned_period_month_start', 'transactions', type_='check')
    op.drop_column('transactions', 'mandatory_payment_kind')
    op.drop_column('transactions', 'assigned_period')
