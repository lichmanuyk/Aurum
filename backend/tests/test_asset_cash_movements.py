"""A linked asset trade conserves cash and asset value without fake spending."""
from copy import deepcopy
from datetime import date, timedelta
from decimal import Decimal

from app.services import crypto_service
from tests.test_crypto import _fake_fetch, _point


async def test_manual_asset_purchase_revalue_sale_edit_delete_and_restore(client, account_id):
    today = date.today()
    yesterday = today - timedelta(days=1)
    before = today - timedelta(days=2)

    async def create(path, data):
        response = await client.post(path, json=data)
        assert response.status_code == 201, response.text
        return response.json()

    await create('/transactions', dict(account_id=account_id, type='adjustment', amount='1000',
                                       adjustment_reason='opening_balance', description='Opening', date=str(before)))
    asset = await create('/assets', dict(name='Synthetic investment', asset_class='investments',
                                         currency='USD', value='0', as_of_date=str(before)))

    def movement(kind, gross, value, day, key):
        return dict(asset_id=asset['id'], account_id=account_id, type=kind, gross_amount=gross,
                    fee_amount='0', asset_value_after=value, date=str(day), idempotency_key=key)

    purchase = await create('/asset-movements', movement('buy', '300', '300', yesterday, 'manual-buy-001'))
    repeated = await client.post('/asset-movements', json=movement('buy', '300', '300', yesterday, 'manual-buy-001'))
    assert repeated.status_code == 201 and repeated.json()['id'] == purchase['id']
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 700
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 1000
    assert Decimal((await client.get('/cash-flow')).json()['total_expense']) == 0

    valuation = await client.post(f"/assets/{asset['id']}/valuations", json=dict(value='360', as_of_date=str(today)))
    assert valuation.status_code == 200
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 1060
    sale = await create('/asset-movements', movement('sell', '350', '0', today, 'manual-sell-01'))
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 1050
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 1050
    dashboard = (await client.get('/dashboard/summary', params={'year': today.year, 'month': today.month})).json()
    assert Decimal(dashboard['real_income']) == Decimal(dashboard['spent']) == 0
    assert (await client.patch(f"/transactions/{sale['id']}", json={'amount': '999'})).status_code == 409
    assert (await client.delete(f"/transactions/{sale['id']}")).status_code == 409
    assert (await client.delete(f"/assets/{asset['id']}")).status_code == 409
    assert (await client.post(f"/assets/{asset['id']}/valuations", json=dict(value='10', as_of_date=str(today)))).status_code == 409
    assert (await client.delete(f"/asset-movements/{purchase['id']}")).status_code == 409

    changed = await client.put(f"/asset-movements/{sale['id']}", json=movement('sell', '340', '0', today, 'manual-sell-01'))
    assert changed.status_code == 200, changed.text
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 1040
    backup = (await client.get('/backup/export')).json()
    assert backup['aurum_backup_version'] == 7
    assert (await client.post('/backup/import', json=backup)).status_code == 200
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 1040
    bad = deepcopy(backup)
    linked = next(row for row in bad['transactions'] if row['id'] == sale['id'])
    linked['amount'] = '999'
    assert (await client.post('/backup/import', json=bad)).status_code == 422
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 1040
    assert (await client.delete(f"/asset-movements/{sale['id']}")).status_code == 204
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 700
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 1060


async def test_crypto_trade_moves_cash_and_coin_together(client, account_id, monkeypatch):
    monkeypatch.setattr(crypto_service, '_fetch_market_data', _fake_fetch({'bitcoin': _point('100')}))
    today = str(date.today())
    assert (await client.post('/transactions', json=dict(account_id=account_id, type='adjustment',
        amount='1000', adjustment_reason='opening_balance', description='Opening', date=today))).status_code == 201
    holding = (await client.post('/crypto/holdings', json=dict(coingecko_id='bitcoin', symbol='BTC',
        name='Bitcoin', quantity='1', date=today))).json()
    asset_id = holding['asset_id']

    def movement(kind, gross, key):
        return dict(asset_id=asset_id, account_id=account_id, type=kind, gross_amount=gross,
                    fee_amount='0', quantity='1', price_per_unit='100', date=today, idempotency_key=key)

    buy = await client.post('/asset-movements', json=movement('buy', '100', 'crypto-buy-001'))
    assert buy.status_code == 201, buy.text
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 900
    assert Decimal((await client.get('/crypto/holdings')).json()['holdings'][0]['quantity']) == 2
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 1100
    sale = await client.post('/asset-movements', json=movement('sell', '120', 'crypto-sell-01'))
    assert sale.status_code == 201, sale.text
    trade_id = sale.json()['id']
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 1020
    assert Decimal((await client.get('/crypto/holdings')).json()['holdings'][0]['quantity']) == 1
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 1120
    linked_crypto_id = next(t for t in (await client.get('/backup/export')).json()['transactions'] if t['id'] == trade_id)['crypto_transaction_id']
    assert (await client.delete(f'/crypto/transactions/{linked_crypto_id}')).status_code == 409
    assert (await client.delete(f'/asset-movements/{trade_id}')).status_code == 204
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 900
    assert Decimal((await client.get('/crypto/holdings')).json()['holdings'][0]['quantity']) == 2


