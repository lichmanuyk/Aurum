"""One-off, reusable, guarded repair for a proven-defective Monefy import
reporting override (see docs/tasks/monefy-reporting-repair.md).

Reads a *frozen* private preview (built once by an offline audit — never by
this script) listing exact transaction ids together with a full identity
snapshot (native amount/currency, account, date, type, category, CSV
provenance) and the current/proposed reporting-override triple, and applies
ONLY that triple (`reporting_amount_override`, `reporting_currency_override`,
`reporting_override_source`) as an all-or-none change, always old-value ->
null, never a computed replacement. Every other column is read-only here.

Safety model:
- Default is dry-run: reports what *would* change, writes nothing.
- --apply requires an exact confirmation phrase on stdin (not a flag alone),
  same spirit as every other destructive CLI in this codebase.
- --source-sha256 must equal every preview entry's own recorded CSV source
  hash — a stray/regenerated preview from a different export can never be
  applied silently.
- Single DB transaction: `SELECT ... FOR UPDATE` locks every listed row up
  front, then every precondition for every row is checked *before* any
  UPDATE is issued. Any single conflict aborts the whole batch — there is
  no partial commit. This includes rows that are already fully repaired
  (see "Idempotent" below): even a no-op row must still prove its identity
  still matches the frozen preview, or the whole batch aborts.
- Identity guards, all checked under the same row lock, for every row:
  account_id, the account's *current* currency, date, type, category_id all
  equal the preview's frozen snapshot; native amount equals the preview's
  frozen native amount. This is what actually proves "this specific override
  was the mathematically-impossible 1:1 artifact the audit found" rather
  than trusting the preview's say-so — a concurrent edit to the underlying
  transaction (account move, amount correction, re-date, re-category) after
  the preview was frozen invalidates that proof and must abort the batch,
  not silently proceed against stale identity.
- Idempotent: a repeat run where a row's current DB override triple already
  equals the proposed (all-null) triple is treated as "already applied"
  (no-op, not a conflict) — but only once its identity guards above still
  hold; if the transaction has since changed shape, an "already applied"
  row is just as much a conflict as an unapplied one.
- Never touches amount/date/account_id/category_id/description/notes/tags/
  splits/mandatory_payment_kind/debt_*/expense_asset_id/asset_id/transfer
  legs/destination_amount/AssetValuation/fx_rates/app_settings. Rows whose
  type is not income/expense, or whose current
  `reporting_override_source` is not exactly "monefy", are always treated
  as a conflict (never silently skipped) — a `manual` override or a
  transfer/adjustment/debt row must never reach the UPDATE.
"""
import argparse
import asyncio
import json
import os
import sys
from dataclasses import dataclass
from datetime import date as date_cls, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.core.money import CURRENCIES, validate_ledger_money
from app.db.session import AsyncSessionLocal
from app.models.account import Account
from app.models.enums import TransactionType
from app.models.transaction import Transaction

REPAIRABLE_TYPES = {"income", "expense"}
REQUIRED_SOURCE = "monefy"
OVERRIDE_FIELDS = ("reporting_amount_override", "reporting_currency_override", "reporting_override_source")
IDENTITY_FIELDS = ("account_id", "type", "date", "category_id", "native_amount", "native_currency")
MAX_CSV_ROW = 100_000_000  # generous bound; only rules out garbage/negative row numbers


class PreviewError(ValueError):
    """The frozen preview itself is malformed — never a per-row DB conflict."""


def _require_decimal(value, *, field: str, allow_none: bool = False) -> Decimal | None:
    if value is None and allow_none:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise PreviewError(f"{field} must be a decimal string, got {type(value).__name__}")
    try:
        parsed = Decimal(str(value))
    except InvalidOperation as exc:
        raise PreviewError(f"{field} is not a valid decimal: {value!r}") from exc
    if not parsed.is_finite():
        raise PreviewError(f"{field} must be finite, got {value!r}")
    return parsed


def _require_currency(value, *, field: str) -> str:
    if not isinstance(value, str) or value not in CURRENCIES:
        raise PreviewError(f"{field} must be a supported ISO currency code, got {value!r}")
    return value


def _require_positive_int(value, *, field: str) -> int:
    if type(value) is not int or value <= 0:
        raise PreviewError(f"{field} must be a positive int, got {value!r}")
    return value


@dataclass(frozen=True)
class PlannedChange:
    transaction_id: int
    csv_source_row: int
    source_csv_sha256: str
    old_amount: Decimal
    old_currency: str
    old_source: str
    account_id: int
    type: str
    date: date_cls
    category_id: int | None
    native_amount: Decimal
    native_currency: str


