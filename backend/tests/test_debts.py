"""Debt tracking: loan issuance both directions, opening-vs-new-loan cash
movement, partial/full repayment, reopen via reversal, retry/idempotency,
concurrent-repayment lock, multicurrency actual amounts, report exclusion,
capital invariants, generic-route bypass and backup roundtrip — see
docs/tasks/debt-tracking.md and app/services/debt_service.py."""
import asyncio
from decimal import Decimal

from app.core.clock import business_today


async def _account(client, currency="USD", **overrides):
    payload = dict(name=f"Synthetic {currency} account", currency=currency, type="checking")
    payload.update(overrides)
    resp = await client.post('/accounts', json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()['id']


def _key():
    import uuid
    return uuid.uuid4().hex


async def test_opening_debt_has_no_cash_movement_either_direction(client, account_id):
    today = str(business_today())
    balance_before = Decimal((await client.get('/accounts')).json()[0]['balance'])

    receivable = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='Synthetic friend', currency='USD', principal_amount='100',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))
    assert receivable.status_code == 201, receivable.text
    body = receivable.json()
    assert body['funding'] == 'opening_balance'
    assert body['account_id'] is None
    assert body['outstanding_amount'] == '100'
    assert body['status'] == 'active'

    liability = await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic bank', currency='USD', principal_amount='50',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))
    assert liability.status_code == 201, liability.text

    # No cash moved at all — the opening balance is a starting fact, not a
    # transaction.
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == balance_before
    transactions = (await client.get('/transactions')).json()['items']
    assert transactions == []

    # Capital = cash + assets + receivables - liabilities.
    summary = (await client.get('/net-worth/summary', params={'range': 'all'})).json()
    assert Decimal(summary['total_receivables']) == 100
    assert Decimal(summary['total_liabilities']) == 50
    assert Decimal(summary['current']) == balance_before + 100 - 50


async def test_new_loan_moves_cash_both_directions_atomically(client, account_id):
    today = str(business_today())
    balance_before = Decimal((await client.get('/accounts')).json()[0]['balance'])

    # I lend money out — cash leaves my account, a receivable appears.
    lend = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='Synthetic borrower', currency='USD', principal_amount='200',
        start_date=today, funding='new_loan', account_id=account_id, idempotency_key=_key(),
    ))
    assert lend.status_code == 201, lend.text
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == balance_before - 200
    # Same-currency issuance nets to zero net-worth change: cash -200, receivable +200.
    summary = (await client.get('/net-worth/summary', params={'range': 'all'})).json()
    assert Decimal(summary['current']) == balance_before

    # I borrow money in — cash enters my account, a liability appears.
    borrow = await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic lender', currency='USD', principal_amount='80',
        start_date=today, funding='new_loan', account_id=account_id, idempotency_key=_key(),
    ))
    assert borrow.status_code == 201, borrow.text
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == balance_before - 200 + 80
    summary = (await client.get('/net-worth/summary', params={'range': 'all'})).json()
    assert Decimal(summary['current']) == balance_before

    # The issuance shows up as a real Transaction (account history), but
    # never as ordinary income/expense/cash-flow.
    transactions = (await client.get('/transactions')).json()['items']
    assert len(transactions) == 2
    assert all(t['type'] in ('debt_in', 'debt_out') for t in transactions)
    cash_flow = (await client.get('/cash-flow')).json()
    assert Decimal(cash_flow['total_income']) == 0
    assert Decimal(cash_flow['total_expense']) == 0
    dashboard = (await client.get('/dashboard/summary')).json()
    assert Decimal(dashboard['real_income']) == 0
    assert Decimal(dashboard['spent']) == 0

    # Generic transaction routes cannot touch a debt-linked row.
    tx_id = transactions[0]['id']
    assert (await client.patch(f'/transactions/{tx_id}', json={'amount': '999'})).status_code == 409
    assert (await client.delete(f'/transactions/{tx_id}')).status_code == 409
    create_direct = await client.post('/transactions', json=dict(
        account_id=account_id, type='debt_in', amount='1', description='x', date=today,
    ))
    assert create_direct.status_code == 422