async def test_two_manual_asset_trades_on_one_day_restore_and_delete_in_reverse_order(client, account_id):
    yesterday, today = str(date.today() - timedelta(days=1)), str(date.today())
    assert (await client.post('/transactions', json=dict(account_id=account_id, type='adjustment',
        amount='1000', adjustment_reason='opening_balance', description='Opening', date=yesterday))).status_code == 201
    asset = (await client.post('/assets', json=dict(name='Two trades', asset_class='investments',
        currency='USD', value='0', as_of_date=yesterday))).json()

    def trade(gross, value, key):
        return dict(asset_id=asset['id'], account_id=account_id, type='buy', gross_amount=gross,
                    fee_amount='0', asset_value_after=value, date=today, idempotency_key=key)

    first = await client.post('/asset-movements', json=trade('300', '300', 'same-day-first'))
    second = await client.post('/asset-movements', json=trade('200', '500', 'same-day-second'))
    assert first.status_code == second.status_code == 201, (first.text, second.text)
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 500
    assert Decimal((await client.get('/assets')).json()[0]['current_value']) == 500
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 1000
    assert (await client.delete(f"/asset-movements/{first.json()['id']}")).status_code == 409

    backup = (await client.get('/backup/export')).json()
    assert len([row for row in backup['asset_valuations'] if row['asset_id'] == asset['id'] and row['as_of_date'] == today]) == 2
    assert (await client.post('/backup/import', json=backup)).status_code == 200
    assert Decimal((await client.get('/assets')).json()[0]['current_value']) == 500
    assert (await client.delete(f"/asset-movements/{second.json()['id']}")).status_code == 204
    assert Decimal((await client.get('/assets')).json()[0]['current_value']) == 300
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 700
    assert (await client.delete(f"/asset-movements/{first.json()['id']}")).status_code == 204
    assert Decimal((await client.get('/assets')).json()[0]['current_value']) == 0
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 1000


async def test_fees_affect_cash_once_and_not_income_or_spending(client, account_id):
    yesterday = str(date.today() - timedelta(days=1))
    today = str(date.today())
    assert (await client.post('/transactions', json=dict(account_id=account_id, type='adjustment',
        amount='1000', adjustment_reason='opening_balance', description='Opening', date=yesterday))).status_code == 201
    asset = (await client.post('/assets', json=dict(name='Fee test', asset_class='investments',
        currency='USD', value='0', as_of_date=yesterday))).json()

    def movement(kind, gross, fee, value, day, key):
        return dict(asset_id=asset['id'], account_id=account_id, type=kind, gross_amount=gross,
                    fee_amount=fee, asset_value_after=value, date=day, idempotency_key=key)

    buy = await client.post('/asset-movements', json=movement('buy', '300', '2', '300', yesterday, 'fee-buy-0001'))
    assert buy.status_code == 201, buy.text
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 698
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 998
    bad = await client.post('/asset-movements', json=movement('sell', '350', '350', '0', today, 'fee-bad-0001'))
    assert bad.status_code == 422
    sell = await client.post('/asset-movements', json=movement('sell', '350', '5', '0', today, 'fee-sell-0001'))
    assert sell.status_code == 201, sell.text
    assert Decimal((await client.get('/accounts')).json()[0]['balance']) == 1043
    assert Decimal((await client.get('/net-worth/summary')).json()['current']) == 1043
    flow = (await client.get('/cash-flow')).json()
    assert Decimal(flow['total_income']) == Decimal(flow['total_expense']) == 0
