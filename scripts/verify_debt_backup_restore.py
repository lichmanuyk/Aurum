"""Real, disposable-stand restore check for debt tracking's backup format
(see docs/tasks/debt-tracking.md) — entirely synthetic data, never the
personal iCloud backup, never aurum-personal or port 3003.

Proves three things end-to-end against a live, throwaway app instance (a
real HTTP restore, not just a dict comparison):

1. A genuine pre-debt-tracking (format 11, no `debts`/`debt_repayments`
   keys at all) backup still imports cleanly into the upgraded schema, with
   both new sections landing empty.
2. A current-format (12) backup carrying real debts — an opening-balance
   receivable fully repaid, and a new-loan liability partially repaid and
   then reversed (exercising the self-referential reverses_repayment_id
   ordering the restore path must sort, same as categories' own parent_id)
   — round-trips exactly through export -> import -> export again.
3. An invalid reference (a reversal whose amount doesn't mirror the
   repayment it claims to undo) is rejected atomically, leaving the
   database exactly as it was before the bad import.

Mirrors scripts/verify_property_expense_backup_restore.py's own disposable-
project pattern.
"""
import json
import os
import secrets
import socket
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]


def build_legacy_payload() -> dict:
    """A hand-built, synthetic format-11 backup — no `debts`/
    `debt_repayments` keys at all (they did not exist yet in format 11)."""
    now = datetime.now(timezone.utc).isoformat()
    return {
        "fx_rates": [], "aurum_backup_version": 11, "exported_at": now, "app_version": "0.0.0-synthetic",
        "accounts": [{"id": 1, "name": "Synthetic checking", "type": "checking", "currency": "USD",
                      "color": None, "is_archived": False}],
        "categories": [{"id": 1, "name": "Synthetic Salary", "kind": "income", "icon": None, "color": "#2a78d6",
                        "sort_order": 0, "is_default": False, "parent_id": None}],
        "tags": [],
        "transactions": [{"id": 1, "account_id": 1, "category_id": 1, "transfer_account_id": None, "type": "income",
                          "amount": "500.00", "description": "Synthetic legacy income", "merchant": None,
                          "notes": None, "date": "2025-01-01", "tag_ids": []}],
        "transaction_splits": [], "assets": [], "asset_valuations": [],
        "crypto_portfolios": [], "crypto_holdings": [], "crypto_transactions": [],
        "budgets": [], "goals": [], "goal_contributions": [], "recurring_transactions": [],
        "app_settings": {"currency": "USD", "negative_cash_flow_threshold_months": 2,
                          "net_worth_decline_threshold_months": 2, "risky_allocation_threshold_percent": 20,
                          "idle_cash_threshold_amount": "1000", "idle_cash_threshold_days": 60,
                          "idle_cash_threshold_currency": "USD"},
    }


def build_debt_payload() -> dict:
    """A hand-built, synthetic format-12 backup with two real debts:
    - Debt 1 (id=1): opening-balance receivable (owed_to_me), no issuance
      transaction, fully repaid by one DEBT_IN transaction (id=2).
    - Debt 2 (id=2): new-loan liability (owed_by_me) — issuance transaction
      (id=3, DEBT_IN — borrowing money in), a partial repayment (DEBT_OUT,
      id=4) that is then reversed (DEBT_IN, id=5), exercising the
      self-referential reverses_repayment_id ordering the restore path
      must sort before inserting (repayment id=2 before reversal id=3 in
      debt_repayments)."""
    now = datetime.now(timezone.utc).isoformat()
    return {
        "fx_rates": [], "aurum_backup_version": 12, "exported_at": now, "app_version": "0.0.0-synthetic",
        "accounts": [{"id": 1, "name": "Synthetic debt checking", "type": "checking", "currency": "USD",
                      "color": None, "is_archived": False}],
        "categories": [], "tags": [],
        "transactions": [
            {"id": 2, "account_id": 1, "category_id": None, "transfer_account_id": None, "type": "debt_in",
             "amount": "100.00", "description": "Repayment: Synthetic friend", "merchant": None, "notes": None,
             "date": "2025-02-01", "tag_ids": []},
            {"id": 3, "account_id": 1, "category_id": None, "transfer_account_id": None, "type": "debt_in",
             "amount": "300.00", "description": "Loan from Synthetic bank", "merchant": None, "notes": None,
             "date": "2025-01-01", "tag_ids": []},
            {"id": 4, "account_id": 1, "category_id": None, "transfer_account_id": None, "type": "debt_out",
             "amount": "50.00", "description": "Repayment: Synthetic bank", "merchant": None, "notes": None,
             "date": "2025-02-10", "tag_ids": []},
            {"id": 5, "account_id": 1, "category_id": None, "transfer_account_id": None, "type": "debt_in",
             "amount": "50.00", "description": "Reversal of repayment: Synthetic bank", "merchant": None,
             "notes": None, "date": "2025-02-15", "tag_ids": []},
        ],
        "transaction_splits": [], "assets": [], "asset_valuations": [],
        "crypto_portfolios": [], "crypto_holdings": [], "crypto_transactions": [],
        "budgets": [], "goals": [], "goal_contributions": [], "recurring_transactions": [],
        "debts": [
            {"id": 1, "direction": "owed_to_me", "counterparty": "Synthetic friend", "currency": "USD",
             "principal_amount": "100.00", "start_date": "2025-01-15", "due_date": None, "note": None,
             "issuance_transaction_id": None, "idempotency_key": None},
            {"id": 2, "direction": "owed_by_me", "counterparty": "Synthetic bank", "currency": "USD",
             "principal_amount": "300.00", "start_date": "2025-01-01", "due_date": "2026-01-01", "note": None,
             "issuance_transaction_id": 3, "idempotency_key": None},
        ],
        "debt_repayments": [
            {"id": 1, "debt_id": 1, "transaction_id": 2, "kind": "repayment", "reverses_repayment_id": None,
             "amount_debt_currency": "100.00", "note": None, "idempotency_key": None},
            {"id": 2, "debt_id": 2, "transaction_id": 4, "kind": "repayment", "reverses_repayment_id": None,
             "amount_debt_currency": "50.00", "note": None, "idempotency_key": None},
            {"id": 3, "debt_id": 2, "transaction_id": 5, "kind": "reversal", "reverses_repayment_id": 2,
             "amount_debt_currency": "50.00", "note": None, "idempotency_key": None},
        ],
        "app_settings": {"currency": "USD", "negative_cash_flow_threshold_months": 2,
                          "net_worth_decline_threshold_months": 2, "risky_allocation_threshold_percent": 20,
                          "idle_cash_threshold_amount": "1000", "idle_cash_threshold_days": 60,
                          "idle_cash_threshold_currency": "USD"},
    }


