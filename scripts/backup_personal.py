"""Back up the authenticated personal Aurum to iCloud Drive, then prune old copies."""
import hashlib
import json
import os
import base64
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

DEST = Path.home() / 'Library/Mobile Documents/com~apple~CloudDocs/Aurum Backups'
CONFIG = Path(__file__).resolve().parents[1] / '.env.personal'
SOURCE = 'http://127.0.0.1:3101/api/backup/export'

def main():
    os.umask(0o077)
    settings = dict(line.split('=', 1) for line in CONFIG.read_text().splitlines()
                    if '=' in line and not line.lstrip().startswith('#'))
    username = settings['AURUM_BASIC_AUTH_USER']
    password = settings['AURUM_BASIC_AUTH_PASSWORD']
    if not username or not password:
        raise ValueError('Personal login is not configured; existing backups preserved')
    # An unprotected old test instance also answered on this port. Reject it before export.
    try:
        with urlopen(Request(SOURCE, headers={'Authorization': 'Basic invalid'}), timeout=15):
            pass
    except HTTPError as error:
        if error.code != 401:
            raise ValueError('Unexpected backup source response') from error
    else:
        raise ValueError('Backup source is not protected; existing backups preserved')
    credentials = base64.b64encode(f'{username}:{password}'.encode()).decode()
    with urlopen(Request(SOURCE, headers={'Authorization': 'Basic ' + credentials}), timeout=120) as response:
        raw = response.read()
    data = json.loads(raw)
    if data.get('aurum_backup_version') != 4:
        raise ValueError('Unexpected backup version; existing backups preserved')
    for key in ('accounts', 'categories', 'transactions', 'assets', 'asset_valuations',
                'crypto_holdings', 'crypto_transactions', 'fx_rates'):
        if not isinstance(data.get(key), list):
            raise ValueError(f'Missing backup section: {key}')
    if not data['accounts'] or not data['transactions']:
        raise ValueError('Unexpected empty financial history; existing backups preserved')
    now = datetime.now(timezone.utc)
    DEST.mkdir(parents=True, exist_ok=True)
    target = DEST / now.strftime('aurum-auto-%Y%m%dT%H%M%S%fZ.json')
    temporary = target.with_suffix('.partial')
    try:
        with temporary.open('xb') as file:
            file.write(raw)
            file.flush()
            os.fsync(file.fileno())
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    digest = hashlib.sha256(raw).hexdigest()
    if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        raise ValueError('Backup read-back failed; old backups preserved')
    target.with_suffix('.sha256').write_text(digest + '  ' + target.name + '\n')
    removed = 0
    for old in DEST.glob('aurum-auto-*.json'):
        if old.is_symlink():
            continue
        try:
            created = datetime.strptime(old.stem, 'aurum-auto-%Y%m%dT%H%M%S%fZ').replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if created < now - timedelta(days=30):
            old.unlink()
            old.with_suffix('.sha256').unlink(missing_ok=True)
            removed += 1
    print(json.dumps({'file': str(target), 'sha256': digest,
                      'transactions': len(data['transactions']), 'expired_removed': removed}))

if __name__ == '__main__':
    main()
