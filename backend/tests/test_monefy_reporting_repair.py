"""Synthetic-only tests for the guarded Monefy override repair CLI.

No real financial data: every fixture below is invented. See
docs/tasks/monefy-reporting-repair.md.
"""
import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from app.models.account import Account
from app.models.enums import TransactionType
from app.models.transaction import Transaction
from scripts.monefy_reporting_repair import PreviewError, _run_locked_batch, load_preview

SHA = "a" * 64
OTHER_SHA = "b" * 64


def _preview(*changes: dict) -> dict:
    return {"fields_changed": ["reporting_amount_override", "reporting_currency_override",
                                "reporting_override_source"], "changes": list(changes)}


def _identity(account_id=1, tx_type="expense", tx_date="2024-01-01", category_id=None,
              native_amount="10.000000", native_currency="BYN"):
    return {"account_id": account_id, "type": tx_type, "date": tx_date, "category_id": category_id,
            "native_amount": native_amount, "native_currency": native_currency}


def _change(tx_id, *, csv_row=1, sha=SHA, amount="10.000000", currency="PLN", source="monefy",
            identity=None, proposed=None):
    return {
        "transaction_id": tx_id, "csv_source_row": csv_row, "source_csv_sha256": sha,
        "identity": identity or _identity(),
        "current": {"reporting_amount_override": amount, "reporting_currency_override": currency,
                    "reporting_override_source": source},
        "proposed": proposed if proposed is not None else {
            "reporting_amount_override": None, "reporting_currency_override": None,
            "reporting_override_source": None},
    }


def _write(tmp_path: Path, payload: dict) -> Path:
    path = tmp_path / "preview.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _load(tmp_path, payload, sha=SHA):
    return load_preview(_write(tmp_path, payload), expected_source_sha256=sha)


# --- load_preview: malformed / duplicate / ambiguous / non-identity rejection ---

def test_rejects_missing_changes_list(tmp_path):
    with pytest.raises(PreviewError):
        _load(tmp_path, {"fields_changed": list(_preview()["fields_changed"])})


def test_rejects_wrong_fields_changed_declaration(tmp_path):
    payload = _preview(_change(1))
    payload["fields_changed"] = ["reporting_amount_override"]
    with pytest.raises(PreviewError):
        _load(tmp_path, payload)


def test_rejects_duplicate_transaction_id(tmp_path):
    with pytest.raises(PreviewError, match="duplicate"):
        _load(tmp_path, _preview(_change(1), _change(1)))


def test_rejects_non_null_proposed_value(tmp_path):
    change = _change(1)
    change["proposed"]["reporting_amount_override"] = "1.00"
    with pytest.raises(PreviewError, match="all-null"):
        _load(tmp_path, _preview(change))


def test_rejects_proposed_missing_a_required_key(tmp_path):
    change = _change(1, proposed={"reporting_amount_override": None, "reporting_currency_override": None})
    with pytest.raises(PreviewError, match="exactly the three override keys"):
        _load(tmp_path, _preview(change))


def test_rejects_manual_source_in_preview(tmp_path):
    with pytest.raises(PreviewError, match="manual"):
        _load(tmp_path, _preview(_change(1, source="manual")))


def test_rejects_non_positive_current_amount(tmp_path):
    with pytest.raises(PreviewError):
        _load(tmp_path, _preview(_change(1, amount="0")))


def test_rejects_infinite_current_amount(tmp_path):
    with pytest.raises(PreviewError):
        _load(tmp_path, _preview(_change(1, amount="Infinity")))


def test_rejects_bool_as_transaction_id(tmp_path):
    change = _change(1)
    change["transaction_id"] = True
    with pytest.raises(PreviewError, match="positive int"):
        _load(tmp_path, _preview(change))


def test_rejects_unsupported_currency_code(tmp_path):
    with pytest.raises(PreviewError):
        _load(tmp_path, _preview(_change(1, currency="XXX")))


def test_rejects_source_sha256_mismatch_with_cli_argument(tmp_path):
    with pytest.raises(PreviewError, match="does not match"):
        _load(tmp_path, _preview(_change(1)), sha=OTHER_SHA)


