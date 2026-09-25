"""Guard freshness, integrity and full-data comparison for restore checks."""
import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import check_backup_restore


class RestoreCheckTests(unittest.TestCase):
    def test_latest_backup_requires_fresh_matching_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            now = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)
            path = root / now.strftime('aurum-auto-%Y%m%dT%H%M%S%fZ.json')
            raw = json.dumps({'aurum_backup_version': 5, 'accounts': [{}], 'transactions': [{}]}).encode()
            path.write_bytes(raw)
            path.with_suffix('.sha256').write_text(hashlib.sha256(raw).hexdigest() + '  ' + path.name)
            with patch.object(check_backup_restore, 'BACKUPS', root):
                self.assertEqual(check_backup_restore.latest_backup(now)[1], raw)
                with self.assertRaisesRegex(RuntimeError, 'not fresh'):
                    check_backup_restore.latest_backup(now + timedelta(days=3))
                path.write_bytes(raw + b' ')
                with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
                    check_backup_restore.latest_backup(now)

    def test_compare_checks_every_section_except_export_time(self):
        original = {'exported_at': 'a', 'aurum_backup_version': 5,
                    'accounts': [{'id': 1}], 'transactions': [{'id': 2}]}
        check_backup_restore.compare(original, {**original, 'exported_at': 'b', 'aurum_backup_version': 6})
        with self.assertRaisesRegex(RuntimeError, 'transactions'):
            check_backup_restore.compare(original, {**original, 'transactions': []})


if __name__ == '__main__':
    unittest.main()