async def test_opening_balance_rejects_account_or_cash_amount(client, account_id):
    today = str(business_today())
    resp = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='X', currency='USD', principal_amount='10',
        start_date=today, funding='opening_balance', account_id=account_id, idempotency_key=_key(),
    ))
    assert resp.status_code == 422


async def test_new_loan_requires_account(client):
    today = str(business_today())
    resp = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='X', currency='USD', principal_amount='10',
        start_date=today, funding='new_loan', idempotency_key=_key(),
    ))
    assert resp.status_code == 422


async def test_partial_and_full_repayment_settle_the_debt(client, account_id):
    today = str(business_today())
    debt = (await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic bank', currency='USD', principal_amount='100',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))).json()

    partial = await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='40', idempotency_key=_key(),
    ))
    assert partial.status_code == 201, partial.text
    after_partial = (await client.get(f"/debts/{debt['id']}")).json()
    assert Decimal(after_partial['outstanding_amount']) == 60
    assert after_partial['status'] == 'active'

    full = await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='60', idempotency_key=_key(),
    ))
    assert full.status_code == 201, full.text
    settled = (await client.get(f"/debts/{debt['id']}")).json()
    assert Decimal(settled['outstanding_amount']) == 0
    assert settled['status'] == 'settled'

    overpay = await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='0.01', idempotency_key=_key(),
    ))
    assert overpay.status_code == 422


async def test_reopen_settled_debt_via_reversal(client, account_id):
    today = str(business_today())
    debt = (await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='Synthetic payer', currency='USD', principal_amount='100',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))).json()
    repayment = (await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='100', idempotency_key=_key(),
    ))).json()
    assert (await client.get(f"/debts/{debt['id']}")).json()['status'] == 'settled'

    reversed_resp = await client.post(
        f"/debts/{debt['id']}/repayments/{repayment['id']}/reverse",
        json=dict(account_id=account_id, date=today, idempotency_key=_key()),
    )
    assert reversed_resp.status_code == 201, reversed_resp.text
    reopened = (await client.get(f"/debts/{debt['id']}")).json()
    assert reopened['status'] == 'active'
    assert Decimal(reopened['outstanding_amount']) == 100

    repayments = (await client.get(f"/debts/{debt['id']}/repayments")).json()
    original = next(r for r in repayments if r['id'] == repayment['id'])
    assert original['is_reversed'] is True
    reversal_row = next(r for r in repayments if r['kind'] == 'reversal')
    assert reversal_row['reverses_repayment_id'] == repayment['id']

    # Cannot reverse the same repayment twice, and cannot reverse a reversal.
    dup = await client.post(
        f"/debts/{debt['id']}/repayments/{repayment['id']}/reverse",
        json=dict(account_id=account_id, date=today, idempotency_key=_key()),
    )
    assert dup.status_code == 409
    reverse_reversal = await client.post(
        f"/debts/{debt['id']}/repayments/{reversal_row['id']}/reverse",
        json=dict(account_id=account_id, date=today, idempotency_key=_key()),
    )
    assert reverse_reversal.status_code == 422