def test_rejects_malformed_source_sha256_shape(tmp_path):
    with pytest.raises(PreviewError, match="64-hex"):
        _load(tmp_path, _preview(_change(1, sha="not-a-hash")))


def test_rejects_same_currency_override_out_of_scope(tmp_path):
    """A genuinely same-currency override (native==reporting currency) is
    never the audited 1:1-artifact defect — the identity proof must reject
    it even if someone hand-crafts such an entry."""
    identity = _identity(native_currency="PLN")
    with pytest.raises(PreviewError, match="not a cross-currency 1:1 artifact"):
        _load(tmp_path, _preview(_change(1, currency="PLN", identity=identity)))


def test_rejects_nonidentity_override_out_of_scope(tmp_path):
    """A genuine (non-1:1) cross-currency override — native amount differs
    from the override amount — is a *correct* Monefy conversion, never in
    scope for this repair."""
    identity = _identity(native_amount="10.000000", native_currency="BYN")
    with pytest.raises(PreviewError, match="not copied 1:1"):
        _load(tmp_path, _preview(_change(1, amount="17.500000", currency="PLN", identity=identity)))


def test_accepts_well_formed_preview(tmp_path):
    second = _change(2, csv_row=2, amount="5.5", identity=_identity(native_amount="5.5"))
    planned = _load(tmp_path, _preview(_change(1), second))
    assert [p.transaction_id for p in planned] == [1, 2]


# --- _run_locked_batch: DB-level conflict/atomicity/idempotency behaviour ---

async def _seed_account(session, currency="BYN") -> int:
    account = Account(name="Synthetic", type="checking", currency=currency)
    session.add(account)
    await session.flush()
    return account.id


async def _seed_transaction(session, account_id, **overrides) -> Transaction:
    tx = Transaction(account_id=account_id, type=TransactionType.EXPENSE, amount=Decimal("10.000000"),
                      description="Synthetic", date=date(2024, 1, 1),
                      reporting_amount_override=Decimal("10.000000"), reporting_currency_override="PLN",
                      reporting_override_source="monefy")
    for key, value in overrides.items():
        setattr(tx, key, value)
    session.add(tx)
    await session.flush()
    return tx


def _plan_for(tx_id, account_id, **identity_overrides):
    identity = _identity(account_id=account_id, native_amount="10.000000", native_currency="BYN")
    identity.update(identity_overrides)
    return _change(tx_id, identity=identity)


async def test_matching_row_is_updated_when_apply_true(test_sessionmaker):
    async with test_sessionmaker() as session:
        account_id = await _seed_account(session)
        tx = await _seed_transaction(session, account_id)
        await session.commit()
        tx_id = tx.id
        planned = load_preview_from_dict(_preview(_plan_for(tx_id, account_id)))
        result = await _run_locked_batch(session, planned, apply=True)
        await session.commit()
        assert result.updated == [tx_id]
        assert result.conflicts == []
        refreshed = await session.get(Transaction, tx_id)
        assert refreshed.reporting_amount_override is None
        assert refreshed.reporting_currency_override is None
        assert refreshed.reporting_override_source is None
        # Untouched fields:
        assert refreshed.amount == Decimal("10.000000")
        assert refreshed.description == "Synthetic"


async def test_dry_run_reports_without_writing(test_sessionmaker):
    async with test_sessionmaker() as session:
        account_id = await _seed_account(session)
        tx = await _seed_transaction(session, account_id)
        await session.commit()
        tx_id = tx.id  # captured before rollback expires the ORM object
        planned = load_preview_from_dict(_preview(_plan_for(tx_id, account_id)))
        result = await _run_locked_batch(session, planned, apply=False)
        await session.rollback()
        assert result.updated == [tx_id]
    async with test_sessionmaker() as verify_session:
        refreshed = await verify_session.get(Transaction, tx_id)
        assert refreshed.reporting_amount_override == Decimal("10.000000")


