"""Net worth aggregation: a single trend line plus a percent breakdown by
asset class.

Design note: "Cash" is not stored anywhere — it's derived live from
Account/Transaction data (checking/debit-card/savings/cash/investment accounts) so the
Transactions feature stays the single source of truth for liquid money.
Investment accounts count here too: their balance is uninvested/unallocated
money sitting on the account, not the market value of what's actually
invested — that value is still tracked manually via Asset/AssetValuation,
same as every other class (investments, crypto, real estate, vehicles,
precious metals, other). Without this, money deposited into an investment
account but not yet turned into a valued Asset silently disappeared from
net worth. Both halves are collapsed into one
daily, forward-filled series so the chart reads as one continuous line even
though the two halves are updated at very different cadences.
"""

from app.services.valuation_service import stock_series
from app.services.fx_service import FXConverter
from collections import defaultdict
from datetime import date as date_
from datetime import timedelta
from decimal import Decimal
from itertools import groupby

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import business_today
from app.models.account import Account
from app.models.asset import Asset, AssetValuation
from app.models.enums import AccountType, AssetClass, CapitalRole, RiskLevel, TransactionType
from app.models.transaction import Transaction
from app.schemas.net_worth import (
    CapitalRoleSummary,
    NetWorthBreakdownItem,
    NetWorthPoint,
    NetWorthSummary,
    RiskLevelItem,
    RiskLevelSummary,
)

CASH_ACCOUNT_TYPES = {
    AccountType.CHECKING,
    AccountType.DEBIT_CARD,
    AccountType.SAVINGS,
    AccountType.CASH,
    AccountType.INVESTMENT,
}

RANGE_DAYS = {"30d": 30, "90d": 90, "1y": 365, "5y": 365 * 5}

_CLASS_META: dict[str, tuple[str, str, str]] = {
    # key -> (display name, color, lucide icon). Colors follow the dataviz
    # skill's validated 8-slot order (blue, orange, aqua, yellow, magenta,
    # green, violet, red) in this exact sequence — an adjacent-pair-safe
    # order for a segmented bar/donut; do not reorder without re-validating.
    "cash": ("Счета и наличные", "#2a78d6", "wallet"),  # slot 1 blue
    AssetClass.INVESTMENTS.value: ("Инвестиции", "#eb6834", "trending-up"),  # slot 2 orange
    AssetClass.CRYPTO.value: ("Криптовалюта", "#1baf7a", "bitcoin"),  # slot 3 aqua
    AssetClass.REAL_ESTATE.value: ("Недвижимость", "#eda100", "building-2"),  # slot 4 yellow
    AssetClass.VEHICLES.value: ("Транспорт", "#e87ba4", "car"),  # slot 5 magenta
    AssetClass.PRECIOUS_METALS.value: ("Драгметаллы", "#008300", "gem"),  # slot 6 green
    AssetClass.OTHER.value: ("Прочее", "#4a3aa7", "package"),  # slot 7 violet
    # A receivable (docs/tasks/debt-tracking.md) joins the positive
    # breakdown as its own class-like slice — slot 8 red, the last of the
    # dataviz skill's validated 8-slot categorical order (see db/seed.py's
    # own "Health & Fitness" for the same hex). A liability never gets a
    # slot here on purpose — see get_net_worth_summary's own comment.
    "receivables": ("Мне должны", "#e34948", "hand-coins"),  # slot 8 red
}

_ROLE_META: dict[CapitalRole, tuple[str, str]] = {
    # role -> (label, color). Status colors, not categorical ones — "good"
    # and "critical" from the dataviz skill's fixed status palette, reused
    # verbatim from how StatCard/NetWorthChart already color income vs.
    # expense elsewhere in the app.
    CapitalRole.INCOME: ("Доходный", "var(--success)"),
    CapitalRole.NEUTRAL: ("Нейтральный", "var(--text-muted)"),
    CapitalRole.DRAIN: ("Убыточный", "var(--danger)"),
}

_RISK_META: dict[RiskLevel, tuple[str, str]] = {
    # Same status-color reuse as _ROLE_META — low risk reads as "good",
    # high risk as "critical", not a categorical hue.
    RiskLevel.LOW: ("Низкий", "var(--success)"),
    RiskLevel.MEDIUM: ("Средний", "var(--text-muted)"),
    RiskLevel.HIGH: ("Высокий", "var(--danger)"),
}


