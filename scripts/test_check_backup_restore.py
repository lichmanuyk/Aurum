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

    def test_latest_backup_accepts_current_v8_format(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            now = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)
            path = root / now.strftime('aurum-auto-%Y%m%dT%H%M%S%fZ.json')
            raw = json.dumps({'aurum_backup_version': 8, 'accounts': [{}], 'transactions': [{}]}).encode()
            path.write_bytes(raw)
            path.with_suffix('.sha256').write_text(hashlib.sha256(raw).hexdigest() + '  ' + path.name)
            with patch.object(check_backup_restore, 'BACKUPS', root):
                self.assertEqual(check_backup_restore.latest_backup(now)[1], raw)

    def test_compare_checks_every_section_except_export_time(self):
        original = {'exported_at': 'a', 'aurum_backup_version': 6,
                    'accounts': [{'id': 1}], 'transactions': [{'id': 2}],
                    'goal_contributions': [{'id': 3}]}
        check_backup_restore.compare(original, {**original, 'exported_at': 'b',
            'aurum_backup_version': 7, 'goal_contributions': [{'id': 3, 'account_id': None}]})
        with self.assertRaisesRegex(RuntimeError, 'transactions'):
            check_backup_restore.compare(original, {**original, 'transactions': []})

    def test_compare_backfills_display_currency_defaults_for_pre_v8_backups(self):
        # A backup exported before the display-currency fields existed has
        # no summary_currency/dashboard_currency/net_worth_currency/
        # crypto_currency keys in app_settings at all — restoring it into a
        # v8-capable app must not report a false mismatch just because the
        # re-export now carries those keys defaulted to null.
        original = {'exported_at': 'a', 'aurum_backup_version': 7,
                    'accounts': [{'id': 1}], 'transactions': [{'id': 2}],
                    'app_settings': {'currency': 'USD'}}
        restored = {**original, 'exported_at': 'b', 'aurum_backup_version': 8,
                    'app_settings': {'currency': 'USD', 'summary_currency': None,
                                      'dashboard_currency': None, 'net_worth_currency': None,
                                      'crypto_currency': None}}
        check_backup_restore.compare(original, restored)
        # A genuine difference in a display-currency field must still fail.
        restored_with_drift = {**restored, 'app_settings': {**restored['app_settings'], 'summary_currency': 'USD'}}
        with self.assertRaisesRegex(RuntimeError, 'app_settings'):
            check_backup_restore.compare(original, restored_with_drift)

    def test_compare_still_matches_v8_backups_verbatim(self):
        original = {'exported_at': 'a', 'aurum_backup_version': 8,
                    'accounts': [{'id': 1}], 'transactions': [{'id': 2}],
                    'app_settings': {'currency': 'USD', 'summary_currency': 'EUR',
                                      'dashboard_currency': None, 'net_worth_currency': 'PLN',
                                      'crypto_currency': None}}
        check_backup_restore.compare(original, {**original, 'exported_at': 'b'})
        with self.assertRaisesRegex(RuntimeError, 'app_settings'):
            check_backup_restore.compare(original, {**original,
                'app_settings': {**original['app_settings'], 'summary_currency': 'USD'}})


if __name__ == '__main__':
    unittest.main()