async def test_repayment_and_reversal_note_edit_never_touches_financial_state(client, account_id):
    """Regression for the reviewed bug: PATCHing a reversal's own note (or
    sending an empty body) must never run the overpay recheck at all — it
    used to falsely 422 whenever the reversed amount exceeded half of the
    debt's current outstanding."""
    today = str(business_today())
    debt = (await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic bank', currency='USD', principal_amount='100',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))).json()
    repayment = (await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='60', idempotency_key=_key(),
    ))).json()
    reversal = (await client.post(
        f"/debts/{debt['id']}/repayments/{repayment['id']}/reverse",
        json=dict(account_id=account_id, date=today, idempotency_key=_key()),
    )).json()
    assert Decimal((await client.get(f"/debts/{debt['id']}")).json()['outstanding_amount']) == 100

    note_edit = await client.patch(
        f"/debts/{debt['id']}/repayments/{reversal['id']}", json={'note': 'fixed a typo'}
    )
    assert note_edit.status_code == 200, note_edit.text
    assert note_edit.json()['note'] == 'fixed a typo'
    # Outstanding is untouched by the note-only edit.
    assert Decimal((await client.get(f"/debts/{debt['id']}")).json()['outstanding_amount']) == 100

    empty_patch = await client.patch(f"/debts/{debt['id']}/repayments/{reversal['id']}", json={})
    assert empty_patch.status_code == 200, empty_patch.text
    assert Decimal((await client.get(f"/debts/{debt['id']}")).json()['outstanding_amount']) == 100

    # Financial fields on either kind are immutable — explicit 409, not a
    # silent no-op and not a bogus overpay check.
    financial_edit = await client.patch(
        f"/debts/{debt['id']}/repayments/{repayment['id']}", json={'amount_debt_currency': '10'}
    )
    assert financial_edit.status_code == 409


async def test_deleting_a_reversal_that_would_overpay_is_rejected(client, account_id):
    """Regression for the reviewed bug: deleting a REVERSAL revives the
    repayment it undid — if newer repayments already used the room that
    reversal opened up, reviving the original must not silently drive
    outstanding negative."""
    today = str(business_today())
    debt = (await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic bank', currency='USD', principal_amount='100',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))).json()
    r1 = (await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='100', idempotency_key=_key(),
    ))).json()
    reversal = (await client.post(
        f"/debts/{debt['id']}/repayments/{r1['id']}/reverse",
        json=dict(account_id=account_id, date=today, idempotency_key=_key()),
    )).json()
    # Outstanding is back to 100 — use that room with a second repayment.
    r2 = (await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='100', idempotency_key=_key(),
    ))).json()
    assert Decimal((await client.get(f"/debts/{debt['id']}")).json()['outstanding_amount']) == 0

    # Deleting the reversal would revive r1 on top of r2 -> outstanding -100.
    blocked = await client.delete(f"/debts/{debt['id']}/repayments/{reversal['id']}")
    assert blocked.status_code == 422, blocked.text
    assert Decimal((await client.get(f"/debts/{debt['id']}")).json()['outstanding_amount']) == 0

    # Deleting r2 first frees the room; the reversal can now be deleted safely.
    assert (await client.delete(f"/debts/{debt['id']}/repayments/{r2['id']}")).status_code == 204
    assert (await client.delete(f"/debts/{debt['id']}/repayments/{reversal['id']}")).status_code == 204
    assert Decimal((await client.get(f"/debts/{debt['id']}")).json()['outstanding_amount']) == 0


async def test_delete_repayment_reverses_cash_and_delete_debt_requires_empty_history(client, account_id):
    today = str(business_today())
    balance_before = Decimal((await client.get('/accounts')).json()[0]['balance'])
    debt = (await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='Synthetic payer', currency='USD', principal_amount='30',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))).json()
    repayment = (await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='30', idempotency_key=_key(),
    ))).json()
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == balance_before + 30

    assert (await client.delete(f"/debts/{debt['id']}")).status_code == 409
    assert (await client.delete(f"/debts/{debt['id']}/repayments/{repayment['id']}")).status_code == 204
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == balance_before
    assert (await client.delete(f"/debts/{debt['id']}")).status_code == 204
    assert (await client.get(f"/debts/{debt['id']}")).status_code == 404