def _daily_series(events: list[tuple[date_, Decimal]], start: date_, end: date_) -> list[NetWorthPoint]:
    """Forward-fills a sparse, date-sorted list of cumulative totals into one
    point per calendar day. `events` before `start` still count — they just
    collapse into `start`'s opening value."""
    events = sorted(events, key=lambda e: e[0])
    points: list[NetWorthPoint] = []
    idx, n = 0, len(events)
    current = Decimal("0")
    day = start
    while day <= end:
        while idx < n and events[idx][0] <= day:
            current = events[idx][1]
            idx += 1
        points.append(NetWorthPoint(date=day, value=current))
        day += timedelta(days=1)
    return points


async def _cash_cumulative_events(session: AsyncSession) -> list[tuple[date_, Decimal]]:
    accounts_result = await session.execute(select(Account.id, Account.type))
    cash_account_ids = {acc_id for acc_id, acc_type in accounts_result.all() if acc_type in CASH_ACCOUNT_TYPES}

    txns_result = await session.execute(
        select(Transaction.date, Transaction.type, Transaction.amount, Transaction.account_id, Transaction.transfer_account_id)
    )

    delta_by_date: dict[date_, Decimal] = defaultdict(Decimal)
    for tx_date, tx_type, amount, account_id, transfer_account_id in txns_result.all():
        # DEBT_IN/DEBT_OUT (docs/tasks/debt-tracking.md) join the same cash
        # sign rule as their income/expense-shaped counterparts — a loan or
        # repayment really does move real cash, so it belongs in this same
        # daily cash series; the debt's own receivable/liability side is a
        # separate contribution merged in by get_net_worth_summary (see
        # debt_service.net_worth_contribution), never doubled here.
        if tx_type in (TransactionType.INCOME, TransactionType.ASSET_SELL, TransactionType.DEBT_IN) and account_id in cash_account_ids:
            delta_by_date[tx_date] += amount
        elif tx_type in (TransactionType.EXPENSE, TransactionType.ASSET_BUY, TransactionType.DEBT_OUT) and account_id in cash_account_ids:
            delta_by_date[tx_date] -= amount
        elif tx_type == TransactionType.TRANSFER:
            if account_id in cash_account_ids:
                delta_by_date[tx_date] -= amount
            if transfer_account_id in cash_account_ids:
                delta_by_date[tx_date] += amount

    events: list[tuple[date_, Decimal]] = []
    running = Decimal("0")
    for day in sorted(delta_by_date):
        running += delta_by_date[day]
        events.append((day, running))
    return events


async def _asset_events_and_class_totals(
    session: AsyncSession,
) -> tuple[list[tuple[date_, Decimal]], dict[AssetClass, Decimal], dict[int, Decimal]]:
    asset_class_result = await session.execute(select(Asset.id, Asset.asset_class))
    asset_class_map = dict(asset_class_result.all())

    valuations_result = await session.execute(
        select(AssetValuation.asset_id, AssetValuation.as_of_date, AssetValuation.value).order_by(
            AssetValuation.as_of_date, AssetValuation.id
        )
    )
    rows = valuations_result.all()

    current_by_asset: dict[int, Decimal] = {}
    events: list[tuple[date_, Decimal]] = []
    for day, group in groupby(rows, key=lambda row: row[1]):
        for asset_id, _, value in group:
            current_by_asset[asset_id] = value
        events.append((day, sum(current_by_asset.values(), Decimal("0"))))

    class_totals: dict[AssetClass, Decimal] = defaultdict(Decimal)
    for asset_id, value in current_by_asset.items():
        asset_class = asset_class_map.get(asset_id)
        if asset_class is not None:
            class_totals[asset_class] += value

    return events, class_totals, current_by_asset


