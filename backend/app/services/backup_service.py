"""Full-database JSON backup & restore.

Exports every row (accounts, categories, transactions, assets, asset
valuations) as one portable JSON document a user can download from the
browser and re-upload later. Restore fully REPLACES existing data — it's a
snapshot restore, not a merge — so the whole operation runs in one DB
transaction: a corrupt or incompatible file is rejected (referential checks
run first, before any row is touched), and any failure during the swap rolls
the database back to exactly where it was, so a bad file never leaves the
app half-restored.
"""

from app.models.fx import FXRate
from app.models.crypto import CryptoSyncState
from app.core.money import currency_code, validate_money, validate_ledger_money, adjustment_rule_violation
from app.models.enums import TransactionType
from app.schemas.fx import FXRateRead
import logging
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import APP_VERSION
from app.models.account import Account
from app.models.asset import Asset, AssetValuation
from app.models.budget import Budget
from app.models.category import Category
from app.models.crypto import CryptoHolding, CryptoPortfolio, CryptoTransaction
from app.models.goal import Goal, GoalContribution
from app.models.recurring import RecurringTransaction
from app.models.settings import AppSettings
from app.models.tag import Tag
from app.models.transaction import Transaction, TransactionSplit
from app.schemas.backup import (
    AccountBackup,
    AppSettingsBackup,
    AssetBackup,
    AssetValuationBackup,
    BackupPayload,
    BudgetBackup,
    CategoryBackup,
    CryptoHoldingBackup,
    CryptoPortfolioBackup,
    CryptoTransactionBackup,
    GoalBackup,
    GoalContributionBackup,
    RecurringTransactionBackup,
    TagBackup,
    TransactionBackup,
    TransactionSplitBackup,
)

logger = logging.getLogger(__name__)

BACKUP_FORMAT_VERSION = 4


async def build_backup(session: AsyncSession) -> BackupPayload:
    accounts = (await session.execute(select(Account))).scalars().all()
    categories = (await session.execute(select(Category))).scalars().all()
    tags = (await session.execute(select(Tag))).scalars().all()
    transactions = (await session.execute(select(Transaction).options(selectinload(Transaction.tags)))).scalars().all()
    transaction_splits = (await session.execute(select(TransactionSplit))).scalars().all()
    assets = (await session.execute(select(Asset))).scalars().all()
    valuations = (await session.execute(select(AssetValuation))).scalars().all()
    crypto_portfolios = (await session.execute(select(CryptoPortfolio))).scalars().all()
    crypto_holdings = (await session.execute(select(CryptoHolding))).scalars().all()
    crypto_transactions = (await session.execute(select(CryptoTransaction))).scalars().all()
    budgets = (await session.execute(select(Budget))).scalars().all()
    goals = (await session.execute(select(Goal))).scalars().all()
    goal_contributions = (await session.execute(select(GoalContribution))).scalars().all()
    recurring_transactions = (await session.execute(select(RecurringTransaction))).scalars().all()
    app_settings = await session.get(AppSettings, 1)

    return BackupPayload(
        fx_rates=[FXRateRead.model_validate(r) for r in (await session.scalars(select(FXRate))).all()],
        aurum_backup_version=BACKUP_FORMAT_VERSION,
        exported_at=datetime.now(timezone.utc),
        app_version=APP_VERSION,
        accounts=[AccountBackup.model_validate(row) for row in accounts],
        categories=[CategoryBackup.model_validate(row) for row in categories],
        tags=[TagBackup.model_validate(row) for row in tags],
        transactions=[
            TransactionBackup.model_validate(row, from_attributes=True).model_copy(
                update={"tag_ids": [tag.id for tag in row.tags]}
            )
            for row in transactions
        ],
        transaction_splits=[TransactionSplitBackup.model_validate(row) for row in transaction_splits],
        assets=[AssetBackup.model_validate(row) for row in assets],
        asset_valuations=[AssetValuationBackup.model_validate(row) for row in valuations],
        crypto_portfolios=[CryptoPortfolioBackup.model_validate(row) for row in crypto_portfolios],
        crypto_holdings=[CryptoHoldingBackup.model_validate(row) for row in crypto_holdings],
        crypto_transactions=[CryptoTransactionBackup.model_validate(row) for row in crypto_transactions],
        budgets=[BudgetBackup.model_validate(row) for row in budgets],
        goals=[GoalBackup.model_validate(row) for row in goals],
        goal_contributions=[GoalContributionBackup.model_validate(row) for row in goal_contributions],
        recurring_transactions=[RecurringTransactionBackup.model_validate(row) for row in recurring_transactions],
        app_settings=AppSettingsBackup.model_validate(app_settings) if app_settings else AppSettingsBackup(currency="USD"),
    )


