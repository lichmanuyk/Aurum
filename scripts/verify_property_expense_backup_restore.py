"""Real, disposable-stand restore check for the property-expense-links
migration (see docs/tasks/property-expense-links.md) — entirely synthetic
data, never the personal iCloud backup, never aurum-personal or port 3003.

Proves two things end-to-end against a live, throwaway app instance (a
real HTTP restore, not just a dict comparison — see
docs/agent-workflow.md's "restore test, not just comparison" requirement):

1. A genuine pre-migration (format 9, no expense_asset_id anywhere) backup
   still imports cleanly into the upgraded schema, with every new link
   column landing NULL rather than some default that could be mistaken for
   a real link.
2. A current-format (10) backup carrying real transaction/split/recurring
   links round-trips exactly through export -> import -> export again, and
   an invalid link reference is rejected atomically, leaving the database
   exactly as it was before the bad import.

Mirrors scripts/check_backup_restore.py's disposable-project pattern
(unique compose project name, random free port, `down -v` in `finally`),
but builds its own synthetic input instead of reading a real iCloud file —
safe to run anywhere (CI, a laptop) without touching any personal data.
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
    """A hand-built, synthetic format-9 backup — the exact shape a real
    pre-task export has: accounts/categories/transactions/
    transaction_splits/recurring_transactions/assets/asset_valuations/
    app_settings, and no `expense_asset_id` key anywhere (that field did
    not exist yet in format 9)."""
    now = datetime.now(timezone.utc).isoformat()
    return {
        "fx_rates": [],
        "aurum_backup_version": 9,
        "exported_at": now,
        "app_version": "0.0.0-synthetic",
        "accounts": [
            {"id": 1, "name": "Synthetic checking", "type": "checking", "currency": "USD",
             "color": None, "is_archived": False},
        ],
        "categories": [
            {"id": 1, "name": "Synthetic Housing", "kind": "expense", "icon": None, "color": "#2a78d6",
             "sort_order": 0, "is_default": False, "parent_id": None},
            {"id": 2, "name": "Synthetic Sweets", "kind": "expense", "icon": None, "color": "#2a78d6",
             "sort_order": 1, "is_default": False, "parent_id": 1},
        ],
        "tags": [],
        "transactions": [
            {"id": 1, "account_id": 1, "category_id": 1, "transfer_account_id": None, "type": "expense",
             "amount": "100.00", "description": "Synthetic legacy expense", "merchant": None, "notes": None,
             "date": "2025-01-01", "tag_ids": []},
            {"id": 2, "account_id": 1, "category_id": None, "transfer_account_id": None, "type": "expense",
             "amount": "70.00", "description": "Synthetic legacy split purchase", "merchant": None, "notes": None,
             "date": "2025-02-01", "tag_ids": []},
        ],
        "transaction_splits": [
            {"id": 1, "transaction_id": 2, "category_id": 1, "amount": "40.00", "note": None},
            {"id": 2, "transaction_id": 2, "category_id": 2, "amount": "30.00", "note": None},
        ],
        "assets": [
            {"id": 1, "name": "Synthetic legacy apartment", "asset_class": "real_estate", "currency": "USD",
             "notes": None, "capital_role": "neutral", "monthly_cash_flow": None, "risk_level": "medium"},
        ],
        "asset_valuations": [
            {"id": 1, "asset_id": 1, "value": "100000.00", "as_of_date": "2025-01-01"},
        ],
        "crypto_portfolios": [], "crypto_holdings": [], "crypto_transactions": [],
        "budgets": [], "goals": [], "goal_contributions": [],
        "recurring_transactions": [
            {"id": 1, "account_id": 1, "category_id": 1, "transfer_account_id": None, "type": "expense",
             "amount": "10.00", "description": "Synthetic legacy template", "merchant": None, "notes": None,
             "frequency": "monthly", "anchor_date": "2025-01-01", "last_posted_date": None, "is_active": True},
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
    project = 'aurum-verify-' + secrets.token_hex(6)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    env.update(AURUM_POSTGRES_USER='aurum_verify', AURUM_POSTGRES_PASSWORD=secrets.token_urlsafe(32),
               AURUM_POSTGRES_DB='aurum_verify', AURUM_WEB_PORT=str(port), AURUM_BIND_ADDRESS='127.0.0.1',
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

        # 1) A genuine pre-migration (format 9) backup restores cleanly,
        # with every new link column landing NULL.
        legacy = build_legacy_payload()
        status, body = http(base + '/backup/import', json.dumps(legacy).encode(), method='POST')
        if status != 200:
            raise RuntimeError(f'Legacy import failed: {status} {body[:500]!r}')
        status, body = http(base + '/backup/export')
        exported = json.loads(body)
        if exported['aurum_backup_version'] != 12:
            raise RuntimeError('Re-export did not upgrade to the current format version')
        tx_by_id = {t['id']: t for t in exported['transactions']}
        if tx_by_id[1]['expense_asset_id'] is not None:
            raise RuntimeError('Legacy transaction unexpectedly landed with a link')
        if any(s['expense_asset_id'] is not None for s in exported['transaction_splits']):
            raise RuntimeError('Legacy split unexpectedly landed with a link')
        recurring_by_id = {r['id']: r for r in exported['recurring_transactions']}
        if recurring_by_id[1]['expense_asset_id'] is not None:
            raise RuntimeError('Legacy template unexpectedly landed with a link')

        # 2) A current-format backup with a real link round-trips exactly.
        asset_id = exported['assets'][0]['id']
        status, body = http(base + f'/transactions/{tx_by_id[1]["id"]}',
                            json.dumps({'expense_asset_id': asset_id}).encode(), method='PATCH')
        if status != 200:
            raise RuntimeError(f'Linking the legacy transaction failed: {status} {body[:500]!r}')
        status, body = http(base + '/backup/export')
        with_link = json.loads(body)
        status, body = http(base + '/backup/import', json.dumps(with_link).encode(), method='POST')
        if status != 200:
            raise RuntimeError(f'Current-format roundtrip import failed: {status} {body[:500]!r}')
        status, body = http(base + '/backup/export')
        reexported = json.loads(body)
        restored = {k: v for k, v in reexported.items() if k != 'exported_at'}
        original = {k: v for k, v in with_link.items() if k != 'exported_at'}
        if original != restored:
            raise RuntimeError('Current-format roundtrip differs after restore')

        # 3) An invalid link reference (unknown asset id) is rejected
        # atomically — the database must stay exactly as it was.
        corrupt = json.loads(json.dumps(with_link))
        corrupt['transactions'][0]['expense_asset_id'] = 999999
        status, _ = http(base + '/backup/import', json.dumps(corrupt).encode(), method='POST')
        if status == 200:
            raise RuntimeError('Invalid expense_asset_id reference was not rejected')
        status, body = http(base + '/backup/export')
        after_failed_import = json.loads(body)
        if {k: v for k, v in after_failed_import.items() if k != 'exported_at'} != restored:
            raise RuntimeError('A rejected import left the database partially modified')

        print(json.dumps({'status': 'ok', 'project': project,
                          'legacy_transactions': len(legacy['transactions']),
                          'linked_transaction_id': tx_by_id[1]['id']}))
    finally:
        compose('down', '-v', '--remove-orphans')


if __name__ == '__main__':
    main()