async def _capital_role_summary(session: AsyncSession, current_by_asset: dict[int, Decimal]) -> list[CapitalRoleSummary]:
    """Cross-cuts the same assets by how the user tagged them (income /
    neutral / drain) instead of by asset class — always all three roles,
    even at zero, so the block reads as a fixed scale rather than a list
    that shuffles as assets are added."""
    roles_result = await session.execute(select(Asset.id, Asset.capital_role, Asset.monthly_cash_flow, Asset.currency))

    totals_value: dict[CapitalRole, Decimal] = defaultdict(Decimal)
    totals_flow: dict[CapitalRole, Decimal] = defaultdict(Decimal)
    counts: dict[CapitalRole, int] = defaultdict(int)
    fx = await FXConverter.load(session)
    for asset_id, role, cash_flow, currency in roles_result.all():
        totals_value[role] += current_by_asset.get(asset_id, Decimal("0"))
        totals_flow[role] += fx.convert(cash_flow or Decimal("0"), currency, business_today())
        counts[role] += 1

    return [
        CapitalRoleSummary(
            role=role.value,
            label=_ROLE_META[role][0],
            color=_ROLE_META[role][1],
            total_value=totals_value.get(role, Decimal("0")),
            monthly_cash_flow=totals_flow.get(role, Decimal("0")),
            count=counts.get(role, 0),
        )
        for role in CapitalRole
    ]


async def _risk_level_summary(
    session: AsyncSession, current_by_asset: dict[int, Decimal], cash_today: Decimal
) -> list[RiskLevelSummary]:
    """Cross-cuts Cash + assets by user-tagged risk of loss — unlike
    capital_roles, Cash participates here: it's the zero-risk anchor an
    80/20-style allocation rule ("80% of capital at zero risk, at most 20%
    exposed") is measured against. Always all three tiers, even at zero,
    same reasoning as capital_roles. Each tier's item list *is* its
    diversification view — a tier that's one holding at 100% is
    concentrated, several even-sized holdings aren't, no separate index."""
    assets_result = await session.execute(select(Asset.id, Asset.name, Asset.risk_level))
    asset_rows = assets_result.all()

    totals: dict[RiskLevel, Decimal] = defaultdict(Decimal)
    items_by_level: dict[RiskLevel, list[tuple[str, str, Decimal]]] = defaultdict(list)

    if cash_today:
        totals[RiskLevel.LOW] += cash_today
        items_by_level[RiskLevel.LOW].append(("cash", _CLASS_META["cash"][0], cash_today))

    for asset_id, name, risk_level in asset_rows:
        value = current_by_asset.get(asset_id, Decimal("0"))
        if value == 0:
            continue
        totals[risk_level] += value
        items_by_level[risk_level].append((f"asset:{asset_id}", name, value))

    grand_total = sum(totals.values(), Decimal("0"))

    def _share(amount: Decimal, denominator: Decimal) -> float:
        return float(amount / denominator * 100) if denominator else 0.0

    summaries = []
    for level in RiskLevel:
        tier_total = totals.get(level, Decimal("0"))
        items = [
            RiskLevelItem(key=key, name=name, amount=amount, percent=_share(amount, tier_total))
            for key, name, amount in sorted(items_by_level.get(level, []), key=lambda item: item[2], reverse=True)
        ]
        summaries.append(
            RiskLevelSummary(
                risk_level=level.value,
                label=_RISK_META[level][0],
                color=_RISK_META[level][1],
                total_value=tier_total,
                percent=_share(tier_total, grand_total),
                items=items,
            )
        )
    return summaries


def _resolve_start_date(range_key: str, cash_events: list[tuple[date_, Decimal]], asset_events: list[tuple[date_, Decimal]], today: date_) -> date_:
    if range_key in RANGE_DAYS:
        return today - timedelta(days=RANGE_DAYS[range_key] - 1)

    all_dates = [e[0] for e in cash_events] + [e[0] for e in asset_events]
    return min(all_dates) if all_dates else today