def _validate_references(payload: BackupPayload) -> None:
    account_ids = {row.id for row in payload.accounts}
    category_ids = {row.id for row in payload.categories}
    asset_ids = {row.id for row in payload.assets}
    tag_ids = {row.id for row in payload.tags}

    for c in payload.categories:
        if c.parent_id is not None and c.parent_id not in category_ids:
            raise HTTPException(400, f"Category {c.id} references unknown parent_id {c.parent_id}")

    for t in payload.transactions:
        if t.account_id not in account_ids:
            raise HTTPException(400, f"Transaction {t.id} references unknown account_id {t.account_id}")
        if t.transfer_account_id is not None and t.transfer_account_id not in account_ids:
            raise HTTPException(
                400, f"Transaction {t.id} references unknown transfer_account_id {t.transfer_account_id}"
            )
        if t.category_id is not None and t.category_id not in category_ids:
            raise HTTPException(400, f"Transaction {t.id} references unknown category_id {t.category_id}")
        for tag_id in t.tag_ids:
            if tag_id not in tag_ids:
                raise HTTPException(400, f"Transaction {t.id} references unknown tag_id {tag_id}")

    transaction_ids = {row.id for row in payload.transactions}
    for s in payload.transaction_splits:
        if s.transaction_id not in transaction_ids:
            raise HTTPException(400, f"Transaction split {s.id} references unknown transaction_id {s.transaction_id}")
        if s.category_id is not None and s.category_id not in category_ids:
            raise HTTPException(400, f"Transaction split {s.id} references unknown category_id {s.category_id}")

    for v in payload.asset_valuations:
        if v.asset_id not in asset_ids:
            raise HTTPException(400, f"Asset valuation {v.id} references unknown asset_id {v.asset_id}")

    crypto_portfolio_ids = {p.id for p in payload.crypto_portfolios}
    crypto_holding_asset_ids = {h.asset_id for h in payload.crypto_holdings}
    for h in payload.crypto_holdings:
        if h.asset_id not in asset_ids:
            raise HTTPException(400, f"Crypto holding {h.asset_id} references unknown asset_id {h.asset_id}")
        # portfolio_id is allowed to be None (a pre-portfolios backup) — that
        # case is resolved to an auto-created fallback portfolio at restore
        # time, not validated here.
        if h.portfolio_id is not None and h.portfolio_id not in crypto_portfolio_ids:
            raise HTTPException(
                400, f"Crypto holding {h.asset_id} references unknown portfolio_id {h.portfolio_id}"
            )

    for tx in payload.crypto_transactions:
        if tx.asset_id not in crypto_holding_asset_ids:
            raise HTTPException(400, f"Crypto transaction {tx.id} references unknown asset_id {tx.asset_id}")

    for b in payload.budgets:
        if b.category_id not in category_ids:
            raise HTTPException(400, f"Budget {b.id} references unknown category_id {b.category_id}")

    goal_ids = {row.id for row in payload.goals}
    for c in payload.goal_contributions:
        if c.goal_id not in goal_ids:
            raise HTTPException(400, f"Goal contribution {c.id} references unknown goal_id {c.goal_id}")

    for r in payload.recurring_transactions:
        if r.account_id not in account_ids:
            raise HTTPException(400, f"Recurring transaction {r.id} references unknown account_id {r.account_id}")
        if r.transfer_account_id is not None and r.transfer_account_id not in account_ids:
            raise HTTPException(
                400,
                f"Recurring transaction {r.id} references unknown transfer_account_id {r.transfer_account_id}",
            )
        if r.category_id is not None and r.category_id not in category_ids:
            raise HTTPException(400, f"Recurring transaction {r.id} references unknown category_id {r.category_id}")


