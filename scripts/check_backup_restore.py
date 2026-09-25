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
    if data.get('aurum_backup_version') not in (5, 6, 7) or not data.get('accounts') or not data.get('transactions'):
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
    # A supported older file is re-exported using the current format version.
    original = {key: value for key, value in original.items() if key not in ('exported_at', 'aurum_backup_version')}
    restored = {key: value for key, value in restored.items() if key not in ('exported_at', 'aurum_backup_version')}
    mismatches = [key for key in original.keys() | restored.keys() if original.get(key) != restored.get(key)]
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
