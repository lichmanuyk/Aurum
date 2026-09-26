"""Offline coverage for the synthetic payload builder behind
verify_property_expense_backup_restore.py's own live-docker restore check
(that live check is run manually against a disposable stand, same as
check_backup_restore.py — see docs/tasks/property-expense-links.md)."""
import unittest

import verify_property_expense_backup_restore as verify


class LegacyPayloadTests(unittest.TestCase):
    def test_payload_is_a_genuine_pre_migration_format_with_no_expense_links(self):
        payload = verify.build_legacy_payload()
        self.assertEqual(payload['aurum_backup_version'], 9)
        for section in ('transactions', 'transaction_splits', 'recurring_transactions'):
            for row in payload[section]:
                self.assertNotIn('expense_asset_id', row,
                    f'{section} row unexpectedly carries expense_asset_id — not a genuine pre-format-10 shape')

    def test_payload_ids_are_internally_consistent(self):
        payload = verify.build_legacy_payload()
        account_ids = {a['id'] for a in payload['accounts']}
        category_ids = {c['id'] for c in payload['categories']}
        asset_ids = {a['id'] for a in payload['assets']}
        transaction_ids = {t['id'] for t in payload['transactions']}
        for t in payload['transactions']:
            self.assertIn(t['account_id'], account_ids)
            if t['category_id'] is not None:
                self.assertIn(t['category_id'], category_ids)
        for s in payload['transaction_splits']:
            self.assertIn(s['transaction_id'], transaction_ids)
            self.assertIn(s['category_id'], category_ids)
        for v in payload['asset_valuations']:
            self.assertIn(v['asset_id'], asset_ids)
        for r in payload['recurring_transactions']:
            self.assertIn(r['account_id'], account_ids)
        # A split's own line amounts must add up to its parent's — the same
        # invariant the live backend enforces (see money_service.py).
        split_total = sum(float(s['amount']) for s in payload['transaction_splits'])
        split_parent = next(t for t in payload['transactions'] if t['category_id'] is None)
        self.assertAlmostEqual(split_total, float(split_parent['amount']))


if __name__ == '__main__':
    unittest.main()
