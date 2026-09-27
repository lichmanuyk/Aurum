"""Restore the newest iCloud backup into a disposable Docker project and compare it."""
import hashlib
import json
import os
import re
import secrets
import socket
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
BACKUPS = Path.home() / 'Library/Mobile Documents/com~apple~CloudDocs/Aurum Backups'
NAME = re.compile(r'aurum-auto-(\d{8}T\d{12}Z)\.json')

# Every top-level *list* section of a backup payload — compared order-
# insensitively below (see _canonical_multiset): a plain `select()` with no
# ORDER BY makes no ordering guarantee, so two exports of the exact same
# rows can legitimately come back in a different physical order with
# nothing actually different (backup_service.py's build_backup now orders
# every one of these explicitly, but an *older* file predates that fix and
# a straight list `!=` would still report a false mismatch against it
# purely from that). `app_settings` is a single dict, not a list, and
# stays a plain equality check below, same as before.
LIST_SECTIONS = (
    'accounts', 'categories', 'tags', 'transactions', 'transaction_splits', 'assets',
    'asset_valuations', 'crypto_portfolios', 'crypto_holdings', 'crypto_transactions',
    'budgets', 'goals', 'goal_contributions', 'recurring_transactions', 'fx_rates',
)


def _canonical_row(row):
    """One row's own full, JSON-comparable content — every field's real
    value is kept (including a nullable one like expense_asset_id), so a
    genuine per-field change is never hidden by this. `tag_ids` (a many-to-
    many set whose own order was never a recorded fact — see
    backup_service.py's build_backup) is sorted the same way on both sides
    here, so an older file's own unsorted tag_ids never registers as a
    difference purely from that; a real duplicate or missing tag id is
    untouched by sorting and still changes the result."""
    if isinstance(row, dict) and isinstance(row.get('tag_ids'), list):
        row = {**row, 'tag_ids': sorted(row['tag_ids'])}
    return json.dumps(row, sort_keys=True, default=str)


def _canonical_multiset(rows):
    """Order-independent, but never collapses a real difference: turning
    this into a set or a dict keyed by id would silently hide a duplicated
    or an extra/missing row (two entries sharing one id, or a genuinely
    different total count). Sorting the *list* of each row's own full
    canonical string instead keeps every entry (including duplicates) and
    still puts two exports of the same rows in the same order regardless of
    how the database happened to return them — a real cardinality or
    per-field content change is still exactly what makes the two sorted
    lists compare unequal."""
    return sorted(_canonical_row(row) for row in rows)


def latest_backup(now=None):
    now = now or datetime.now(timezone.utc)
    candidates = []
    for path in BACKUPS.glob('aurum-auto-*.json'):
        match = NAME.fullmatch(path.name)
        if match and not path.is_symlink():
            candidates.append((datetime.strptime(match[1], '%Y%m%dT%H%M%S%fZ').replace(tzinfo=timezone.utc), path))
    if not candidates:
        raise RuntimeError('No automatic iCloud backup found')
    created, path = max(candidates)
    if created > now + timedelta(minutes=5) or now - created > timedelta(days=2):
        raise RuntimeError('Latest automatic iCloud backup is not fresh')
    raw = path.read_bytes()
    expected = path.with_suffix('.sha256').read_text().split()[0]
    if not re.fullmatch(r'[0-9a-f]{64}', expected) or hashlib.sha256(raw).hexdigest() != expected:
        raise RuntimeError('Backup checksum mismatch')
    data = json.loads(raw)
    if data.get('aurum_backup_version') not in (5, 6, 7, 8, 9, 10, 11) or not data.get('accounts') or not data.get('transactions'):
        raise RuntimeError('Backup format or financial history is unexpected')
    return path, raw, data


def request(url, body=None):
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    try:
        with urlopen(Request(url, data=body, headers=headers), timeout=300) as response:
            return response.read()
    except HTTPError as error:
        raise RuntimeError(f'Restore test API returned HTTP {error.code}') from None