async def get_net_worth_summary(session: AsyncSession, range_key: str) -> NetWorthSummary:
    from app.services import debt_service  # local import: avoids a module-level cycle (debt_service has no reverse need of this module)

    today = business_today()
    start = today - timedelta(days=RANGE_DAYS[range_key] - 1) if range_key in RANGE_DAYS else None
    # "All time" (start is None here) must reach back to a debt's own
    # start_date too, not just the earliest cash/asset activity — an
    # opening debt dated before any transaction ever existed would
    # otherwise have its own earliest history silently clipped off the
    # left edge of the chart. Cheap enough to check unconditionally: a
    # second stock_series call only actually happens on the rare "all
    # time, and some debt predates every cash/asset event" combination.
    if start is None:
        earliest_debt_start = await debt_service.earliest_debt_start_date(session)
    else:
        earliest_debt_start = None
    points, cash_today, current_by_asset, assets, fx = await stock_series(session, start, today, account_types=CASH_ACCOUNT_TYPES)
    if earliest_debt_start is not None and points and earliest_debt_start < points[0][0]:
        points, cash_today, current_by_asset, assets, fx = await stock_series(
            session, earliest_debt_start, today, account_types=CASH_ACCOUNT_TYPES
        )
    class_totals = defaultdict(Decimal)
    for key, value in current_by_asset.items():
        class_totals[assets[key].asset_class] += value
    capital_roles = await _capital_role_summary(session, current_by_asset)

    # Debts (docs/tasks/debt-tracking.md) contribute a third, independent
    # stream: a receivable (owed_to_me) adds to capital like an asset, a
    # liability (owed_by_me) subtracts — "Capital = cash + assets +
    # receivables - liabilities", never double-counted against the same
    # debt's own linked cash Transaction (that Transaction only ever moves
    # `cash_today`/`points` above by the real amount that left/entered an
    # account; the receivable/liability figures below are the *other* side
    # of that same atomic event — the claim itself, not the cash it moved).
    effective_start = points[0][0] if points else today
    debt_points, receivable_today, liability_today = await debt_service.net_worth_contribution(
        session, fx, effective_start, today
    )
    series = [
        NetWorthPoint(date=day, value=cash_asset_value + receivable - liability)
        for (day, cash_asset_value), (_, receivable, liability) in zip(points, debt_points)
    ]

    current = series[-1].value if series else Decimal("0")
    start_value = series[0].value if series else Decimal("0")
    change_amount = current - start_value
    change_percent = float(change_amount / start_value * 100) if start_value else None

    # cash_events entries are already cumulative — the last one *is* today's total.
    # cash_today is the same as-of converted snapshot used by the final chart point.
    risk_levels = await _risk_level_summary(session, current_by_asset, cash_today)

    # Receivables join the *positive* breakdown/percent total below, same
    # as an asset class — a claim on someone else's money genuinely is
    # part of what's owned. Liabilities deliberately do NOT: a negative
    # donut slice would either invert the whole chart's meaning or get
    # silently clamped to zero, both of which hide money owed instead of
    # showing it — total_liabilities below is the explicit, separate figure
    # the frontend renders as its own callout instead (never folded into a
    # slice claiming to be part of "how capital is allocated").
    total = cash_today + sum(class_totals.values(), Decimal("0")) + receivable_today

    def _percent(amount: Decimal) -> float:
        return float(amount / total * 100) if total else 0.0

    breakdown = []
    name, color, icon = _CLASS_META["cash"]
    breakdown.append(NetWorthBreakdownItem(key="cash", name=name, color=color, icon=icon, amount=cash_today, percent=_percent(cash_today)))
    for asset_class in AssetClass:
        name, color, icon = _CLASS_META[asset_class.value]
        amount = class_totals.get(asset_class, Decimal("0"))
        breakdown.append(
            NetWorthBreakdownItem(key=asset_class.value, name=name, color=color, icon=icon, amount=amount, percent=_percent(amount))
        )
    if receivable_today:
        name, color, icon = _CLASS_META["receivables"]
        breakdown.append(
            NetWorthBreakdownItem(key="receivables", name=name, color=color, icon=icon, amount=receivable_today, percent=_percent(receivable_today))
        )

    return NetWorthSummary(
        fx_rates_used=fx.metadata(),
        reporting_currency=fx.currency,
        range=range_key,
        current=current,
        change_amount=change_amount,
        change_percent=change_percent,
        series=series,
        breakdown=breakdown,
        capital_roles=capital_roles,
        risk_levels=risk_levels,
        total_receivables=receivable_today,
        total_liabilities=liability_today,
    )