def load_preview(path: Path, *, expected_source_sha256: str) -> list[PlannedChange]:
    """Parse and strictly validate the frozen preview shape. Any malformed,
    duplicate, ambiguous, or non-identity entry rejects the *entire* preview
    before any DB access — a bad preview must never partially apply."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PreviewError(f"Cannot read preview: {exc}") from exc
    changes = raw.get("changes") if isinstance(raw, dict) else None
    if not isinstance(changes, list) or not changes:
        raise PreviewError("Preview must contain a non-empty 'changes' list")
    if raw.get("fields_changed") != list(OVERRIDE_FIELDS):
        raise PreviewError("Preview must declare exactly the three override fields as fields_changed")

    planned: list[PlannedChange] = []
    seen_ids: set[int] = set()
    for index, entry in enumerate(changes):
        if not isinstance(entry, dict):
            raise PreviewError(f"changes[{index}]: not an object")
        try:
            tx_id = entry["transaction_id"]
            csv_source_row = entry["csv_source_row"]
            source_sha = entry["source_csv_sha256"]
            identity = entry["identity"]
            current = entry["current"]
            proposed = entry["proposed"]
        except KeyError as exc:
            raise PreviewError(f"changes[{index}]: missing {exc}") from exc

        tx_id = _require_positive_int(tx_id, field=f"changes[{index}].transaction_id")
        if tx_id in seen_ids:
            raise PreviewError(f"changes[{index}]: duplicate transaction_id {tx_id} — ambiguous preview")
        seen_ids.add(tx_id)

        csv_source_row = _require_positive_int(csv_source_row, field=f"changes[{index}].csv_source_row")
        if csv_source_row > MAX_CSV_ROW:
            raise PreviewError(f"changes[{index}]: csv_source_row out of range")
        if not isinstance(source_sha, str) or len(source_sha) != 64 or source_sha != source_sha.lower():
            raise PreviewError(f"changes[{index}]: source_csv_sha256 must be a lowercase 64-hex digest")
        if source_sha != expected_source_sha256:
            raise PreviewError(
                f"changes[{index}]: source_csv_sha256 {source_sha} does not match --source-sha256 "
                f"{expected_source_sha256} — refusing a preview built from a different export"
            )

        if not isinstance(current, dict) or set(current) != set(OVERRIDE_FIELDS):
            raise PreviewError(f"changes[{index}]: current must have exactly the three override keys")
        if not isinstance(proposed, dict) or set(proposed) != set(OVERRIDE_FIELDS):
            raise PreviewError(f"changes[{index}]: proposed must have exactly the three override keys")
        if any(proposed[field] is not None for field in OVERRIDE_FIELDS):
            raise PreviewError(f"changes[{index}]: proposed must be all-null (removal only), got {proposed}")

        old_amount = _require_decimal(current["reporting_amount_override"],
                                       field=f"changes[{index}].current.reporting_amount_override")
        old_currency = _require_currency(current["reporting_currency_override"],
                                          field=f"changes[{index}].current.reporting_currency_override")
        old_source = current["reporting_override_source"]
        if old_source != REQUIRED_SOURCE:
            raise PreviewError(
                f"changes[{index}]: current.reporting_override_source must be '{REQUIRED_SOURCE}', "
                f"got {old_source!r} — manual overrides are never in scope for this repair"
            )
        if old_amount is None or old_amount <= 0:
            raise PreviewError(f"changes[{index}]: current override amount must be positive")
        try:
            validate_ledger_money(old_amount, old_currency)
        except ValueError as exc:
            raise PreviewError(f"changes[{index}]: current override amount fails ledger validation: {exc}") from exc

        if not isinstance(identity, dict) or set(identity) != set(IDENTITY_FIELDS):
            raise PreviewError(f"changes[{index}]: identity must have exactly {IDENTITY_FIELDS}")
        account_id = _require_positive_int(identity["account_id"], field=f"changes[{index}].identity.account_id")
        tx_type = identity["type"]
        if tx_type not in REPAIRABLE_TYPES:
            raise PreviewError(f"changes[{index}]: identity.type must be income/expense, got {tx_type!r}")
        raw_date = identity["date"]
        if not isinstance(raw_date, str):
            raise PreviewError(f"changes[{index}]: identity.date must be an ISO date string")
        try:
            tx_date = date_cls.fromisoformat(raw_date)
        except ValueError as exc:
            raise PreviewError(f"changes[{index}]: invalid identity.date {raw_date!r}: {exc}") from exc
        raw_category = identity["category_id"]
        if raw_category is not None:
            raw_category = _require_positive_int(raw_category, field=f"changes[{index}].identity.category_id")
        native_amount = _require_decimal(identity["native_amount"], field=f"changes[{index}].identity.native_amount")
        native_currency = _require_currency(identity["native_currency"],
                                             field=f"changes[{index}].identity.native_currency")
        if native_amount is None or native_amount <= 0:
            raise PreviewError(f"changes[{index}]: identity.native_amount must be positive")
        try:
            validate_ledger_money(native_amount, native_currency)
        except ValueError as exc:
            raise PreviewError(f"changes[{index}]: identity.native_amount fails ledger validation: {exc}") from exc

        # The actual mathematical proof this row is the audited defect: the
        # override amount was copied verbatim from the native amount despite
        # a different currency. Without both halves of this, a preview entry
        # is describing an ordinary (possibly correct) cross-currency
        # override, not the proven 1:1 artifact — reject it outright rather
        # than let a hand-edited or mis-generated preview slip a legitimate
        # override into this repair's scope.
        if native_currency == old_currency:
            raise PreviewError(
                f"changes[{index}]: native_currency equals override currency ({native_currency}) — "
                "this is not a cross-currency 1:1 artifact, out of scope for this repair"
            )
        if native_amount != old_amount:
            raise PreviewError(
                f"changes[{index}]: native_amount {native_amount} != override amount {old_amount} — "
                "this override was not copied 1:1 from the native amount, out of scope for this repair"
            )

        planned.append(PlannedChange(
            transaction_id=tx_id, csv_source_row=csv_source_row, source_csv_sha256=source_sha,
            old_amount=old_amount, old_currency=old_currency, old_source=old_source,
            account_id=account_id, type=tx_type, date=tx_date, category_id=raw_category,
            native_amount=native_amount, native_currency=native_currency,
        ))
    return planned


@dataclass
class BatchResult:
    updated: list[int]
    already_applied: list[int]
    conflicts: list[tuple[int, str]]


def _identity_mismatch(row: Transaction, account: Account, plan: PlannedChange) -> str | None:
    """All checks below run under the same `SELECT ... FOR UPDATE` lock as
    the override-triple check — a concurrent change to any of these fields
    after the preview was frozen must abort the whole batch, whether or not
    the override itself still matches."""
    if row.account_id != plan.account_id:
        return f"account_id changed ({row.account_id} != {plan.account_id})"
    if row.type.value != plan.type:
        return f"type changed ({row.type.value} != {plan.type})"
    if row.date != plan.date:
        return f"date changed ({row.date} != {plan.date})"
    if row.category_id != plan.category_id:
        return f"category_id changed ({row.category_id} != {plan.category_id})"
    if account is None or account.currency != plan.native_currency:
        return f"account currency changed ({account and account.currency!r} != {plan.native_currency!r})"
    if row.amount is None or Decimal(row.amount) != plan.native_amount:
        return f"native amount changed ({row.amount!r} != {plan.native_amount})"
    return None


async def _run_locked_batch(session, planned: list[PlannedChange], *, apply: bool) -> BatchResult:
    ids = [p.transaction_id for p in planned]
    by_id = {p.transaction_id: p for p in planned}
    stmt = (
        select(Transaction)
        .where(Transaction.id.in_(ids))
        .options(selectinload(Transaction.account))
        .with_for_update()
    )
    rows = {row.id: row for row in (await session.scalars(stmt)).all()}

    # Lock the referenced accounts too (their `currency` is part of the
    # frozen identity proof) so a concurrent account-currency change can't
    # race between reading `row.account` above and the conflict check below.
    account_ids = {row.account_id for row in rows.values()}
    if account_ids:
        await session.execute(select(Account.id).where(Account.id.in_(account_ids)).with_for_update())

    updated: list[int] = []
    already_applied: list[int] = []
    conflicts: list[tuple[int, str]] = []

    missing = set(ids) - set(rows)
    for tx_id in sorted(missing):
        conflicts.append((tx_id, "transaction id not found in database"))

    for tx_id, plan in by_id.items():
        row = rows.get(tx_id)
        if row is None:
            continue
        if row.type.value not in REPAIRABLE_TYPES:
            conflicts.append((tx_id, f"type is {row.type.value}, not income/expense"))
            continue

        mismatch = _identity_mismatch(row, row.account, plan)
        if mismatch is not None:
            conflicts.append((tx_id, f"identity guard failed: {mismatch}"))
            continue

        already_null = (
            row.reporting_amount_override is None
            and row.reporting_currency_override is None
            and row.reporting_override_source is None
        )
        if already_null:
            # Identity guards above already re-proved this row still matches
            # the frozen preview even though there is nothing left to write.
            already_applied.append(tx_id)
            continue

        matches_expected_old = (
            row.reporting_amount_override is not None
            and Decimal(row.reporting_amount_override) == plan.old_amount
            and row.reporting_currency_override == plan.old_currency
            and row.reporting_override_source == plan.old_source
        )
        if not matches_expected_old:
            conflicts.append((
                tx_id,
                "live override does not match preview's recorded old value "
                f"(live={row.reporting_amount_override!r}/{row.reporting_currency_override!r}/"
                f"{row.reporting_override_source!r}, expected={plan.old_amount}/{plan.old_currency}/{plan.old_source})",
            ))
            continue
        updated.append(tx_id)

    if conflicts:
        # Any conflict aborts the whole batch — no partial commit, ever.
        return BatchResult(updated=[], already_applied=[], conflicts=conflicts)

    if apply:
        for tx_id in updated:
            row = rows[tx_id]
            row.reporting_amount_override = None
            row.reporting_currency_override = None
            row.reporting_override_source = None

    return BatchResult(updated=updated, already_applied=already_applied, conflicts=[])


def _write_journal(journal_path: Path, payload: dict) -> None:
    """Append one JSON line as a single write() syscall so a crash can only
    ever lose the whole line, never corrupt it mid-write. Not a substitute
    for the DB transaction's own atomicity — a missing journal entry after a
    successful commit is recoverable because a re-run's identity guards
    independently re-prove the same source/native identity before doing
    anything, rather than trusting the journal as the source of truth."""
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
    fd = os.open(journal_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    try:
        os.write(fd, line)
        os.fsync(fd)
    finally:
        os.close(fd)


async def run(preview_path: Path, *, source_sha256: str, apply: bool, journal_path: Path | None) -> BatchResult:
    planned = load_preview(preview_path, expected_source_sha256=source_sha256)
    async with AsyncSessionLocal() as session:
        async with session.begin():
            result = await _run_locked_batch(session, planned, apply=apply)
            if result.conflicts:
                await session.rollback()
            elif not apply:
                await session.rollback()
            # else: `session.begin()` context commits normally on exit.
    if journal_path is not None:
        _write_journal(journal_path, {
            "at": datetime.now().astimezone().isoformat(),
            "source_csv_sha256": source_sha256,
            "apply": apply,
            "updated": result.updated,
            "already_applied": result.already_applied,
            "conflicts": result.conflicts,
        })
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, required=True, help="Frozen private preview JSON path")
    parser.add_argument("--source-sha256", required=True,
                         help="Expected CSV source SHA256; every preview entry must match this exactly")
    parser.add_argument("--apply", action="store_true", help="Actually write; default is dry-run")
    parser.add_argument("--journal", type=Path, help="Private append-only journal path outside the repository")
    args = parser.parse_args()
    # `scripts/<this file>` -> parents[0] is the source tree's own top level
    # ("backend/" on a host checkout, "/app" inside the built image, since
    # the Dockerfile's build context *is* backend/ — see backend/Dockerfile).
    # Using that boundary (rather than one level further up, which would
    # resolve to the filesystem root inside the container and wrongly accept
    # every path there) works identically in both places this script runs.
    source_tree = Path(__file__).resolve().parents[1]
    if args.preview.resolve().is_relative_to(source_tree):
        parser.error("Preview must be a private path outside the application source tree")
    if args.journal is not None and args.journal.resolve().is_relative_to(source_tree):
        parser.error("Journal must be a private path outside the application source tree")
    if args.apply:
        print("About to WRITE to the database this script is configured against.")
        phrase = input("Type EXACTLY 'apply monefy reporting repair' to continue: ")
        if phrase != "apply monefy reporting repair":
            print("Confirmation phrase did not match; aborting without writing anything.")
            sys.exit(1)
    result = asyncio.run(run(args.preview, source_sha256=args.source_sha256, apply=args.apply,
                              journal_path=args.journal))
    print(json.dumps({
        "mode": "apply" if args.apply else "dry-run",
        "updated": len(result.updated),
        "already_applied": len(result.already_applied),
        "conflicts": len(result.conflicts),
        "conflict_detail": result.conflicts[:20],
    }, ensure_ascii=False, indent=2))
    if result.conflicts:
        sys.exit(2)


if __name__ == "__main__":
    main()