async def _reset_sequence(session: AsyncSession, table: str, rows: list) -> None:
    """Bulk-inserting rows with explicit ids doesn't advance the table's
    identity sequence, so the next auto-generated id would collide — bump it
    to max(id) after a restore. `table` is always one of our five hardcoded
    table names, never user input."""
    if not rows:
        return
    max_id = max(row.id for row in rows)
    await session.execute(
        text(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), :max_id)"), {"max_id": max_id}
    )


async def restore_backup(session: AsyncSession, payload: BackupPayload) -> None:
    if payload.aurum_backup_version not in (1, 2, 3, BACKUP_FORMAT_VERSION):
        raise HTTPException(
            400,
            f"Unsupported backup version {payload.aurum_backup_version} "
            f"(this Aurum version supports {BACKUP_FORMAT_VERSION})",
        )

    _validate_references(payload)
    _validate_money_backup(payload)

    try:
        await session.execute(delete(FXRate))
        await session.execute(delete(CryptoSyncState))
        session.add_all(FXRate(**row.model_dump()) for row in payload.fx_rates)
        # Children before parents.
        await session.execute(delete(AssetValuation))
        await session.execute(delete(CryptoTransaction))
        await session.execute(delete(CryptoHolding))
        await session.execute(delete(CryptoPortfolio))
        await session.execute(delete(Budget))
        await session.execute(delete(GoalContribution))
        await session.execute(delete(Goal))
        await session.execute(delete(RecurringTransaction))
        # Deleting transactions cascades transaction_tags and
        # transaction_splits rows (ON DELETE CASCADE) — deleted explicitly
        # here anyway to keep this block's ordering self-documenting.
        await session.execute(delete(TransactionSplit))
        await session.execute(delete(Transaction))
        await session.execute(delete(Tag))
        await session.execute(delete(Asset))
        await session.execute(delete(Category))
        await session.execute(delete(Account))

        # Parents before children. Categories are additionally self-referential
        # (parent_id points at another row in the same table) — sort
        # top-level categories first so a subcategory's FK is never inserted
        # ahead of the row it points to.
        categories_in_order = sorted(payload.categories, key=lambda row: row.parent_id is not None)

        session.add_all(Account(**row.model_dump()) for row in payload.accounts)
        session.add_all(Category(**row.model_dump()) for row in categories_in_order)
        session.add_all(Asset(**row.model_dump()) for row in payload.assets)

        # Tags and transactions are kept in id-keyed dicts (rather than a
        # plain add_all) — transaction.tags is a relationship, not a column
        # in model_dump(), so it has to be wired up from live ORM objects
        # once everything is flushed and has real identities.
        tags_by_id = {row.id: Tag(**row.model_dump()) for row in payload.tags}
        session.add_all(tags_by_id.values())
        # tags=[] at construction keeps the collection "loaded" on the
        # transient object — reassigning it after flush (below) would
        # otherwise trigger an implicit lazy-load, which async SQLAlchemy
        # can't do outside an explicit await (MissingGreenlet).
        transactions_by_id = {
            row.id: Transaction(**row.model_dump(exclude={"tag_ids"}), tags=[]) for row in payload.transactions
        }
        session.add_all(transactions_by_id.values())
        session.add_all(TransactionSplit(**row.model_dump()) for row in payload.transaction_splits)

        session.add_all(AssetValuation(**row.model_dump()) for row in payload.asset_valuations)

        session.add_all(CryptoPortfolio(**row.model_dump()) for row in payload.crypto_portfolios)
        # A pre-portfolios backup has no crypto_portfolios and every holding's
        # portfolio_id is None — give those holdings a freshly created
        # fallback portfolio instead of leaving the NOT NULL column unset.
        # Wired up via the `portfolio` relationship (not a raw portfolio_id
        # int) because the fallback row has no id yet — same "assign the
        # relationship, not the id column, before flush" reasoning as
        # transactions_by_id/tags_by_id above.
        fallback_portfolio: CryptoPortfolio | None = None
        if any(row.portfolio_id is None for row in payload.crypto_holdings):
            fallback_portfolio = CryptoPortfolio(name="Main Portfolio", color="#2a78d6")
            session.add(fallback_portfolio)

        crypto_holdings = []
        for row in payload.crypto_holdings:
            holding = CryptoHolding(**row.model_dump(exclude={"portfolio_id"}))
            if row.portfolio_id is not None:
                holding.portfolio_id = row.portfolio_id
            else:
                holding.portfolio = fallback_portfolio
            crypto_holdings.append(holding)
        session.add_all(crypto_holdings)

        session.add_all(CryptoTransaction(**row.model_dump()) for row in payload.crypto_transactions)
        session.add_all(Budget(**row.model_dump()) for row in payload.budgets)
        session.add_all(Goal(**row.model_dump()) for row in payload.goals)
        session.add_all(GoalContribution(**row.model_dump()) for row in payload.goal_contributions)
        session.add_all(RecurringTransaction(**row.model_dump()) for row in payload.recurring_transactions)
        await session.flush()

        for row in payload.transactions:
            if row.tag_ids:
                transactions_by_id[row.id].tags = [tags_by_id[tag_id] for tag_id in row.tag_ids]
        if any(row.tag_ids for row in payload.transactions):
            await session.flush()

        await _reset_sequence(session, "fx_rates", payload.fx_rates)
        await _reset_sequence(session, "accounts", payload.accounts)
        await _reset_sequence(session, "categories", payload.categories)
        await _reset_sequence(session, "tags", payload.tags)
        await _reset_sequence(session, "assets", payload.assets)
        await _reset_sequence(session, "transactions", payload.transactions)
        await _reset_sequence(session, "transaction_splits", payload.transaction_splits)
        await _reset_sequence(session, "asset_valuations", payload.asset_valuations)
        # Only needed for explicit-id portfolios from payload — a fallback
        # portfolio (no payload row) already got its id from the sequence
        # itself, so the sequence is already correctly positioned for it.
        await _reset_sequence(session, "crypto_portfolios", payload.crypto_portfolios)
        await _reset_sequence(session, "crypto_transactions", payload.crypto_transactions)
        await _reset_sequence(session, "budgets", payload.budgets)
        await _reset_sequence(session, "goals", payload.goals)
        await _reset_sequence(session, "goal_contributions", payload.goal_contributions)
        await _reset_sequence(session, "recurring_transactions", payload.recurring_transactions)

        # Singleton row — updated in place, not deleted/recreated (no
        # sequence to reset, id is always 1).
        app_settings = await session.get(AppSettings, 1)
        if app_settings is None:
            session.add(AppSettings(id=1, **payload.app_settings.model_dump()))
        else:
            for field, value in payload.app_settings.model_dump().items():
                setattr(app_settings, field, value)

        await session.commit()
    except HTTPException:
        await session.rollback()
        raise
    except Exception as exc:
        await session.rollback()
        # The exception text is SQLAlchemy's, naming tables, columns and
        # constraints — a free map of the schema for anyone probing the API.
        # It goes to the container log, where the operator can actually read
        # it; the client gets told only that nothing changed.
        logger.exception("Backup restore failed")
        raise HTTPException(400, "Restore failed, no changes were made") from exc