def http(url, body=None, method=None):
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    req = Request(url, data=body, headers=headers, method=method)
    try:
        with urlopen(req, timeout=120) as response:
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def main():
    project = 'aurum-verify-debt-' + secrets.token_hex(6)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    env.update(AURUM_POSTGRES_USER='aurum_verify_debt', AURUM_POSTGRES_PASSWORD=secrets.token_urlsafe(32),
               AURUM_POSTGRES_DB='aurum_verify_debt', AURUM_WEB_PORT=str(port), AURUM_BIND_ADDRESS='127.0.0.1',
               AURUM_BASIC_AUTH_USER='', AURUM_BASIC_AUTH_PASSWORD='', AURUM_COINGECKO_API_KEY='',
               AURUM_ALLOWED_HOSTS='localhost 127.0.0.1', AURUM_DEFAULT_CURRENCY='USD')
    command = ['docker', 'compose', '--env-file', '/dev/null', '-p', project]

    def compose(*args):
        subprocess.run([*command, *args], cwd=ROOT, env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    try:
        compose('up', '-d', '--build', '--wait', '--wait-timeout', '180')
        base = f'http://127.0.0.1:{port}/api'
        for _ in range(60):
            status, _ = http(base + '/health')
            if status == 200:
                break
            time.sleep(2)
        else:
            raise RuntimeError('Disposable verify app did not become healthy')

        # 1) A genuine pre-debt-tracking (format 11) backup restores
        # cleanly, with both new sections landing empty.
        legacy = build_legacy_payload()
        status, body = http(base + '/backup/import', json.dumps(legacy).encode(), method='POST')
        if status != 200:
            raise RuntimeError(f'Legacy import failed: {status} {body[:500]!r}')
        status, body = http(base + '/backup/export')
        exported = json.loads(body)
        if exported['aurum_backup_version'] != 12:
            raise RuntimeError('Re-export did not upgrade to the current format version')
        if exported['debts'] != [] or exported['debt_repayments'] != []:
            raise RuntimeError('Legacy restore unexpectedly landed with debts')

        # 2) A current-format backup with real debts (opening + new loan,
        # partial repayment + reversal) round-trips exactly.
        debt_payload = build_debt_payload()
        status, body = http(base + '/backup/import', json.dumps(debt_payload).encode(), method='POST')
        if status != 200:
            raise RuntimeError(f'Debt payload import failed: {status} {body[:500]!r}')
        status, body = http(base + '/backup/export')
        with_debts = json.loads(body)
        status, body = http(base + '/backup/import', json.dumps(with_debts).encode(), method='POST')
        if status != 200:
            raise RuntimeError(f'Debt roundtrip import failed: {status} {body[:500]!r}')
        status, body = http(base + '/backup/export')
        reexported = json.loads(body)
        restored = {k: v for k, v in reexported.items() if k != 'exported_at'}
        original = {k: v for k, v in with_debts.items() if k != 'exported_at'}
        if original != restored:
            raise RuntimeError('Debt roundtrip differs after restore')
        if len(restored['debts']) != 2 or len(restored['debt_repayments']) != 3:
            raise RuntimeError('Debt roundtrip lost rows')

        # 3) An invalid reference (a reversal whose amount doesn't mirror
        # the repayment it claims to undo) is rejected atomically.
        corrupt = json.loads(json.dumps(with_debts))
        corrupt['debt_repayments'][2]['amount_debt_currency'] = '999.00'
        status, _ = http(base + '/backup/import', json.dumps(corrupt).encode(), method='POST')
        if status == 200:
            raise RuntimeError('Invalid reversal amount was not rejected')
        status, body = http(base + '/backup/export')
        after_failed_import = json.loads(body)
        if {k: v for k, v in after_failed_import.items() if k != 'exported_at'} != restored:
            raise RuntimeError('A rejected import left the database partially modified')

        print(json.dumps({'status': 'ok', 'project': project,
                          'debts': len(with_debts['debts']), 'debt_repayments': len(with_debts['debt_repayments'])}))
    finally:
        compose('down', '-v', '--remove-orphans')


if __name__ == '__main__':
    main()
