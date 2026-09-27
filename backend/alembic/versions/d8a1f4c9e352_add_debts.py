"""Add debt tracking (debts, debt_repayments) — see
docs/tasks/debt-tracking.md and models/debt.py. Two brand-new tables plus
two new transaction_type values (debt_in/debt_out); no existing column
changes, so every prior row keeps reading exactly as before.

Revision ID: d8a1f4c9e352
Revises: cf4362a05090
Create Date: 2026-09-27 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd8a1f4c9e352'
down_revision: Union[str, None] = 'cf4362a05090'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # transactions.type is a plain VARCHAR(10) (native_enum=False, no DB
    # CHECK — see models/transaction.py), the same shape asset_buy/
    # asset_sell were added under without any migration at all; "debt_in"/
    # "debt_out" (7/8 chars) fit within the existing length, so nothing to
    # alter here either — only the two brand-new tables below.
    direction = sa.Enum('owed_to_me', 'owed_by_me', name='debt_direction', native_enum=False, length=20)
    kind = sa.Enum('repayment', 'reversal', name='debt_repayment_kind', native_enum=False, length=20)

    op.create_table(
        'debts',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('direction', direction, nullable=False),
        sa.Column('counterparty', sa.String(150), nullable=False),
        sa.Column('currency', sa.String(3), nullable=False),
        sa.Column('principal_amount', sa.Numeric(18, 6), nullable=False),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('due_date', sa.Date(), nullable=True),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('issuance_transaction_id', sa.Integer(), sa.ForeignKey('transactions.id', ondelete='RESTRICT'), nullable=True),
        sa.Column('idempotency_key', sa.String(64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_unique_constraint('uq_debt_issuance_transaction', 'debts', ['issuance_transaction_id'])
    op.create_unique_constraint('uq_debt_idempotency_key', 'debts', ['idempotency_key'])

    op.create_table(
        'debt_repayments',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('debt_id', sa.Integer(), sa.ForeignKey('debts.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('transaction_id', sa.Integer(), sa.ForeignKey('transactions.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('kind', kind, nullable=False, server_default='repayment'),
        sa.Column('reverses_repayment_id', sa.Integer(), sa.ForeignKey('debt_repayments.id', ondelete='RESTRICT'), nullable=True),
        sa.Column('amount_debt_currency', sa.Numeric(18, 6), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('idempotency_key', sa.String(64), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_unique_constraint('uq_debt_repayment_transaction', 'debt_repayments', ['transaction_id'])
    op.create_unique_constraint('uq_debt_repayment_reverses', 'debt_repayments', ['reverses_repayment_id'])
    op.create_unique_constraint('uq_debt_repayment_idempotency_key', 'debt_repayments', ['idempotency_key'])
    op.create_index('ix_debt_repayments_debt_id', 'debt_repayments', ['debt_id'])


def downgrade() -> None:
    raise RuntimeError("Debt history needs a matching backup before downgrade")