def _validate_money_backup(payload):
    """Preflight runs before deletes; v1 unresolved facts are preserved, never guessed."""
    from app.schemas.transaction import transfer_rule_violation
    from collections import defaultdict
    accounts = {a.id: a for a in payload.accounts}
    try:
        currency_code(payload.app_settings.currency)
        for name in ("accounts", "categories", "transactions", "assets", "asset_valuations", "goals", "budgets", "tags", "transaction_splits", "crypto_transactions", "crypto_portfolios", "goal_contributions", "recurring_transactions", "fx_rates"):
            rows = getattr(payload, name)
            if len({r.id for r in rows}) != len(rows):
                raise ValueError(f"Duplicate IDs in {name}")
        for row in [*payload.accounts, *payload.assets]:
            currency_code(row.currency)
        for row in [*payload.goals, *payload.budgets]:
            if row.currency is None and payload.aurum_backup_version == 1:
                row.currency = payload.app_settings.currency
            currency_code(row.currency)
        if payload.app_settings.idle_cash_threshold_currency is None:
            if payload.aurum_backup_version != 1:
                raise ValueError("Missing threshold currency")
            payload.app_settings.idle_cash_threshold_currency = payload.app_settings.currency
        currency_code(payload.app_settings.idle_cash_threshold_currency)
        validate_money(payload.app_settings.idle_cash_threshold_amount, payload.app_settings.idle_cash_threshold_currency)
        assets = {a.id: a for a in payload.assets}
        goals = {g.id: g for g in payload.goals}
        for row in payload.goals:
            validate_money(row.target_amount, row.currency)
            if row.target_amount <= 0:
                raise ValueError("Goal target must be positive")
        for row in payload.budgets:
            validate_money(row.monthly_limit, row.currency)
            if row.monthly_limit <= 0:
                raise ValueError("Budget limit must be positive")
        for row in payload.goal_contributions:
            validate_money(row.amount, goals[row.goal_id].currency)
        for row in payload.asset_valuations:
            validate_money(row.value, assets[row.asset_id].currency)
        for row in payload.assets:
            if row.monthly_cash_flow is not None:
                validate_money(row.monthly_cash_flow, row.currency)
        for row in payload.recurring_transactions:
            validate_money(row.amount, accounts[row.account_id].currency)
            violation = transfer_rule_violation(type=row.type, account_id=row.account_id,
                transfer_account_id=row.transfer_account_id, category_id=row.category_id)
            if row.amount <= 0 or violation or row.type == TransactionType.ADJUSTMENT:
                raise ValueError(violation or "Recurring amount must be positive")
        for row in payload.crypto_transactions:
            if row.quote_currency is not None:
                currency_code(row.quote_currency)
            if not row.quantity.is_finite() or row.quantity <= 0 or (row.price_per_unit is not None and (not row.price_per_unit.is_finite() or row.price_per_unit < 0)):
                raise ValueError("Invalid crypto quantity or price")
        from app.services.crypto_service import _validate_trade_history
        for holding in payload.crypto_holdings:
            _validate_trade_history([t for t in payload.crypto_transactions if t.asset_id == holding.asset_id])
        if len({h.asset_id for h in payload.crypto_holdings}) != len(payload.crypto_holdings):
            raise ValueError("Duplicate crypto holdings")
        keys = set()
        for rate in payload.fx_rates:
            key = (rate.base_currency, rate.quote_currency, rate.rate_date)
            if rate.base_currency >= rate.quote_currency or key in keys:
                raise ValueError("FX pairs must be canonical and unique")
            keys.add(key)
        splits = defaultdict(list)
        for split in payload.transaction_splits:
            splits[split.transaction_id].append(split)
        for tx in payload.transactions:
            violation = transfer_rule_violation(type=tx.type, account_id=tx.account_id,
                transfer_account_id=tx.transfer_account_id, category_id=tx.category_id)
            if violation:
                raise ValueError(violation)
            native = accounts[tx.account_id].currency
            validate_ledger_money(tx.amount, native)
            violation = adjustment_rule_violation(tx.type, tx.amount, tx.adjustment_reason, tx.category_id)
            if violation or (tx.type == TransactionType.ADJUSTMENT and splits[tx.id]):
                raise ValueError(violation or "Adjustments cannot have splits")
            if tx.type == TransactionType.TRANSFER:
                target = accounts.get(tx.transfer_account_id)
                if tx.transfer_account_id == tx.account_id or tx.category_id is not None or splits[tx.id]:
                    raise ValueError("Invalid transfer")
                if target and target.currency == native:
                    if tx.destination_amount is None and payload.aurum_backup_version == 1:
                        tx.destination_amount = tx.amount
                    if tx.destination_amount != tx.amount:
                        raise ValueError("Same-currency transfer amounts differ")
                if tx.destination_amount is not None:
                    if tx.destination_amount <= 0:
                        raise ValueError("Invalid destination amount")
                    if target:
                        validate_ledger_money(tx.destination_amount, target.currency)
            elif tx.destination_amount is not None or tx.transfer_account_id is not None:
                raise ValueError("Non-transfer has destination")
            override = (tx.reporting_amount_override, tx.reporting_currency_override, tx.reporting_override_source)
            if any(v is not None for v in override):
                if not all(v is not None for v in override) or tx.type not in (TransactionType.INCOME, TransactionType.EXPENSE) or override[0] <= 0:
                    raise ValueError("Invalid reporting override")
                validate_ledger_money(override[0], override[1])
            if splits[tx.id]:
                if len(splits[tx.id]) < 2 or tx.category_id is not None or sum(s.amount for s in splits[tx.id]) != tx.amount:
                    raise ValueError("Invalid split total")
                for split in splits[tx.id]:
                    validate_ledger_money(split.amount, native)
                    if split.amount <= 0:
                        raise ValueError("Invalid split amount")
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, str(exc)) from exc
