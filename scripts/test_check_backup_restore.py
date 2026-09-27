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

    def test_latest_backup_accepts_current_v9_format(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            now = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)
            path = root / now.strftime('aurum-auto-%Y%m%dT%H%M%S%fZ.json')
            raw = json.dumps({'aurum_backup_version': 9, 'accounts': [{}], 'transactions': [{}]}).encode()
            path.write_bytes(raw)
            path.with_suffix('.sha256').write_text(hashlib.sha256(raw).hexdigest() + '  ' + path.name)
            with patch.object(check_backup_restore, 'BACKUPS', root):
                self.assertEqual(check_backup_restore.latest_backup(now)[1], raw)

    def test_latest_backup_accepts_current_v10_format(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            now = datetime(2026, 9, 27, 12, tzinfo=timezone.utc)
            path = root / now.strftime('aurum-auto-%Y%m%dT%H%M%S%fZ.json')
            raw = json.dumps({'aurum_backup_version': 10, 'accounts': [{}], 'transactions': [{}]}).encode()
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
                                      'crypto_currency': None, 'cash_flow_currency': None, 'reports_currency': None}}
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

    def test_compare_backfills_cash_flow_reports_currency_defaults_for_pre_v9_backups(self):
        # Same idea as the pre-v8 case above, one version later: a v8 backup
        # has the four earlier display-currency fields but not Cash Flow/
        # Reports' own two — restoring it into a v9-capable app must not
        # report a false mismatch for that alone.
        original = {'exported_at': 'a', 'aurum_backup_version': 8,
                    'accounts': [{'id': 1}], 'transactions': [{'id': 2}],
                    'app_settings': {'currency': 'USD', 'summary_currency': 'EUR',
                                      'dashboard_currency': None, 'net_worth_currency': 'PLN',
                                      'crypto_currency': None}}
        restored = {**original, 'exported_at': 'b', 'aurum_backup_version': 9,
                    'app_settings': {**original['app_settings'], 'cash_flow_currency': None, 'reports_currency': None}}
        check_backup_restore.compare(original, restored)
        restored_with_drift = {**restored, 'app_settings': {**restored['app_settings'], 'cash_flow_currency': 'PLN'}}
        with self.assertRaisesRegex(RuntimeError, 'app_settings'):
            check_backup_restore.compare(original, restored_with_drift)

    def test_compare_backfills_expense_asset_id_for_pre_v10_backups(self):
        # A backup exported before the property-expense link existed has no
        # expense_asset_id key on its transactions/splits/recurring rows at
        # all — restoring it into a v10-capable app must not report a false
        # mismatch just because the re-export now carries that key
        # defaulted to null on every row (docs/tasks/property-expense-links.md).
        original = {'exported_at': 'a', 'aurum_backup_version': 9,
                    'accounts': [{'id': 1}], 'transactions': [{'id': 2}],
                    'transaction_splits': [{'id': 3}], 'recurring_transactions': [{'id': 4}]}
        restored = {**original, 'exported_at': 'b', 'aurum_backup_version': 10,
                    'transactions': [{'id': 2, 'expense_asset_id': None}],
                    'transaction_splits': [{'id': 3, 'expense_asset_id': None}],
                    'recurring_transactions': [{'id': 4, 'expense_asset_id': None}]}
        check_backup_restore.compare(original, restored)
        # A genuine difference (a real link that failed to survive restore)
        # must still fail.
        restored_with_drift = {**restored, 'transactions': [{'id': 2, 'expense_asset_id': 7}]}
        with self.assertRaisesRegex(RuntimeError, 'transactions'):
            check_backup_restore.compare(original, restored_with_drift)

    def test_compare_treats_shuffled_records_as_equal(self):
        # A real production restore once reported a false mismatch this
        # way: every row's own fields matched exactly by id, but
        # build_backup() had no ORDER BY, so the two exports came back in
        # different physical order. Reordering alone must never fail this — across
        # several sections at once, including one financially meaningful
        # nullable field (expense_asset_id). aurum_backup_version is
        # current on both sides so none of the version-gated backfills
        # above apply here — this test is only about the shuffle itself.
        original = {
            'aurum_backup_version': 10,
            'accounts': [{'id': 1, 'name': 'A'}, {'id': 2, 'name': 'B'}, {'id': 3, 'name': 'C'}],
            'transactions': [
                {'id': 10, 'amount': '10.00', 'expense_asset_id': None},
                {'id': 11, 'amount': '20.00', 'expense_asset_id': 5},
                {'id': 12, 'amount': '30.00', 'expense_asset_id': None},
            ],
            'fx_rates': [{'base_currency': 'EUR', 'quote_currency': 'PLN', 'rate_date': '2025-01-01', 'rate': '4.1'},
                         {'base_currency': 'USD', 'quote_currency': 'PLN', 'rate_date': '2025-01-01', 'rate': '3.9'}],
        }
        restored = {
            'aurum_backup_version': 10,
            'accounts': [original['accounts'][2], original['accounts'][0], original['accounts'][1]],
            'transactions': [original['transactions'][1], original['transactions'][2], original['transactions'][0]],
            'fx_rates': list(reversed(original['fx_rates'])),
        }
        check_backup_restore.compare(original, restored)  # must not raise

    def test_compare_still_catches_a_lost_record_even_when_the_rest_is_shuffled(self):
        original = {'aurum_backup_version': 10, 'accounts': [{'id': 1}, {'id': 2}, {'id': 3}]}
        restored = {'aurum_backup_version': 10, 'accounts': [{'id': 3}, {'id': 1}]}  # id 2 silently missing
        with self.assertRaisesRegex(RuntimeError, 'accounts'):
            check_backup_restore.compare(original, restored)

    def test_compare_still_catches_a_duplicated_record_even_when_shuffled(self):
        # A real duplicate (same id inserted twice) must not be hidden by
        # treating the section as a set/dict keyed by id — see
        # _canonical_multiset's own docstring.
        original = {'aurum_backup_version': 10, 'transactions': [{'id': 1, 'amount': '5'}, {'id': 2, 'amount': '7'}]}
        restored = {'aurum_backup_version': 10, 'transactions': [
            {'id': 2, 'amount': '7'}, {'id': 1, 'amount': '5'}, {'id': 1, 'amount': '5'},
        ]}
        with self.assertRaisesRegex(RuntimeError, 'transactions'):
            check_backup_restore.compare(original, restored)

    def test_compare_still_catches_any_changed_field_even_when_shuffled(self):
        # Amount changed on row id 2, plus the two rows swapped position —
        # the reorder alone must not mask the real content difference.
        original = {'aurum_backup_version': 10, 'transactions': [{'id': 1, 'amount': '5'}, {'id': 2, 'amount': '7'}]}
        restored = {'aurum_backup_version': 10, 'transactions': [
            {'id': 2, 'amount': '7.01'}, {'id': 1, 'amount': '5'},
        ]}
        with self.assertRaisesRegex(RuntimeError, 'transactions'):
            check_backup_restore.compare(original, restored)

    def test_compare_still_catches_a_changed_nullable_expense_asset_id_even_when_shuffled(self):
        original = {'aurum_backup_version': 10, 'transaction_splits': [
            {'id': 1, 'expense_asset_id': None}, {'id': 2, 'expense_asset_id': 9},
        ]}
        restored = {'aurum_backup_version': 10, 'transaction_splits': [
            {'id': 2, 'expense_asset_id': 9}, {'id': 1, 'expense_asset_id': 99},
        ]}
        with self.assertRaisesRegex(RuntimeError, 'transaction_splits'):
            check_backup_restore.compare(original, restored)

    def test_compare_sorts_tag_ids_before_comparing_but_still_catches_a_real_difference(self):
        # A transaction's own tag set order was never a recorded fact (no
        # order_by on the many-to-many relationship — see
        # backup_service.py's build_backup) — only the set/multiset itself
        # matters.
        original = {'aurum_backup_version': 10, 'transactions': [{'id': 1, 'tag_ids': [3, 1, 2]}]}
        check_backup_restore.compare(
            original, {'aurum_backup_version': 10, 'transactions': [{'id': 1, 'tag_ids': [1, 2, 3]}]}
        )
        with self.assertRaisesRegex(RuntimeError, 'transactions'):
            check_backup_restore.compare(
                original, {'aurum_backup_version': 10, 'transactions': [{'id': 1, 'tag_ids': [1, 2]}]}
            )
        # A genuine duplicate tag id is not silently deduplicated away either.
        with self.assertRaisesRegex(RuntimeError, 'transactions'):
            check_backup_restore.compare(
                original, {'aurum_backup_version': 10, 'transactions': [{'id': 1, 'tag_ids': [1, 2, 3, 3]}]}
            )

    def test_compare_still_matches_v9_backups_verbatim(self):
        original = {'exported_at': 'a', 'aurum_backup_version': 9,
                    'accounts': [{'id': 1}], 'transactions': [{'id': 2}],
                    'app_settings': {'currency': 'USD', 'summary_currency': 'EUR',
                                      'dashboard_currency': None, 'net_worth_currency': 'PLN',
                                      'crypto_currency': None, 'cash_flow_currency': 'EUR', 'reports_currency': None}}
        check_backup_restore.compare(original, {**original, 'exported_at': 'b'})
        with self.assertRaisesRegex(RuntimeError, 'app_settings'):
            check_backup_restore.compare(original, {**original,
                'app_settings': {**original['app_settings'], 'reports_currency': 'USD'}})


if __name__ == '__main__':
    unittest.main()