async def test_conflicting_override_value_rolls_back_entire_batch(test_sessionmaker):
    async with test_sessionmaker() as session:
        account_id = await _seed_account(session)
        good = await _seed_transaction(session, account_id)
        conflicting = await _seed_transaction(session, account_id, reporting_amount_override=Decimal("999.000000"))
        await session.commit()
        good_id, conflicting_id = good.id, conflicting.id
        planned = load_preview_from_dict(_preview(
            _plan_for(good_id, account_id), _plan_for(conflicting_id, account_id)))
        result = await _run_locked_batch(session, planned, apply=True)
        await session.rollback()
        assert result.updated == []
        assert result.already_applied == []
        assert any(conflicting_id == tx_id for tx_id, _ in result.conflicts)
    async with test_sessionmaker() as verify_session:
        # Neither row changed — not even the one with a matching preview entry.
        refreshed_good = await verify_session.get(Transaction, good_id)
        assert refreshed_good.reporting_amount_override == Decimal("10.000000")


async def test_concurrent_native_amount_change_on_one_row_rolls_back_whole_batch(test_sessionmaker):
    """Reproduces the exact scenario Codex flagged: only the *second* row's
    native amount (and thus its identity proof) has drifted from the frozen
    preview since the audit, while its override triple is untouched. The
    first, still-valid row must NOT be updated either — one bad identity
    anywhere aborts the entire pass."""
    async with test_sessionmaker() as session:
        account_id = await _seed_account(session)
        first = await _seed_transaction(session, account_id)
        drifted = await _seed_transaction(session, account_id, amount=Decimal("999.000000"))
        await session.commit()
        first_id, drifted_id = first.id, drifted.id
        planned = load_preview_from_dict(_preview(
            _plan_for(first_id, account_id), _plan_for(drifted_id, account_id)))
        result = await _run_locked_batch(session, planned, apply=True)
        await session.rollback()
        assert result.updated == []
        assert result.already_applied == []
        assert any(drifted_id == tx_id and "native amount changed" in reason for tx_id, reason in result.conflicts)
    async with test_sessionmaker() as verify_session:
        refreshed_first = await verify_session.get(Transaction, first_id)
        assert refreshed_first.reporting_amount_override == Decimal("10.000000")  # untouched


async def test_concurrent_account_move_is_a_conflict(test_sessionmaker):
    async with test_sessionmaker() as session:
        account_id = await _seed_account(session)
        other_account_id = await _seed_account(session)
        tx = await _seed_transaction(session, account_id)
        await session.commit()
        tx_id = tx.id
        # Preview was frozen against `other_account_id`, but the live row is on `account_id`.
        planned = load_preview_from_dict(_preview(_plan_for(tx_id, other_account_id)))
        result = await _run_locked_batch(session, planned, apply=True)
        await session.rollback()
        assert result.updated == []
        assert any("account_id changed" in reason for _, reason in result.conflicts)


async def test_concurrent_account_currency_change_is_a_conflict(test_sessionmaker):
    async with test_sessionmaker() as session:
        account_id = await _seed_account(session, currency="BYN")
        tx = await _seed_transaction(session, account_id)
        await session.commit()
        tx_id = tx.id
        async with test_sessionmaker() as mutate_session:
            account = await mutate_session.get(Account, account_id)
            account.currency = "USD"
            await mutate_session.commit()
        planned = load_preview_from_dict(_preview(_plan_for(tx_id, account_id, native_currency="BYN")))
        result = await _run_locked_batch(session, planned, apply=True)
        await session.rollback()
        assert result.updated == []
        assert any("account currency changed" in reason for _, reason in result.conflicts)


async def test_already_null_row_requires_identity_guards_too(test_sessionmaker):
    """An already-repaired row (override triple already null) is normally a
    silent no-op for idempotency — but if its native amount has since
    drifted from the frozen preview, that must still be a conflict, not a
    silently accepted no-op."""
    async with test_sessionmaker() as session:
        account_id = await _seed_account(session)
        tx = await _seed_transaction(session, account_id, reporting_amount_override=None,
                                      reporting_currency_override=None, reporting_override_source=None,
                                      amount=Decimal("777.000000"))
        await session.commit()
        tx_id = tx.id
        planned = load_preview_from_dict(_preview(_plan_for(tx_id, account_id)))  # frozen native_amount=10.000000
        result = await _run_locked_batch(session, planned, apply=True)
        await session.rollback()
        assert result.updated == []
        assert result.already_applied == []
        assert any("native amount changed" in reason for _, reason in result.conflicts)