async def test_new_loan_terms_are_immutable_metadata_still_editable(client, account_id):
    today = str(business_today())
    debt = (await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic bank', currency='USD', principal_amount='100',
        start_date=today, funding='new_loan', account_id=account_id, idempotency_key=_key(),
    ))).json()
    locked = await client.patch(f"/debts/{debt['id']}", json={'principal_amount': '200'})
    assert locked.status_code == 409
    metadata = await client.patch(f"/debts/{debt['id']}", json={'note': 'called them', 'due_date': None})
    assert metadata.status_code == 200
    assert metadata.json()['note'] == 'called them'

    opening = (await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='Synthetic friend', currency='USD', principal_amount='50',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))).json()
    edited = await client.patch(f"/debts/{opening['id']}", json={'principal_amount': '55'})
    assert edited.status_code == 200, edited.text
    assert Decimal(edited.json()['outstanding_amount']) == 55
    await client.post(f"/debts/{opening['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='10', idempotency_key=_key(),
    ))
    now_locked = await client.patch(f"/debts/{opening['id']}", json={'principal_amount': '999'})
    assert now_locked.status_code == 409


async def test_retry_with_same_idempotency_key_does_not_double_post(client, account_id):
    today = str(business_today())
    key = _key()
    payload = dict(
        direction='owed_to_me', counterparty='Synthetic once', currency='USD', principal_amount='75',
        start_date=today, funding='new_loan', account_id=account_id, idempotency_key=key,
    )
    first = await client.post('/debts', json=payload)
    assert first.status_code == 201
    retry = await client.post('/debts', json=payload)
    assert retry.status_code == 201
    assert retry.json()['id'] == first.json()['id']
    assert len((await client.get('/transactions')).json()['items']) == 1

    different = await client.post('/debts', json={**payload, 'principal_amount': '76'})
    assert different.status_code == 409

    repay_key = _key()
    repay_payload = dict(account_id=account_id, date=today, amount_debt_currency='20', idempotency_key=repay_key)
    r1 = await client.post(f"/debts/{first.json()['id']}/repayments", json=repay_payload)
    assert r1.status_code == 201
    r2 = await client.post(f"/debts/{first.json()['id']}/repayments", json=repay_payload)
    assert r2.status_code == 201
    assert r2.json()['id'] == r1.json()['id']
    assert Decimal((await client.get(f"/debts/{first.json()['id']}")).json()['outstanding_amount']) == 55


async def test_concurrent_repayments_cannot_jointly_overpay(client, account_id):
    today = str(business_today())
    debt = (await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic bank', currency='USD', principal_amount='100',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))).json()

    async def repay(amount):
        return await client.post(f"/debts/{debt['id']}/repayments", json=dict(
            account_id=account_id, date=today, amount_debt_currency=amount, idempotency_key=_key(),
        ))

    results = await asyncio.gather(repay('60'), repay('60'))
    statuses = sorted(r.status_code for r in results)
    # The row lock serializes the two: exactly one succeeds, the other sees
    # the now-current (smaller) outstanding and is rejected — never both.
    assert statuses == [201, 422]
    final = (await client.get(f"/debts/{debt['id']}")).json()
    assert Decimal(final['outstanding_amount']) == 40
    assert Decimal(final['outstanding_amount']) >= 0


async def test_multicurrency_actual_amounts_are_explicit_never_fx_inferred(client):
    pln_account = await _account(client, currency='PLN')
    today = str(business_today())

    # Cross-currency issuance requires the explicit account-currency amount.
    missing = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='Synthetic USD friend', currency='USD', principal_amount='100',
        start_date=today, funding='new_loan', account_id=pln_account, idempotency_key=_key(),
    ))
    assert missing.status_code == 422

    debt = (await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='Synthetic USD friend', currency='USD', principal_amount='100',
        start_date=today, funding='new_loan', account_id=pln_account, issuance_account_amount='412.50',
        idempotency_key=_key(),
    ))).json()
    assert debt['issuance_account_amount'] == '412.50'
    assert debt['issuance_account_currency'] == 'PLN'
    assert debt['currency'] == 'USD'
    assert debt['principal_amount'] == '100'

    # Cross-currency repayment also requires an explicit account amount —
    # never derived from any stored/official FX rate.
    missing_repay = await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=pln_account, date=today, amount_debt_currency='40', idempotency_key=_key(),
    ))
    assert missing_repay.status_code == 422
    repay = await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=pln_account, date=today, amount_debt_currency='40', account_amount='165.00',
        idempotency_key=_key(),
    ))
    assert repay.status_code == 201, repay.text
    assert repay.json()['account_amount'] == '165.00'
    assert Decimal((await client.get(f"/debts/{debt['id']}")).json()['outstanding_amount']) == 60

    # Same-currency amounts must match exactly if both are sent.
    usd_account = await _account(client, currency='USD')
    mismatched = await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=usd_account, date=today, amount_debt_currency='10', account_amount='11', idempotency_key=_key(),
    ))
    assert mismatched.status_code == 422


