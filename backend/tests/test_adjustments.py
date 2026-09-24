"""Signed balance adjustments and lossless sub-cent ledger writes."""
from datetime import date
from decimal import Decimal


def adjustment(account_id, amount='100.123456', **fields):
    return dict(account_id=account_id, type='adjustment', amount=amount,
                adjustment_reason='opening_balance', date=str(date.today()), description='Synthetic opening', **fields)


async def test_adjustments_change_balance_not_income_and_survive_restore(client, account_id):
    response = await client.post('/transactions', json=adjustment(account_id))
    assert response.status_code == 201, response.text
    ident = response.json()['id']
    assert Decimal(response.json()['amount']) == Decimal('100.123456')
    response = await client.post('/transactions', json=adjustment(account_id, '-0.003'))
    assert response.status_code == 201
    accounts = (await client.get('/accounts')).json()
    assert Decimal(next(a['balance'] for a in accounts if a['id'] == account_id)) == Decimal('100.120456')
    summary = await client.get('/dashboard/summary', params={'year':date.today().year, 'month':date.today().month})
    assert summary.status_code == 200, summary.text
    assert Decimal(summary.json()['real_income']) == Decimal(summary.json()['spent']) == 0
    cash = (await client.get('/cash-flow')).json()
    assert Decimal(cash['total_income']) == Decimal(cash['total_expense']) == 0
    capital = await client.get('/net-worth/summary')
    assert capital.status_code == 200, capital.text
    assert Decimal(capital.json()['current']) == Decimal('100.12')
    backup = (await client.get('/backup/export')).json()
    assert backup['aurum_backup_version'] == 4
    assert (await client.post('/backup/import', json=backup)).status_code == 200
    bad = await client.patch(f'/transactions/{ident}', json={'type':'income'})
    assert bad.status_code == 422
    edited = await client.patch(f'/transactions/{ident}', json={'amount':'-1.000001','adjustment_reason':'reconciliation'})
    assert edited.status_code == 200
    assert Decimal(edited.json()['amount']) == Decimal('-1.000001')


async def test_adjustment_invariants_and_bulk_atomicity(client, account_id, categories):
    for fields in [dict(adjustment_reason=None),dict(amount='0'),dict(category_id=categories['Groceries']['id']),
                   dict(reporting_amount_override='100',reporting_currency_override='USD',reporting_override_source='manual')]:
        payload = {**adjustment(account_id), **fields}
        assert (await client.post('/transactions',json=payload)).status_code == 422
    result = await client.post('/transactions/bulk',json={'items':[adjustment(account_id),{**adjustment(account_id),'amount':'0'}]})
    assert result.status_code == 422
    assert (await client.get('/transactions')).json()['total'] == 0
    for kind in ('income','expense','transfer'):
        assert (await client.post('/transactions',json={**adjustment(account_id), 'type':kind})).status_code == 422
    result = await client.post('/recurring',json={**adjustment(account_id),'frequency':'monthly','anchor_date':str(date.today())})
    assert result.status_code == 422


async def test_subcent_transfer_override_split_and_old_backup(client, account_id, categories):
    target = (await client.post('/accounts',json={'name':'Synthetic EUR','currency':'EUR'})).json()['id']
    income = dict(account_id=account_id,type='income',amount='1.000001',description='Synthetic precision',date=str(date.today()))
    assert (await client.post('/transactions',json=income)).status_code == 201
    moved = await client.post('/transactions',json={**income,'type':'transfer','amount':'1','transfer_account_id':target,'destination_amount':'0.923456'})
    assert moved.status_code == 201, moved.text
    assert Decimal(moved.json()['destination_amount']) == Decimal('0.923456')
    override = await client.post('/transactions',json={**income,'account_id':target,'amount':'10','reporting_amount_override':'11.123456','reporting_currency_override':'USD','reporting_override_source':'synthetic'})
    assert override.status_code == 201
    cash = (await client.get('/cash-flow')).json()
    assert Decimal(cash['total_income']) == Decimal('12.123457')  # identity and imported override preserve sub-cent facts
    parent = categories['Groceries']['id']
    split = await client.post('/transactions',json={**income,'type':'expense','amount':'0.003','splits':[{'category_id':parent,'amount':'0.001'},{'category_id':parent,'amount':'0.002'}]})
    assert split.status_code == 201, split.text
    assert (await client.post('/transactions',json={**income,'amount':'1.0000001'})).status_code == 422
    backup = (await client.get('/backup/export')).json()
    assert (await client.post('/backup/import',json=backup)).status_code == 200
    # Old v2 snapshots without adjustments are still readable.
    backup['aurum_backup_version'] = 2
    assert (await client.post('/backup/import',json=backup)).status_code == 200


async def test_backup_invalid_adjustment_rolls_back(client, account_id):
    assert (await client.post('/transactions',json=adjustment(account_id))).status_code == 201
    backup = (await client.get('/backup/export')).json()
    backup['transactions'][0]['adjustment_reason'] = 'unknown'
    assert (await client.post('/backup/import',json=backup)).status_code == 422
    assert (await client.get('/transactions')).json()['total'] == 1