def compare(original, restored):
    if original.get('aurum_backup_version', 0) < 7:
        for row in original.get('goal_contributions', []):
            row.setdefault('account_id', None)
    if original.get('aurum_backup_version', 0) < 8 and isinstance(original.get('app_settings'), dict):
        for field in ('summary_currency', 'dashboard_currency', 'net_worth_currency', 'crypto_currency'):
            original['app_settings'].setdefault(field, None)
    if original.get('aurum_backup_version', 0) < 9 and isinstance(original.get('app_settings'), dict):
        for field in ('cash_flow_currency', 'reports_currency'):
            original['app_settings'].setdefault(field, None)
    if original.get('aurum_backup_version', 0) < 10:
        # Format 10 added the optional expense_asset_id link (see
        # docs/tasks/property-expense-links.md) to three sections — an
        # older backup has none of them at all, and restoring it must not
        # report a false mismatch just because the re-export now carries
        # them defaulted to null.
        for row in original.get('transactions', []):
            row.setdefault('expense_asset_id', None)
        for row in original.get('transaction_splits', []):
            row.setdefault('expense_asset_id', None)
        for row in original.get('recurring_transactions', []):
            row.setdefault('expense_asset_id', None)
    if original.get('aurum_backup_version', 0) < 11:
        # Format 11 added the optional gross-income/mandatory-tax
        # classification (see docs/tasks/income-tax-separation.md) to the
        # same three sections, same reasoning as format 10 above.
        for row in original.get('transactions', []):
            row.setdefault('assigned_period', None)
            row.setdefault('mandatory_payment_kind', None)
        for row in original.get('transaction_splits', []):
            row.setdefault('assigned_period', None)
            row.setdefault('mandatory_payment_kind', None)
        for row in original.get('recurring_transactions', []):
            row.setdefault('mandatory_payment_kind', None)
    # A supported older file is re-exported using the current format version.
    original = {key: value for key, value in original.items() if key not in ('exported_at', 'aurum_backup_version')}
    restored = {key: value for key, value in restored.items() if key not in ('exported_at', 'aurum_backup_version')}
    mismatches = []
    for key in original.keys() | restored.keys():
        o, r = original.get(key), restored.get(key)
        if key in LIST_SECTIONS and isinstance(o, list) and isinstance(r, list):
            # Order-insensitive: see _canonical_multiset above. Falls
            # through to the plain equality below for anything that isn't
            # actually a list on both sides (e.g. a malformed file), so
            # that mismatch is still caught, just not silently miscompared
            # as if it were orderable.
            if _canonical_multiset(o) != _canonical_multiset(r):
                mismatches.append(key)
        elif o != r:
            mismatches.append(key)
    if mismatches:
        raise RuntimeError('Restored data differs in: ' + ', '.join(sorted(mismatches)))


def main():
    os.umask(0o077)
    path, raw, original = latest_backup()
    project = 'aurum-restore-' + secrets.token_hex(6)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = os.environ.copy()
    env.update(AURUM_POSTGRES_USER='aurum_restore', AURUM_POSTGRES_PASSWORD=secrets.token_urlsafe(32),
               AURUM_POSTGRES_DB='aurum_restore', AURUM_WEB_PORT=str(port), AURUM_BIND_ADDRESS='127.0.0.1',
               AURUM_BASIC_AUTH_USER='', AURUM_BASIC_AUTH_PASSWORD='', AURUM_COINGECKO_API_KEY='',
               AURUM_ALLOWED_HOSTS='localhost 127.0.0.1', AURUM_DEFAULT_CURRENCY='PLN')
    command = ['docker', 'compose', '--env-file', '/dev/null', '-p', project]

    def compose(*args):
        subprocess.run([*command, *args], cwd=ROOT, env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    try:
        compose('up', '-d', '--build', '--wait', '--wait-timeout', '180')
        base = f'http://127.0.0.1:{port}/api'
        for _ in range(30):
            try:
                request(base + '/health')
                break
            except (URLError, RuntimeError):
                time.sleep(2)
        else:
            raise RuntimeError('Disposable restore app did not become healthy')
        result = json.loads(request(base + '/backup/import', raw))
        if result.get('status') != 'ok':
            raise RuntimeError('Disposable restore did not finish')
        compare(original, json.loads(request(base + '/backup/export')))
        print(json.dumps({'status': 'ok', 'backup': path.name,
                          'transactions': len(original['transactions']), 'project': project}))
    finally:
        compose('down', '-v', '--remove-orphans')


if __name__ == '__main__':
    main()