async def test_debt_transactions_are_excluded_from_reports_but_visible_in_history(client, account_id):
    today = str(business_today())
    created = await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic lender', currency='USD', principal_amount='500',
        start_date=today, funding='new_loan', account_id=account_id, idempotency_key=_key(),
    ))
    assert created.status_code == 201

    dashboard = (await client.get('/dashboard/summary')).json()
    assert Decimal(dashboard['real_income']) == 0
    reports = await client.get('/reports/category-ranking', params={'kind': 'expense'})
    assert reports.status_code == 200
    assert Decimal(reports.json()['total_amount']) == 0
    assert reports.json()['items'] == []

    # But it IS visible in the account's own transaction history.
    account_history = (await client.get('/transactions', params={'account_id': account_id})).json()['items']
    assert any(t['type'] == 'debt_in' for t in account_history)


async def test_archived_and_missing_account_rejected(client, account_id):
    today = str(business_today())
    archive = await client.patch(f'/accounts/{account_id}', json={'is_archived': True})
    assert archive.status_code == 200
    resp = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='X', currency='USD', principal_amount='10',
        start_date=today, funding='new_loan', account_id=account_id, idempotency_key=_key(),
    ))
    assert resp.status_code == 422
    missing = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='X', currency='USD', principal_amount='10',
        start_date=today, funding='new_loan', account_id=999999, idempotency_key=_key(),
    ))
    assert missing.status_code == 422


async def test_invalid_zero_negative_and_future_dates_rejected(client, account_id):
    today = business_today()
    future = str(today.replace(year=today.year + 1))
    zero = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='X', currency='USD', principal_amount='0',
        start_date=str(today), funding='opening_balance', idempotency_key=_key(),
    ))
    assert zero.status_code == 422
    future_start = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='X', currency='USD', principal_amount='10',
        start_date=future, funding='opening_balance', idempotency_key=_key(),
    ))
    assert future_start.status_code == 422

    debt = (await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='X', currency='USD', principal_amount='10',
        start_date=str(today), funding='opening_balance', idempotency_key=_key(),
    ))).json()
    future_repay = await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date=future, amount_debt_currency='5', idempotency_key=_key(),
    ))
    assert future_repay.status_code == 422
    before_start = await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date='2000-01-01', amount_debt_currency='5', idempotency_key=_key(),
    ))
    assert before_start.status_code == 422


async def test_missing_fx_is_explicit_never_zero_or_one_to_one(client, account_id):
    created = await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='Synthetic EUR friend', currency='EUR', principal_amount='100',
        start_date='2020-01-01', funding='opening_balance', idempotency_key=_key(),
    ))
    assert created.status_code == 201
    resp = await client.get('/net-worth/summary', params={'range': 'all'})
    assert resp.status_code == 409
    assert resp.json()['detail']['code'] == 'FX_RATE_MISSING'