async def test_already_null_row_with_matching_identity_is_idempotent_no_op(test_sessionmaker):
    async with test_sessionmaker() as session:
        account_id = await _seed_account(session)
        tx = await _seed_transaction(session, account_id, reporting_amount_override=None,
                                      reporting_currency_override=None, reporting_override_source=None)
        await session.commit()
        tx_id = tx.id
        planned = load_preview_from_dict(_preview(_plan_for(tx_id, account_id)))
        result = await _run_locked_batch(session, planned, apply=True)
        await session.commit()
        assert result.updated == []
        assert result.already_applied == [tx_id]
        assert result.conflicts == []


async def test_transfer_type_is_always_a_conflict_even_if_identity_matches(test_sessionmaker):
    async with test_sessionmaker() as session:
        account_id = await _seed_account(session)
        destination = await _seed_account(session)
        tx = Transaction(account_id=account_id, transfer_account_id=destination, type=TransactionType.TRANSFER,
                          amount=Decimal("10.000000"), destination_amount=Decimal("10.000000"),
                          description="Synthetic transfer", date=date(2024, 1, 1))
        session.add(tx)
        await session.flush()
        await session.commit()
        tx_id = tx.id
        planned = load_preview_from_dict(_preview(_plan_for(tx_id, account_id, **{"type": "expense"})))
        result = await _run_locked_batch(session, planned, apply=True)
        await session.rollback()
        assert result.updated == []
        assert any("transfer" in reason for _, reason in result.conflicts)


async def test_missing_transaction_id_is_a_conflict(test_sessionmaker):
    async with test_sessionmaker() as session:
        planned = load_preview_from_dict(_preview(_plan_for(999999, 1)))
        result = await _run_locked_batch(session, planned, apply=True)
        await session.rollback()
        assert result.updated == []
        assert any(999999 == tx_id for tx_id, _ in result.conflicts)


# --- Backup roundtrip for the repaired (all-null) override shape ---

async def test_all_null_override_triple_roundtrips_through_backup(client, test_sessionmaker):
    """After a repair, the resulting all-null override triple (the normal
    state for any non-Monefy transaction) must survive a full backup
    export/import roundtrip exactly like any other transaction's overrides
    already do — this is not new behaviour, just confirming the repair's
    output shape isn't special-cased anywhere in backup_service."""
    accounts = (await client.get("/accounts")).json()
    account_id = accounts[0]["id"]
    categories = (await client.get("/categories")).json()
    category_id = categories[0]["id"]
    created = await client.post("/transactions", json={
        "account_id": account_id, "category_id": category_id, "type": "expense",
        "amount": "42.000000", "description": "Repaired synthetic row", "date": "2024-01-01",
    })
    assert created.status_code == 201, created.text
    tx_id = created.json()["id"]

    async with test_sessionmaker() as session:
        row = await session.get(Transaction, tx_id)
        assert row.reporting_amount_override is None  # already the repaired shape

    exported = await client.get("/backup/export")
    assert exported.status_code == 200
    payload = exported.json()
    exported_tx = next(t for t in payload["transactions"] if t["id"] == tx_id)
    assert exported_tx["reporting_amount_override"] is None
    assert exported_tx["reporting_currency_override"] is None
    assert exported_tx["reporting_override_source"] is None

    reimported = await client.post("/backup/import", json=payload)
    assert reimported.status_code == 200, reimported.text
    listed = (await client.get("/transactions", params={"page": 1, "page_size": 50})).json()
    after = next(t for t in listed["items"] if t["id"] == tx_id)
    assert after["reporting_amount_override"] is None
    assert after["reporting_currency_override"] is None
    assert after["reporting_override_source"] is None
    assert after["amount"] == "42.000000"
    assert after["description"] == "Repaired synthetic row"


def load_preview_from_dict(payload: dict, sha: str = SHA):
    """Mirrors load_preview's validation without a temp file, for the
    DB-level tests above where only the parsed PlannedChange list matters."""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(payload, handle)
        handle.flush()
        return load_preview(Path(handle.name), expected_source_sha256=sha)
