"""Offline coverage for the synthetic payload builders behind
verify_debt_backup_restore.py's own live-docker restore check (that live
check is run manually against a disposable stand, same as
check_backup_restore.py — see docs/tasks/debt-tracking.md)."""
import unittest
from decimal import Decimal

import verify_debt_backup_restore as verify


class LegacyPayloadTests(unittest.TestCase):
    def test_legacy_payload_has_no_debt_sections_at_all(self):
        payload = verify.build_legacy_payload()
        self.assertEqual(payload['aurum_backup_version'], 11)
        self.assertNotIn('debts', payload)
        self.assertNotIn('debt_repayments', payload)


class DebtPayloadTests(unittest.TestCase):
    def test_payload_ids_are_internally_consistent(self):
        payload = verify.build_debt_payload()
        account_ids = {a['id'] for a in payload['accounts']}
        transaction_ids = {t['id'] for t in payload['transactions']}
        debt_ids = {d['id'] for d in payload['debts']}
        repayment_ids = {r['id'] for r in payload['debt_repayments']}
        for t in payload['transactions']:
            self.assertIn(t['account_id'], account_ids)
        for d in payload['debts']:
            if d['issuance_transaction_id'] is not None:
                self.assertIn(d['issuance_transaction_id'], transaction_ids)
        for r in payload['debt_repayments']:
            self.assertIn(r['debt_id'], debt_ids)
            self.assertIn(r['transaction_id'], transaction_ids)
            if r['reverses_repayment_id'] is not None:
                self.assertIn(r['reverses_repayment_id'], repayment_ids)

    def test_opening_debt_is_fully_repaid_with_no_cash_movement_at_issuance(self):
        payload = verify.build_debt_payload()
        opening = next(d for d in payload['debts'] if d['id'] == 1)
        self.assertIsNone(opening['issuance_transaction_id'])
        repayment = next(r for r in payload['debt_repayments'] if r['debt_id'] == 1)
        self.assertEqual(Decimal(repayment['amount_debt_currency']), Decimal(opening['principal_amount']))

    def test_new_loan_liability_is_partially_repaid_then_reversed(self):
        payload = verify.build_debt_payload()
        loan = next(d for d in payload['debts'] if d['id'] == 2)
        self.assertIsNotNone(loan['issuance_transaction_id'])
        repayment = next(r for r in payload['debt_repayments'] if r['debt_id'] == 2 and r['kind'] == 'repayment')
        reversal = next(r for r in payload['debt_repayments'] if r['debt_id'] == 2 and r['kind'] == 'reversal')
        self.assertEqual(reversal['reverses_repayment_id'], repayment['id'])
        self.assertEqual(reversal['amount_debt_currency'], repayment['amount_debt_currency'])
        # Outstanding at the very end of this synthetic history is back to
        # the full principal — the partial repayment was undone.
        self.assertEqual(Decimal(loan['principal_amount']), Decimal('300.00'))


if __name__ == '__main__':
    unittest.main()