async def test_backup_roundtrip_with_opening_new_loan_repayment_and_reversal(client, account_id):
    today = str(business_today())
    opening = (await client.post('/debts', json=dict(
        direction='owed_to_me', counterparty='Synthetic friend', currency='USD', principal_amount='100',
        start_date=today, funding='opening_balance', idempotency_key=_key(),
    ))).json()
    assert opening['funding'] == 'opening_balance'
    loan = (await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic bank', currency='USD', principal_amount='300',
        start_date=today, funding='new_loan', account_id=account_id, idempotency_key=_key(),
    ))).json()
    repayment = (await client.post(f"/debts/{loan['id']}/repayments", json=dict(
        account_id=account_id, date=today, amount_debt_currency='50', idempotency_key=_key(),
    ))).json()
    await client.post(f"/debts/{loan['id']}/repayments/{repayment['id']}/reverse",
        json=dict(account_id=account_id, date=today, idempotency_key=_key()))

    backup = (await client.get('/backup/export')).json()
    assert backup['aurum_backup_version'] == 12
    assert len(backup['debts']) == 2
    assert len(backup['debt_repayments']) == 2
    assert (await client.post('/backup/import', json=backup)).status_code == 200
    reexported = (await client.get('/backup/export')).json()
    assert {k: v for k, v in reexported.items() if k != 'exported_at'} == \
        {k: v for k, v in backup.items() if k != 'exported_at'}

    from copy import deepcopy
    corrupt = deepcopy(backup)
    corrupt['debt_repayments'][1]['amount_debt_currency'] = '999.00'
    bad = await client.post('/backup/import', json=corrupt)
    assert bad.status_code == 422
    unchanged = (await client.get('/backup/export')).json()
    assert {k: v for k, v in unchanged.items() if k != 'exported_at'} == \
        {k: v for k, v in backup.items() if k != 'exported_at'}


async def test_backup_rejects_a_chronological_intermediate_overpay(client, account_id):
    """A hand-crafted backup whose FINAL aggregate outstanding looks fine
    but whose chronological reconstruction dips negative at some
    intermediate date must still be rejected (regression: the validator
    used to only sum the final tally, not replay history in order)."""
    debt = (await client.post('/debts', json=dict(
        direction='owed_by_me', counterparty='Synthetic bank', currency='USD', principal_amount='100',
        start_date='2025-01-01', funding='opening_balance', idempotency_key=_key(),
    ))).json()
    r1 = (await client.post(f"/debts/{debt['id']}/repayments", json=dict(
        account_id=account_id, date='2025-02-01', amount_debt_currency='100', idempotency_key=_key(),
    ))).json()

    backup = (await client.get('/backup/export')).json()
    from copy import deepcopy
    corrupt = deepcopy(backup)
    # Insert a second repayment dated BEFORE r1's own reversal, using room
    # that (in this doctored history) doesn't exist yet at that date.
    tx = next(t for t in corrupt['transactions'] if t['type'] == 'debt_out')
    new_tx_id = max(t['id'] for t in corrupt['transactions']) + 1
    corrupt['transactions'].append({**tx, 'id': new_tx_id, 'date': '2025-02-15', 'amount': '50.00',
                                     'description': 'Synthetic extra repayment'})
    new_repayment_id = max(r['id'] for r in corrupt['debt_repayments']) + 1
    corrupt['debt_repayments'].append({'id': new_repayment_id, 'debt_id': debt['id'], 'transaction_id': new_tx_id,
                                        'kind': 'repayment', 'reverses_repayment_id': None,
                                        'amount_debt_currency': '50', 'note': None, 'idempotency_key': None})
    # Reverse r1 even later, so the final tally (100 - 100 - 50 + 100 = 50)
    # looks non-negative even though 2025-02-15 alone was already -50.
    reversal_tx_id = new_tx_id + 1
    corrupt['transactions'].append({**tx, 'id': reversal_tx_id, 'type': 'debt_in', 'date': '2025-03-01',
                                     'description': 'Synthetic reversal'})
    corrupt['debt_repayments'].append({'id': new_repayment_id + 1, 'debt_id': debt['id'],
                                        'transaction_id': reversal_tx_id, 'kind': 'reversal',
                                        'reverses_repayment_id': r1['id'], 'amount_debt_currency': '100',
                                        'note': None, 'idempotency_key': None})
    bad = await client.post('/backup/import', json=corrupt)
    assert bad.status_code == 422, bad.text
    assert 'overpay' in bad.text.lower() or 'history' in bad.text.lower()
